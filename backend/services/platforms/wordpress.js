import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Deploys content to a WordPress site via the REST API.
 * Uses Basic Auth (via WP-API Basic Auth plugin or Application Passwords).
 *
 * Lookup priority:
 *  1. sourceUrl slug  — match page/post by its URL slug (most reliable)
 *  2. payload.targetId — explicit ID if provided
 *  3. Title search    — last resort, fuzzy match
 *
 * @param {Object} payload     - The content payload to deploy
 * @param {Object} integration - The integration DB record
 */
export async function deployToWordPress(payload, integration) {
  let siteUrl = process.env.WORDPRESS_SITE_URL || integration.account_name;
  siteUrl = siteUrl.replace(/\/$/, '').replace(/\/wp-admin$/, '');

  const username = process.env.WORDPRESS_USERNAME || integration.account_id;
  const password = process.env.WORDPRESS_PASSWORD || integration.access_token;

  if (!siteUrl || !username || !password) {
    throw new Error('Incomplete WordPress credentials. Ensure URL, Username, and Application Password are provided.');
  }

  if (!siteUrl.startsWith('http://') && !siteUrl.startsWith('https://')) {
    siteUrl = `https://${siteUrl}`;
  }

  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const axiosConfig = {
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    timeout: 15000,
  };

  try {
    // ── 0. Determine API route prefix ────────────────────────────
    let restPrefix = '/wp-json';
    try {
      await axios.get(`${siteUrl}/wp-json/`, { headers: { Accept: 'application/json' } });
    } catch (e) {
      if (e.response && e.response.status === 404) {
        restPrefix = '/?rest_route=';
      }
    }

    const buildUrl = (path, params) => {
      let u = siteUrl + (restPrefix === '/wp-json' ? `/wp-json${path}` : `/?rest_route=${path}`);
      if (params) u += (restPrefix === '/wp-json' ? '?' : '&') + params;
      return u;
    };

    console.log(`[WordPress] Deploying "${payload.title}" to ${siteUrl} (prefix: ${restPrefix})`);
    console.log(`[WordPress] sourceUrl: ${payload.sourceUrl} | location: ${payload.location}`);

    // ── 1. Find the target page/post ─────────────────────────────
    // Strategy: slug-based lookup first (most accurate), then ID fallback, then title search.
    let targetObj = null;
    let objType   = 'pages';

    // Extract slug from sourceUrl (e.g. https://site.com/services/ → "services")
    const sourceUrl = payload.sourceUrl || '';
    let targetSlug = '';
    try {
      const u = new URL(sourceUrl);
      // Remove the site base path prefix if present
      const basePath = new URL(siteUrl).pathname.replace(/\/$/, '');
      const fullPath = u.pathname.replace(/\/$/, '');
      const relPath  = fullPath.startsWith(basePath)
        ? fullPath.slice(basePath.length)
        : fullPath;
      targetSlug = relPath.replace(/^\//, '').replace(/\/$/, '');
    } catch (_) {}

    // Strategy A: slug lookup via ?slug= parameter
    if (targetSlug && targetSlug !== '') {
      console.log(`[WordPress] Strategy A: slug lookup for "${targetSlug}"`);

      // Try pages by slug
      const pagesBySlug = await axios.get(
        buildUrl('/wp/v2/pages', `slug=${encodeURIComponent(targetSlug)}&_fields=id,title,content,link,status`),
        axiosConfig
      ).catch(() => ({ data: [] }));

      if (pagesBySlug.data.length > 0) {
        targetObj = pagesBySlug.data[0];
        objType   = 'pages';
        console.log(`[WordPress] Found page by slug: [${targetObj.id}] "${targetObj.title?.rendered}" → ${targetObj.link}`);
      }

      // Try posts by slug if not found in pages
      if (!targetObj) {
        const postsBySlug = await axios.get(
          buildUrl('/wp/v2/posts', `slug=${encodeURIComponent(targetSlug)}&_fields=id,title,content,link,status`),
          axiosConfig
        ).catch(() => ({ data: [] }));

        if (postsBySlug.data.length > 0) {
          targetObj = postsBySlug.data[0];
          objType   = 'posts';
          console.log(`[WordPress] Found post by slug: [${targetObj.id}] "${targetObj.title?.rendered}" → ${targetObj.link}`);
        }
      }
    }
    // Strategy A2: If slug lookup failed or skipped, match by exact link (sourceUrl)
    if (!targetObj && sourceUrl) {
      console.log(`[WordPress] Strategy A2: matching exact link for "${sourceUrl}"`);
      const normalizeUrl = (u) => (u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      const normSourceUrl = normalizeUrl(sourceUrl);
      
      const allPages = await axios.get(
        buildUrl('/wp/v2/pages', 'per_page=100&_fields=id,title,link,status'),
        axiosConfig
      ).catch((err) => { console.log('[WordPress] Strategy A2 fetch failed:', err.message); return { data: [] }; });

      const matchedPage = allPages.data.find(p => normalizeUrl(p.link) === normSourceUrl);
      if (matchedPage) {
        targetObj = matchedPage;
        objType = 'pages';
        console.log(`[WordPress] Found page by exact link match: [${targetObj.id}] "${targetObj.title?.rendered}" → ${targetObj.link}`);
      }
    }

    // Strategy B: explicit targetId
    if (!targetObj && payload.targetId) {
      console.log(`[WordPress] Strategy B: explicit targetId ${payload.targetId}`);
      // Try as page first
      const byIdPage = await axios.get(
        buildUrl(`/wp/v2/pages/${payload.targetId}`, '_fields=id,title,content,link,status'),
        axiosConfig
      ).catch(() => ({ data: null }));
      if (byIdPage.data?.id) {
        targetObj = byIdPage.data;
        objType   = 'pages';
      } else {
        const byIdPost = await axios.get(
          buildUrl(`/wp/v2/posts/${payload.targetId}`, '_fields=id,title,content,link,status'),
          axiosConfig
        ).catch(() => ({ data: null }));
        if (byIdPost.data?.id) {
          targetObj = byIdPost.data;
          objType   = 'posts';
        }
      }
    }

    // Strategy C: title search fallback (last resort)
    if (!targetObj) {
      const searchQuery = payload.location || payload.title || '';
      console.log(`[WordPress] Strategy C: title search for "${searchQuery}"`);

      const pageSearch = await axios.get(
        buildUrl('/wp/v2/pages', `search=${encodeURIComponent(searchQuery)}&_fields=id,title,content,link,status`),
        axiosConfig
      ).catch(() => ({ data: [] }));

      if (pageSearch.data.length > 0) {
        // Pick the best match: prefer exact title match, else first result
        const exactMatch = pageSearch.data.find(p =>
          (p.title?.rendered || '').toLowerCase() === searchQuery.toLowerCase()
        );
        targetObj = exactMatch || pageSearch.data[0];
        objType   = 'pages';
        console.log(`[WordPress] Found by title search (page): [${targetObj.id}] "${targetObj.title?.rendered}"`);
      }

      if (!targetObj) {
        const postSearch = await axios.get(
          buildUrl('/wp/v2/posts', `search=${encodeURIComponent(searchQuery)}&_fields=id,title,content,link,status`),
          axiosConfig
        ).catch(() => ({ data: [] }));

        if (postSearch.data.length > 0) {
          const exactMatch = postSearch.data.find(p =>
            (p.title?.rendered || '').toLowerCase() === searchQuery.toLowerCase()
          );
          targetObj = exactMatch || postSearch.data[0];
          objType   = 'posts';
          console.log(`[WordPress] Found by title search (post): [${targetObj.id}] "${targetObj.title?.rendered}"`);
        }
      }
    }

    // ── 2. Determine endpoint ─────────────────────────────────────
    let endpoint = buildUrl(`/wp/v2/${objType}`);
    let method   = 'POST'; // create new if no match

    if (targetObj) {
      endpoint = buildUrl(`/wp/v2/${objType}/${targetObj.id}`);
      method   = 'POST'; // WordPress REST API uses POST for updates too
      console.log(`[WordPress] Will UPDATE ${objType} [${targetObj.id}] at ${endpoint}`);
    } else {
      console.log(`[WordPress] No existing page/post found — will CREATE a new post at ${endpoint}`);
    }

    // ── 3. Backup original content for rollback ───────────────────
    let originalContent = '';
    if (targetObj?.content) {
      originalContent = targetObj.content.raw || targetObj.content.rendered || '';
    }

    // ── 4. Deploy ─────────────────────────────────────────────────
    const proposedText = payload.proposedChange || payload.content || '';

    let elementorUpdated = false;
    let elementorMessage = '';

    // If updating an existing post, try the Elementor Deployer companion plugin first
    if (targetObj) {
      try {
        const elementorPayload = {
          search_text: payload.currentState || '',
          replace_text: proposedText
        };
        console.log(`[WordPress] Sending to Elementor Plugin -> Search: "${elementorPayload.search_text}", Replace: "${elementorPayload.replace_text}"`);
        const elemRes = await axios.post(
          buildUrl(`/clicktrends/v1/update-elementor/${targetObj.id}`),
          elementorPayload,
          axiosConfig
        );
        if (elemRes.data && elemRes.data.success) {
          elementorUpdated = true;
          elementorMessage = elemRes.data.message;
          console.log(`[WordPress] Elementor updated successfully: ${elementorMessage}`);
        }
      } catch (elemErr) {
        // 404 means plugin not installed. 400 means not an Elementor page.
        console.log(`[WordPress] Elementor update bypassed: ${elemErr.response?.data?.message || elemErr.message}`);
      }
    }

    // Always push to the native WP content field as well
    const deployRes = await axios({
      method,
      url: endpoint,
      headers: axiosConfig.headers,
      data: {
        title:   targetObj ? undefined : payload.title, // don't override title on updates
        content: proposedText,
        status:  'publish',
      }
    });

    const updatedObject = deployRes.data;
    const liveUrl       = updatedObject.link;

    console.log(`[WordPress] Deployed successfully → ${liveUrl} (ID: ${updatedObject.id})`);

    // ── 5. Verify live page ───────────────────────────────────────
    let verified = false;
    let liveHtml = '';
    try {
      if (liveUrl && updatedObject.status !== 'draft') {
        const livePageRes = await axios.get(liveUrl, { timeout: 10000 });
        liveHtml = livePageRes.data;

        const $ = cheerio.load(liveHtml);
        const pageText = $('body').text().replace(/\s+/g, ' ');
        const strippedProposed = cheerio.load(proposedText).text().replace(/\s+/g, ' ');

        if (pageText.includes(strippedProposed.slice(0, 100)) || liveHtml.includes(proposedText.slice(0, 100))) {
          verified = true;
        }
      }
    } catch (vErr) {
      console.warn('[WordPress] Verification failed to fetch live URL:', vErr.message);
    }

    return {
      success:              true,
      api_response:         'Successfully pushed to WordPress API',
      timestamp:            new Date().toISOString(),
      platform_resource_id: updatedObject.id.toString(),
      live_url:             liveUrl,
      targetTitle:          updatedObject.title?.rendered || payload.title,

      previous_content: {
        title:    targetObj ? (targetObj.title?.rendered || payload.title) : payload.title,
        content:  originalContent,
        targetId: updatedObject.id,
      },

      response_payload: {
        verified,
        elementorUpdated,
        platform_resource_id: updatedObject.id.toString(),
        live_url:             liveUrl,
        timestamp:            new Date().toISOString(),
        targetTitle:          updatedObject.title?.rendered || payload.title,
        contentSent:          proposedText,
        htmlFetched:          !!liveHtml,
        matchStrategy:        targetObj
          ? (targetSlug ? 'slug' : payload.targetId ? 'id' : 'title-search')
          : 'created-new',
      }
    };

  } catch (error) {
    let errorMessage = error.message;
    if (error.response) {
      const respData = error.response.data || {};
      if (error.response.status === 401 || error.response.status === 403) {
        errorMessage = `WordPress API Error: ${error.response.status} - Authentication failed (${respData.code || 'unknown'}). ` +
          `Ensure the WP-API Basic Auth plugin is active, or that your Application Password is correct and the hosting provider allows Basic Auth headers.`;
      } else {
        errorMessage = `WordPress API Error: ${error.response.status} - ${JSON.stringify(respData)}`;
      }
    }
    throw new Error(errorMessage);
  }
}
