import axios from 'axios';
import * as cheerio from 'cheerio';

export function levenshteinDistance(a, b) {
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

export async function autoInterlinkParentPage(subServiceName, subServiceSlug, newLiveUrl, parentId, axiosConfig, siteUrl, restPrefix) {
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

export async function autoAddMenuItem(pageId, pageTitle, parentPageId, axiosConfig, siteUrl, restPrefix, navigationParentName) {
  const buildUrl = (path) => {
    return siteUrl + (restPrefix === '/wp-json' ? `/wp-json${path}` : `/?rest_route=${path}`);
  };

  console.log(`[WordPress Menu] Auto-adding/updating menu item for Page ID ${pageId} ("${pageTitle}") under Parent Page ID ${parentPageId} or Name "${navigationParentName}"`);
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

    let parentMenuItem;
    if (parentPageId) {
      parentMenuItem = menuItems.find(item => Number(item.object_id) === Number(parentPageId));
    }

    if (!parentMenuItem && navigationParentName) {
      const searchName = navigationParentName.toLowerCase().replace(/pay-per-click|optimization|advertising/g, '').trim();
      parentMenuItem = menuItems.find(item => {
        const itemTitle = (item.title?.rendered || item.title || '').toLowerCase().trim();
        return itemTitle && (itemTitle.includes(searchName) || searchName.includes(itemTitle));
      });
    }

    if (!parentMenuItem) {
      console.log(`[WordPress Menu] Parent Page ID ${parentPageId} or name "${navigationParentName}" is not in the menu. Skipping nesting.`);
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

