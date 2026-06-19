import axios from 'axios';
import { WordPressAdapter } from './adapters/WordPressAdapter.js';
import { ElementorAdapter } from './adapters/ElementorAdapter.js';
import { autoInterlinkParentPage, autoAddMenuItem } from './helpers.js';

export class DeploymentManager {
  constructor() {
    // Store adapters if we want, but since they need axios config, we instantiate them per request or pass axios config
  }

  buildUrl(siteUrl, restPrefix, path) {
    return siteUrl + (restPrefix === '/wp-json' ? `/wp-json${path}` : `/?rest_route=${path}`);
  }

  async deploy(payload, integration) {
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

    const authHeader = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
    const axiosConfig = {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 30000,
    };
    
    const axiosInstance = axios.create(axiosConfig);

    const restPrefix = siteUrl.includes('?') ? '' : '/wp-json';
    const objType = payload.assetType || 'pages';

    let endpoint = this.buildUrl(siteUrl, restPrefix, `/wp/v2/${objType}`);
    let method = 'POST';
    let targetObj = null;
    let targetSlug = null;
    let parentId = undefined;

    let subServiceSlug = '';

    // ── 1. Discover target and parent context ──
    if (payload.actionType === 'create_page') {
      const pageTitle = payload.pageTitle || payload.title || 'Untitled Page';
      targetSlug = pageTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      subServiceSlug = targetSlug;
      console.log(`[DeploymentManager] Preparing to CREATE new page: "${pageTitle}" (${targetSlug})`);

      if (payload.parentSlug) {
        console.log(`[DeploymentManager] Requested explicit parent lookup by slug: "${payload.parentSlug}"`);
        const searchPathBySlug = `/wp/v2/pages?slug=${encodeURIComponent(payload.parentSlug.replace(/^\/|\/$/g, ''))}&_fields=id,title,slug,link`;
        try {
          const slugRes = await axiosInstance.get(this.buildUrl(siteUrl, restPrefix, searchPathBySlug));
          if (slugRes.data && slugRes.data.length > 0) {
            parentId = slugRes.data[0].id;
            console.log(`[DeploymentManager] Found parent page by slug: "${slugRes.data[0].title.rendered}" (ID: ${parentId})`);
          }
        } catch (err) {
          console.warn(`[DeploymentManager] Failed to lookup parent page by slug: ${err.message}`);
        }
      }

      if (!parentId && payload.navigationParent) {
        console.log(`[DeploymentManager] Requested fallback parent lookup by search text: "${payload.navigationParent}"`);
        const searchPath = `/wp/v2/pages?search=${encodeURIComponent(payload.navigationParent)}&_fields=id,title,slug,link`;
        try {
          const parentRes = await axiosInstance.get(this.buildUrl(siteUrl, restPrefix, searchPath));
          if (parentRes.data && parentRes.data.length > 0) {
            parentId = parentRes.data[0].id;
            console.log(`[DeploymentManager] Found parent page by text search: "${parentRes.data[0].title.rendered}" (ID: ${parentId})`);
          } else {
            console.log(`[DeploymentManager] Parent page "${payload.navigationParent}" not found.`);
          }
        } catch (err) {
          console.warn(`[DeploymentManager] Failed to lookup parent page by text search: ${err.message}`);
        }
      }
    } else {
      let liveUrl = payload.sourceUrl || payload.location;
      if (liveUrl && !liveUrl.startsWith('http')) {
        liveUrl = siteUrl.replace(/\/+$/, '') + (liveUrl.startsWith('/') ? '' : '/') + liveUrl;
      }
      
      console.log(`[DeploymentManager] sourceUrl: ${payload.sourceUrl} | location: ${payload.location}`);

      if (liveUrl) {
        try {
          let urlPath = '';
          try {
            const parsed = new URL(liveUrl);
            urlPath = parsed.pathname;
          } catch (_) {
            urlPath = liveUrl;
          }

          let possibleSlug = urlPath.replace(/\/$/, '').split('/').pop() || '';
          if (possibleSlug && possibleSlug !== 'home' && !liveUrl.match(/^https?:\/\/[^\/]+\/?$/)) {
            targetSlug = possibleSlug;
            subServiceSlug = targetSlug;
          }

          if (targetSlug) {
            console.log(`[DeploymentManager] Strategy A: slug lookup for "${targetSlug}"`);
            const pagesBySlug = await axiosInstance.get(
              this.buildUrl(siteUrl, restPrefix, `/wp/v2/${objType}?slug=${encodeURIComponent(targetSlug)}&context=edit&_fields=id,slug,link,title,parent,content,meta`)
            ).catch(() => ({ data: [] }));

            if (pagesBySlug.data && pagesBySlug.data.length > 0) {
              targetObj = pagesBySlug.data[0];
              endpoint = this.buildUrl(siteUrl, restPrefix, `/wp/v2/${objType}/${targetObj.id}`);
              method = 'POST';
              console.log(`[DeploymentManager] Found page by slug: [${targetObj.id}] "${targetObj.title?.rendered}" → ${targetObj.link}`);
            }
          }

          if (!targetObj) {
            console.log(`[DeploymentManager] Strategy A2: matching exact link for "${liveUrl}"`);
            // Only fetch id, slug, link, title, parent to avoid huge payloads and timeouts
            const allPages = await axiosInstance.get(
              this.buildUrl(siteUrl, restPrefix, `/wp/v2/${objType}?per_page=100&_fields=id,slug,link,title,parent`)
            );
            
            if (allPages.data && Array.isArray(allPages.data)) {
              const exactMatch = allPages.data.find(p => p.link && p.link.replace(/\/$/, '') === liveUrl.replace(/\/$/, ''));
              if (exactMatch) {
                // Now fetch the full object including content and meta
                const fullPage = await axiosInstance.get(
                  this.buildUrl(siteUrl, restPrefix, `/wp/v2/${objType}/${exactMatch.id}?context=edit&_fields=id,slug,link,title,parent,content,meta`)
                );
                targetObj = fullPage.data;
                endpoint = this.buildUrl(siteUrl, restPrefix, `/wp/v2/${objType}/${targetObj.id}`);
                method = 'POST';
                console.log(`[DeploymentManager] Found page by exact link match: [${targetObj.id}] "${targetObj.title.rendered}" → ${targetObj.link}`);
              }
            }
          }
        } catch (e) {
          console.warn(`[DeploymentManager] Error during target discovery: ${e.message}`);
        }
      }
    }

    // ── 2. Detect Page Builder ──
    let builderType = 'wordpress';
    
    if (targetObj && targetObj.meta) {
      if (targetObj.meta._elementor_edit_mode === 'builder' || targetObj.meta._elementor_data) {
        builderType = 'elementor';
      }
    }

    let resolvedActionType = payload.actionType || 'replace';
    
    // If we are deploying an entire new page, force the action to create_page
    // so we overwrite any existing Elementor or native content.
    if (payload.assetType === 'new_page') {
      builderType = 'wordpress';
      resolvedActionType = 'create_page';
    }

    console.log(`[DeploymentManager] Detected builder type: ${builderType}`);

    // ── 3. Route to Adapter ──
    let deployResult;
    const adapterParams = {
      payload,
      targetObj,
      actionType: resolvedActionType,
      endpoint,
      method,
      targetSlug,
      parentId,
      objType
    };

    if (builderType === 'elementor' && adapterParams.actionType !== 'create_page') {
      const adapter = new ElementorAdapter(axiosInstance);
      deployResult = await adapter.deploy(adapterParams);
    } else {
      // Create new page OR update native wordpress page
      const adapter = new WordPressAdapter(axiosInstance);
      deployResult = await adapter.deploy(adapterParams);
    }

    const updatedObject = deployResult.updatedObject;
    const liveUrl = updatedObject ? updatedObject.link : siteUrl;
    console.log(`[DeploymentManager] Deployed successfully → ${liveUrl} (ID: ${updatedObject ? updatedObject.id : 'global-settings'})`);

    // ── 4. Interlinking / Post-Deployment ──
    if (objType === 'pages' && parentId !== undefined && liveUrl && adapterParams.actionType === 'create_page') {
      await autoInterlinkParentPage(
        payload.title || 'Untitled Page',
        subServiceSlug || targetSlug || '',
        liveUrl,
        parentId,
        axiosConfig,
        siteUrl,
        restPrefix
      );
    }

    if (objType === 'pages' && liveUrl && adapterParams.actionType === 'create_page') {
      try {
        let homepageId = null;
        const settingsRes = await axiosInstance.get(this.buildUrl(siteUrl, restPrefix, '/wp/v2/settings'));
        if (settingsRes.data && settingsRes.data.page_on_front) {
          homepageId = settingsRes.data.page_on_front;
        }
        if (!homepageId) {
          const homePageRes = await axiosInstance.get(this.buildUrl(siteUrl, restPrefix, '/wp/v2/pages?slug=home&_fields=id')).catch(() => ({ data: [] }));
          if (homePageRes.data && homePageRes.data.length > 0) {
            homepageId = homePageRes.data[0].id;
          }
        }
        if (homepageId && Number(homepageId) !== Number(parentId)) {
          console.log(`[DeploymentManager] Auto-interlinking on Homepage (ID: ${homepageId})`);
          await autoInterlinkParentPage(
            payload.title || 'Untitled Page',
            subServiceSlug || targetSlug || '',
            liveUrl,
            homepageId,
            axiosConfig,
            siteUrl,
            restPrefix
          );
        }
      } catch (homeErr) {
        console.warn(`[DeploymentManager] Auto-interlink on homepage failed: ${homeErr.message}`);
      }
    }

    if (objType === 'pages' && payload.navigationParent && updatedObject) {
      await autoAddMenuItem(
        updatedObject.id,
        payload.pageTitle || payload.title || 'Untitled Page',
        parentId,
        axiosConfig,
        siteUrl,
        restPrefix,
        payload.navigationParent
      );
    }

    // Prepare response with rollback info
    return {
      updatedObject,
      builderType,
      deploymentMethod: deployResult.method,
      previousContent: targetObj ? {
        post_content: targetObj.content?.raw || targetObj.content?.rendered || '',
        _elementor_data: targetObj.meta?._elementor_data || null
      } : null
    };
  }
}
