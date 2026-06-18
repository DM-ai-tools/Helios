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
    let actualMatchStrategy = 'created-new';

    // Extract slug from payload.slug or sourceUrl
    const sourceUrl = payload.sourceUrl || '';
    let targetSlug = payload.slug || '';
    if (!targetSlug && sourceUrl) {
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
    }

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
        actualMatchStrategy = 'slug';
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
          actualMatchStrategy = 'slug';
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
        actualMatchStrategy = 'exact-link';
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
        actualMatchStrategy = 'id';
      } else {
        const byIdPost = await axios.get(
          buildUrl(`/wp/v2/posts/${payload.targetId}`, '_fields=id,title,content,link,status'),
          axiosConfig
        ).catch(() => ({ data: null }));
        if (byIdPost.data?.id) {
          targetObj = byIdPost.data;
          objType   = 'posts';
          actualMatchStrategy = 'id';
        }
      }
    }

    // Strategy C: title search fallback (last resort)
    if (!targetObj) {
      const searchQuery = (payload.location || payload.title || '').trim();
      if (searchQuery !== '') {
        console.log(`[WordPress] Strategy C: title search for "${searchQuery}"`);

        const pageSearch = await axios.get(
          buildUrl('/wp/v2/pages', `search=${encodeURIComponent(searchQuery)}&_fields=id,title,content,link,status`),
          axiosConfig
        ).catch(() => ({ data: [] }));

        if (pageSearch.data.length > 0) {
          const match = pageSearch.data.find(p =>
            (p.title?.rendered || '').toLowerCase() === searchQuery.toLowerCase() ||
            (p.title?.rendered || '').toLowerCase().includes(searchQuery.toLowerCase())
          );
          if (match) {
            targetObj = match;
            objType   = 'pages';
            actualMatchStrategy = 'title-search';
            console.log(`[WordPress] Found by title search (page): [${targetObj.id}] "${targetObj.title?.rendered}"`);
          }
        }

        if (!targetObj) {
          const postSearch = await axios.get(
            buildUrl('/wp/v2/posts', `search=${encodeURIComponent(searchQuery)}&_fields=id,title,content,link,status`),
            axiosConfig
          ).catch(() => ({ data: [] }));

          if (postSearch.data.length > 0) {
            const match = postSearch.data.find(p =>
              (p.title?.rendered || '').toLowerCase() === searchQuery.toLowerCase() ||
              (p.title?.rendered || '').toLowerCase().includes(searchQuery.toLowerCase())
            );
            if (match) {
              targetObj = match;
              objType   = 'posts';
              actualMatchStrategy = 'title-search';
              console.log(`[WordPress] Found by title search (post): [${targetObj.id}] "${targetObj.title?.rendered}"`);
            }
          }
        }
      } else {
        console.log(`[WordPress] Strategy C: skipped because search query is empty.`);
      }
    }

    // ── 1.5. Resolve parent page ID if navigationParent is specified ────
    let parentId = undefined;
    if (objType === 'pages' && payload.navigationParent) {
      const parentName = payload.navigationParent.trim();
      console.log(`[WordPress] Resolving parent page ID for name: "${parentName}"`);
      try {
        const parentSlug = parentName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const parentSlugRes = await axios.get(
          buildUrl('/wp/v2/pages', `slug=${encodeURIComponent(parentSlug)}&_fields=id,title,slug`),
          axiosConfig
        ).catch(() => ({ data: [] }));

        if (parentSlugRes.data && parentSlugRes.data.length > 0) {
          parentId = parentSlugRes.data[0].id;
          console.log(`[WordPress] Found parent page ID ${parentId} via slug match "${parentSlug}"`);
        } else {
          const parentSearchRes = await axios.get(
            buildUrl('/wp/v2/pages', `search=${encodeURIComponent(parentName)}&_fields=id,title,slug`),
            axiosConfig
          ).catch(() => ({ data: [] }));

          const matchedParent = parentSearchRes.data.find(p =>
            (p.title?.rendered || '').toLowerCase() === parentName.toLowerCase()
          );
          if (matchedParent) {
            parentId = matchedParent.id;
            console.log(`[WordPress] Found parent page ID ${parentId} via exact title match "${parentName}"`);
          } else if (parentSearchRes.data.length > 0) {
            parentId = parentSearchRes.data[0].id;
            console.log(`[WordPress] Found parent page ID ${parentId} via search fallback`);
          }
        }
      } catch (parentErr) {
        console.warn(`[WordPress] Failed to resolve parent page "${parentName}":`, parentErr.message);
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
    let proposedText = payload.html || payload.proposedChange || payload.content || '';
    proposedText = encode4ByteCharsToEntities(proposedText);
    const finalTitle = encode4ByteCharsToEntities(payload.pageTitle || payload.title || 'Untitled Page');

    const isMetadata = payload.changeType === 'metadata';
    const isTitle = isMetadata && (
      (payload.description && payload.description.toLowerCase().includes('title')) ||
      (payload.title && payload.title.toLowerCase().includes('title')) ||
      (payload.currentState && payload.currentState.toLowerCase().includes('title')) ||
      (payload.currentState && payload.currentState.toLowerCase().includes('theme'))
    );

    let elementorUpdated = false;
    let elementorMessage = '';
    let updatedObject = targetObj;

    if (isMetadata) {
      console.log(`[WordPress] Deploying metadata change: "${proposedText}" (isTitle: ${isTitle})`);
      
      const isHomepage = !targetSlug || targetSlug === '' || (targetObj && targetObj.link.replace(/\/$/, '') === siteUrl.replace(/\/$/, ''));

      if (isTitle) {
        if (isHomepage) {
          console.log(`[WordPress] Homepage title change detected. Updating global Site Title & Tagline settings...`);
          let newTitle = proposedText;
          let newDescription = '';
          
          // Split title by common separators: | , – , -
          const separators = ['|', '–', '-'];
          for (const sep of separators) {
            if (proposedText.includes(sep)) {
              const idx = proposedText.indexOf(sep);
              newTitle = proposedText.slice(0, idx).trim();
              newDescription = proposedText.slice(idx + 1).trim();
              break;
            }
          }
          
          try {
            await axios.post(buildUrl('/wp/v2/settings'), {
              title: newTitle,
              description: newDescription
            }, axiosConfig);
            console.log(`[WordPress] Settings updated successfully. Title: "${newTitle}", Description: "${newDescription}"`);
          } catch (settingsErr) {
            console.warn('[WordPress] Global settings update failed:', settingsErr.response?.data || settingsErr.message);
          }
        }

        // Also update the target page post title natively
        if (targetObj) {
          console.log(`[WordPress] Updating native page title to: "${proposedText}"`);
          const pageRes = await axios.post(endpoint, {
            title: proposedText,
            status: 'publish',
            meta: {
              _yoast_wpseo_title: proposedText
            }
          }, axiosConfig);
          updatedObject = pageRes.data;
        }
      } else {
        // Meta description change
        if (targetObj) {
          console.log(`[WordPress] Meta description change. Updating post meta...`);
          const pageRes = await axios.post(endpoint, {
            status: 'publish',
            meta: {
              _yoast_wpseo_metadesc: proposedText
            }
          }, axiosConfig);
          updatedObject = pageRes.data;
        }
      }
    } else {
      // Standard content change - try Elementor update first
      const actionType = payload.actionType || 'replace';

      if (targetObj && actionType !== 'create_page') {
        let alignedSearchText = payload.currentState || '';
        const liveUrl = targetObj.link;
        if (liveUrl && alignedSearchText) {
          try {
            console.log(`[WordPress] Pre-fetching page HTML to align search text: "${alignedSearchText}"`);
            const livePageRes = await axios.get(liveUrl, { timeout: 10000 });
            const liveHtml = livePageRes.data;
            const closest = findClosestTextMatch(liveHtml, alignedSearchText);
            if (closest && closest !== alignedSearchText) {
              console.log(`[WordPress] Dynamic Search Alignment: Mapped "${alignedSearchText}" -> "${closest}"`);
              alignedSearchText = closest;
            }
          } catch (htmlErr) {
            console.warn('[WordPress] Failed to fetch live HTML for alignment fallback:', htmlErr.message);
          }
        }

        try {
          let finalReplaceText = proposedText;
          if (actionType === 'insert_after') {
            finalReplaceText = alignedSearchText + "\n" + proposedText;
          } else if (actionType === 'insert_before') {
            finalReplaceText = proposedText + "\n" + alignedSearchText;
          }

          const elementorPayload = {
            search_text: alignedSearchText,
            replace_text: finalReplaceText
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

      // Wrap HTML in Gutenberg block to prevent wpautop corruption and styling conflicts
      const gutenbergWrappedContent = `<!-- wp:html -->\n${proposedText}\n<!-- /wp:html -->`;

      let finalContent = gutenbergWrappedContent;
      if (targetObj && actionType !== 'create_page') {
        const origContent = targetObj.content?.raw || targetObj.content?.rendered || '';
        const search = payload.currentState || '';
        if (origContent && search) {
          if (actionType === 'replace') {
            finalContent = origContent.replace(search, gutenbergWrappedContent);
          } else if (actionType === 'insert_after') {
            finalContent = origContent.replace(search, search + '\n' + gutenbergWrappedContent);
          } else if (actionType === 'insert_before') {
            finalContent = origContent.replace(search, gutenbergWrappedContent + '\n' + search);
          }
          // If search text wasn't found in native content, just append it safely instead of replacing the whole page
          if (!origContent.includes(search)) {
            finalContent = origContent + '\n' + gutenbergWrappedContent;
          }
        } else if (origContent && !search) {
          // No search text provided, default to appending
          finalContent = origContent + '\n' + gutenbergWrappedContent;
        }
      }

      // Always push to the native WP content field as well
      const requestData = {
        content: finalContent,
        status:  'publish'
      };

      if (!targetObj || actionType === 'create_page') {
        requestData.title = finalTitle;
        requestData.slug = targetSlug || undefined;
      }

      if (objType === 'pages') {
        if (parentId !== undefined) {
          requestData.parent = parentId;
        }
        if (payload.navigationParent) {
          requestData.template = 'elementor_canvas';
        }
      }

      const deployRes = await axios({
        method,
        url: endpoint,
        headers: axiosConfig.headers,
        data: requestData
      });
      updatedObject = deployRes.data;
    }

    const liveUrl       = updatedObject ? updatedObject.link : siteUrl;
    console.log(`[WordPress] Deployed successfully → ${liveUrl} (ID: ${updatedObject ? updatedObject.id : 'global-settings'})`);

    // Auto-interlink within the parent page if nested
    if (objType === 'pages' && parentId !== undefined && liveUrl) {
      await autoInterlinkParentPage(
        payload.title || 'Untitled Page',
        payload.slug || targetSlug || '',
        liveUrl,
        parentId,
        axiosConfig,
        siteUrl,
        restPrefix
      );
    }

    // Auto-interlink within the homepage if liveUrl is set
    if (objType === 'pages' && liveUrl) {
      try {
        let homepageId = null;
        const settingsRes = await axios.get(buildUrl('/wp/v2/settings'), axiosConfig);
        if (settingsRes.data && settingsRes.data.page_on_front) {
          homepageId = settingsRes.data.page_on_front;
        }
        if (!homepageId) {
          const homePageRes = await axios.get(buildUrl('/wp/v2/pages', 'slug=home&_fields=id'), axiosConfig).catch(() => ({ data: [] }));
          if (homePageRes.data && homePageRes.data.length > 0) {
            homepageId = homePageRes.data[0].id;
          }
        }
        if (homepageId && Number(homepageId) !== Number(parentId)) {
          console.log(`[WordPress] Auto-interlinking on Homepage (ID: ${homepageId})`);
          await autoInterlinkParentPage(
            payload.title || 'Untitled Page',
            payload.slug || targetSlug || '',
            liveUrl,
            homepageId,
            axiosConfig,
            siteUrl,
            restPrefix
          );
        }
      } catch (homeErr) {
        console.warn('[WordPress] Homepage auto-interlinking failed/skipped:', homeErr.message);
      }
    }

    // Auto-add/update child page in the navigation menu under parent page
    if (objType === 'pages' && parentId !== undefined && updatedObject && updatedObject.id) {
      await autoAddMenuItem(
        updatedObject.id,
        payload.title || 'Untitled Page',
        parentId,
        axiosConfig,
        siteUrl,
        restPrefix
      );
    }

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
        matchStrategy:        actualMatchStrategy,
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

function levenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

function findClosestTextMatch(html, searchText) {
  if (!html || !searchText) return searchText;
  
  const $ = cheerio.load(html);
  const candidates = [];
  
  // Extract all potential text elements
  $('h1, h2, h3, h4, h5, h6, p, span, a, li, button, div').each((_, el) => {
    // Direct text nodes only
    const directText = $(el).contents().filter(function() {
      return this.nodeType === 3;
    }).text().trim().replace(/\s+/g, ' ');
    
    if (directText.length > 3 && !candidates.includes(directText)) {
      candidates.push(directText);
    }
    
    // Leaf element text
    if ($(el).children().length === 0) {
      const fullText = $(el).text().trim().replace(/\s+/g, ' ');
      if (fullText.length > 3 && !candidates.includes(fullText)) {
        candidates.push(fullText);
      }
    }
  });

  if (candidates.length === 0) return searchText;

  let bestMatch = searchText;
  let bestScore = 0;
  
  const s1 = searchText.toLowerCase().trim();
  
  for (const cand of candidates) {
    const s2 = cand.toLowerCase().trim();
    
    // Perfect match (ignoring whitespace/casing)
    if (s1 === s2) {
      return cand;
    }
    
    // Substring match
    if (s2.includes(s1) || s1.includes(s2)) {
      const score = Math.min(s1.length, s2.length) / Math.max(s1.length, s2.length);
      const finalScore = 0.8 + (score * 0.15); // High score for substring
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestMatch = cand;
      }
      continue;
    }
    
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen > 0) {
      const dist = levenshteinDistance(s1, s2);
      const score = 1 - (dist / maxLen);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = cand;
      }
    }
  }

  // Threshold: only return bestMatch if similarity is above 50%
  if (bestScore > 0.5) {
    console.log(`[WordPress] Closest match found: "${bestMatch}" (Score: ${(bestScore * 100).toFixed(1)}%)`);
    return bestMatch;
  }

  return searchText;
}

function encode4ByteCharsToEntities(str) {
  if (!str) return '';
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.codePointAt(i);
    // If it's a 4-byte character (code point > 0xFFFF)
    if (code > 0xffff) {
      result += `&#${code};`;
      // JavaScript strings are UTF-16, so supplementary characters take up 2 indices (surrogate pair)
      i++; 
    } else {
      result += str.charAt(i);
    }
  }
  return result;
}

async function autoInterlinkParentPage(subServiceName, subServiceSlug, newLiveUrl, parentId, axiosConfig, siteUrl, restPrefix) {
  const buildUrl = (path) => {
    return siteUrl + (restPrefix === '/wp-json' ? `/wp-json${path}` : `/?rest_route=${path}`);
  };

  console.log(`[WordPress] Auto-interlinking "${subServiceName}" (${subServiceSlug}) in parent page ID ${parentId}`);
  try {
    const parentRes = await axios.get(buildUrl(`/wp/v2/pages/${parentId}?context=edit`), axiosConfig);
    let parentContent = parentRes.data.content?.raw || '';
    const parentLink = parentRes.data.link;

    let changesMade = false;
    let oldUrlToReplace = null;

    // Helper to score overlap
    const getOverlapScore = (s1, s2) => {
      const tokens1 = s1.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const tokens2 = s2.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      if (tokens1.length === 0 || tokens2.length === 0) return 0;
      
      const blacklist = ['consultation', 'booking', 'contact', 'about', 'home', 'privacy', 'terms', 'book', 'free'];
      if (tokens1.some(t => blacklist.includes(t))) return 0;

      const intersection = tokens1.filter(t => tokens2.includes(t));
      return intersection.length / Math.max(tokens1.length, tokens2.length);
    };

    const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // ── 1. Fetch live rendered HTML to extract actual old URL ──
    if (parentLink) {
      try {
        console.log(`[WordPress] Fetching live HTML from ${parentLink} to locate sub-service link...`);
        const liveRes = await axios.get(parentLink, { timeout: 10000 });
        const liveHtml = liveRes.data;
        if (liveHtml) {
          const $live = cheerio.load(liveHtml);
          $live('a').each((i, el) => {
            const href = $live(el).attr('href') || '';
            const text = $live(el).text() || '';
            
            const slugMatch = (subServiceSlug && href.toLowerCase().includes(subServiceSlug.toLowerCase())) || 
                              (subServiceSlug === 'ai-powered-seo' && href.toLowerCase().includes('ai-search-optimisation'));
            const textOverlap = getOverlapScore(text, subServiceName);

            const normHref = href.toLowerCase().replace(/\/$/, '');
            const isParentPage = normHref.endsWith('/seo') || normHref.endsWith('/google-ads') || normHref.endsWith('/meta-ads') || normHref.endsWith('/email-marketing') || normHref.endsWith('/web-development');
            const isParentText = text.trim().toLowerCase() === 'seo' || text.trim().toLowerCase() === 'google ads' || text.trim().toLowerCase() === 'meta ads' || text.trim().toLowerCase() === 'email marketing' || text.trim().toLowerCase() === 'web development';

            if (!isParentPage && !isParentText) {
              if (slugMatch || textOverlap >= 0.6) {
                if (href !== newLiveUrl) {
                  oldUrlToReplace = href;
                  console.log(`[WordPress] Identified link to replace from live HTML: Href="${href}" Text="${text.trim()}"`);
                }
              }
            }
          });
        }
      } catch (htmlErr) {
        console.warn(`[WordPress] Non-fatal error fetching parent live HTML for scanning:`, htmlErr.message);
      }
    }

    // ── 2. Scan and edit native WordPress content fields ──
    if (parentContent) {
      const $ = cheerio.load(parentContent);
      let contentChanges = false;

      $('a').each((i, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text() || '';
        
        const slugMatch = (subServiceSlug && href.toLowerCase().includes(subServiceSlug.toLowerCase())) || 
                          (subServiceSlug === 'ai-powered-seo' && href.toLowerCase().includes('ai-search-optimisation'));
        const textOverlap = getOverlapScore(text, subServiceName);

        const normHref = href.toLowerCase().replace(/\/$/, '');
        const isParentPage = normHref.endsWith('/seo') || normHref.endsWith('/google-ads') || normHref.endsWith('/meta-ads') || normHref.endsWith('/email-marketing') || normHref.endsWith('/web-development');
        const isParentText = text.trim().toLowerCase() === 'seo' || text.trim().toLowerCase() === 'google ads' || text.trim().toLowerCase() === 'meta ads' || text.trim().toLowerCase() === 'email marketing' || text.trim().toLowerCase() === 'web development';

        if (!isParentPage && !isParentText) {
          if (slugMatch || textOverlap >= 0.6) {
            console.log(`[WordPress] Auto-interlinking: Match found in raw content! Updating href from "${href}" to "${newLiveUrl}"`);
            $(el).attr('href', newLiveUrl);
            if (!oldUrlToReplace) oldUrlToReplace = href;
            contentChanges = true;
            changesMade = true;
          }
        }
      });

      if (!contentChanges) {
        $('h1, h2, h3, h4, h5, h6').each((i, el) => {
          const text = $(el).text().trim();
          const hasLink = $(el).find('a').length > 0;
          if (!hasLink) {
            const overlap = getOverlapScore(text, subServiceName);
            if (overlap >= 0.8 || text.toLowerCase().includes(subServiceName.toLowerCase())) {
              console.log(`[WordPress] Auto-interlinking: Match found in unlinked header: "${text}". Wrapping in link...`);
              $(el).html(`<a href="${newLiveUrl}">${$(el).html()}</a>`);
              contentChanges = true;
              changesMade = true;
            }
          }
        });
      }

      if (contentChanges) {
        parentContent = $('body').html() || '';
      }
    }

    if (changesMade && parentContent) {
      if (oldUrlToReplace) {
        parentContent = parentContent.replace(new RegExp(escapeRegExp(oldUrlToReplace), 'g'), newLiveUrl);
      }
      await axios.post(buildUrl(`/wp/v2/pages/${parentId}`), {
        content: parentContent
      }, axiosConfig);
      console.log(`[WordPress] Auto-interlinked successfully on WordPress parent page.`);
    }

    // ── 3. Force Elementor update if we have a match or fallbacks ──
    if (oldUrlToReplace && oldUrlToReplace.startsWith('http')) {
      try {
        let urlPath = '';
        try {
          const parsedUrl = new URL(oldUrlToReplace);
          urlPath = parsedUrl.pathname + parsedUrl.search;
        } catch (_) {
          const match = oldUrlToReplace.match(/https?:\/\/[^\/]+(\/.*)/);
          if (match) urlPath = match[1];
        }

        if (urlPath) {
          console.log(`[WordPress] Triggering Elementor update for Page ID ${parentId}: "${oldUrlToReplace}" -> "${newLiveUrl}"`);
          await axios.post(
            buildUrl(`/clicktrends/v1/update-elementor/${parentId}`),
            {
              search_text: oldUrlToReplace,
              replace_text: newLiveUrl
            },
            axiosConfig
          ).catch((e) => {
            console.log(`[WordPress] Elementor update for direct URL failed:`, e.response?.data?.message || e.message);
          });

          const clicktrendsUrl = `https://clicktrends.com.au` + urlPath;
          if (clicktrendsUrl !== oldUrlToReplace) {
            console.log(`[WordPress] Triggering Elementor fallback update for Page ID ${parentId}: "${clicktrendsUrl}" -> "${newLiveUrl}"`);
            await axios.post(
              buildUrl(`/clicktrends/v1/update-elementor/${parentId}`),
              {
                search_text: clicktrendsUrl,
                replace_text: newLiveUrl
              },
              axiosConfig
            ).catch(() => {});
          }
        }
      } catch (elemErr) {
        console.warn(`[WordPress] Elementor update failed:`, elemErr.message);
      }
    } else {
      // Robust Fallback: run elementor replacements for predicted URLs
      try {
        const urlPaths = [
          `/${subServiceSlug}-services/`,
          `/${subServiceSlug}-services`,
          `/${subServiceSlug}/`,
          `/${subServiceSlug}`,
          `/seo/${subServiceSlug}/`,
          `/seo/${subServiceSlug}`
        ];
        
        console.log(`[WordPress] Fallback Elementor replacement on Page ID ${parentId} for predicted paths:`, urlPaths);
        for (const p of urlPaths) {
          const testUrls = [
            `https://clicktrends.com.au${p}`,
            `${siteUrl.replace(/\/+$/, '')}${p}`
          ];
          for (const u of testUrls) {
            if (u !== newLiveUrl) {
              await axios.post(
                buildUrl(`/clicktrends/v1/update-elementor/${parentId}`),
                {
                  search_text: u,
                  replace_text: newLiveUrl
                },
                axiosConfig
              ).catch(() => {});
            }
          }
        }
      } catch (fallbackErr) {
        console.warn(`[WordPress] Fallback Elementor replacement failed:`, fallbackErr.message);
      }
    }
  } catch (err) {
    console.warn('[WordPress] Auto-interlinking failed:', err.message);
  }
}

async function autoAddMenuItem(pageId, pageTitle, parentPageId, axiosConfig, siteUrl, restPrefix) {
  const buildUrl = (path) => {
    return siteUrl + (restPrefix === '/wp-json' ? `/wp-json${path}` : `/?rest_route=${path}`);
  };

  console.log(`[WordPress Menu] Auto-adding/updating menu item for Page ID ${pageId} ("${pageTitle}") under Parent Page ID ${parentPageId}`);
  try {
    const menusRes = await axios.get(buildUrl('/wp/v2/menus'), axiosConfig);
    const menus = menusRes.data || [];
    if (menus.length === 0) {
      console.log('[WordPress Menu] No menus found on site.');
      return;
    }

    const primaryMenu = menus.find(m => m.locations && (m.locations.includes('primary') || m.locations.includes('primary-menu') || m.locations.includes('header'))) || menus[0];
    const menuId = primaryMenu.id;

    const itemsRes = await axios.get(buildUrl(`/wp/v2/menu-items?menus=${menuId}&per_page=100`), axiosConfig);
    const menuItems = itemsRes.data || [];

    const parentMenuItem = menuItems.find(item => Number(item.object_id) === Number(parentPageId));
    if (!parentMenuItem) {
      console.log(`[WordPress Menu] Parent Page ID ${parentPageId} is not in the menu. Skipping nesting.`);
      return;
    }
    const parentMenuItemId = parentMenuItem.id;

    const existingMenuItem = menuItems.find(item => Number(item.object_id) === Number(pageId) && Number(item.menus) === Number(menuId));

    if (existingMenuItem) {
      const updateData = {};
      let needsUpdate = false;

      if (Number(existingMenuItem.parent) !== Number(parentMenuItemId)) {
        updateData.parent = parentMenuItemId;
        needsUpdate = true;
      }

      const cleanPageTitle = pageTitle.trim();
      const existingTitle = (existingMenuItem.title?.rendered || '').trim();
      if (existingTitle !== cleanPageTitle && cleanPageTitle !== 'Untitled Page') {
        updateData.title = cleanPageTitle;
        needsUpdate = true;
      }

      if (needsUpdate) {
        console.log(`[WordPress Menu] Updating existing menu item [${existingMenuItem.id}] with parent ${parentMenuItemId} and title "${cleanPageTitle}"`);
        await axios.post(buildUrl(`/wp/v2/menu-items/${existingMenuItem.id}`), updateData, axiosConfig);
        console.log('[WordPress Menu] Menu item updated successfully.');
      } else {
        console.log('[WordPress Menu] Menu item parent and title are already correct.');
      }
    } else {
      await axios.post(buildUrl('/wp/v2/menu-items'), {
        title: pageTitle,
        status: 'publish',
        type: 'post_type',
        object: 'page',
        object_id: pageId,
        parent: parentMenuItemId,
        menus: menuId
      }, axiosConfig);
      console.log('[WordPress Menu] Menu item created successfully under parent.');
    }
  } catch (err) {
    console.warn('[WordPress Menu] Failed to manage navigation menu item:', err.response?.data || err.message);
  }
}
