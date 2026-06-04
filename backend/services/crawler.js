// ============================================================
// backend/services/crawler.js
// Website crawler — extracts SEO, content, meta, CWV signals
// ============================================================

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { enrichWithPerplexity } from './perplexity.js';

const URL_CATEGORIES = [
  { pattern: /^\/$/, name: 'Homepage', score: 100, cost: 10, limit: 1 },
  { pattern: /pricing|plans|packages/i, name: 'Pricing', score: 95, cost: 10, limit: 1 },
  { pattern: /product|item|buy/i, name: 'Products', score: 90, cost: 5, limit: 5 },
  { pattern: /service|what-we-do/i, name: 'Services', score: 90, cost: 5, limit: 5 },
  { pattern: /solution/i, name: 'Solutions', score: 90, cost: 5, limit: 3 },
  { pattern: /feature/i, name: 'Features', score: 85, cost: 5, limit: 3 },
  { pattern: /case-stud|success/i, name: 'Case Studies', score: 80, cost: 5, limit: 3 },
  { pattern: /portfolio|work/i, name: 'Portfolio', score: 80, cost: 5, limit: 3 },
  { pattern: /about|our-story|who-we-are|team/i, name: 'About', score: 75, cost: 10, limit: 1 },
  { pattern: /contact|get-in-touch/i, name: 'Contact', score: 70, cost: 5, limit: 1 },
  { pattern: /resource|guide|whitepaper/i, name: 'Resources', score: 60, cost: 1, limit: 3 },
  { pattern: /blog|article|post|news/i, name: 'Blog', score: 50, cost: 1, limit: 3 },
  { pattern: /doc|help|support/i, name: 'Documentation', score: 40, cost: 1, limit: 2 },
  { pattern: /career|job/i, name: 'Careers', score: 20, cost: 1, limit: 1 },
];

function categorizeUrl(url, baseUrl) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== new URL(baseUrl).hostname) return null;
    let pathname = parsed.pathname;
    if (pathname === '/') return URL_CATEGORIES[0];
    
    for (let i = 1; i < URL_CATEGORIES.length; i++) {
      if (URL_CATEGORIES[i].pattern.test(pathname)) {
        return URL_CATEGORIES[i];
      }
    }
  } catch (e) {}
  
  return { name: 'Other', score: 10, cost: 2, limit: 5 }; // default category
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    // remove hash and standard query params
    parsed.hash = '';
    // Optional: remove tracking params
    const paramsToRemove = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid'];
    for (const p of paramsToRemove) parsed.searchParams.delete(p);
    
    let normalized = parsed.toString();
    // remove trailing slash if not root
    if (normalized.endsWith('/') && parsed.pathname !== '/') {
        normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch (e) {
    return url;
  }
}

async function fetchSitemap(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const text = await res.text();
    const $ = cheerio.load(text, { xmlMode: true });
    
    let urls = [];
    $('url loc').each((_, el) => {
      urls.push($(el).text().trim());
    });
    
    // Also handle sitemap index
    let sitemaps = [];
    $('sitemap loc').each((_, el) => {
        sitemaps.push($(el).text().trim());
    });
    
    // If it's an index, try fetching the first 2 sitemaps to prevent hanging on massive indexes
    if (sitemaps.length > 0) {
        for (const sitemap of sitemaps.slice(0, 2)) {
            const nestedUrls = await fetchSitemap(sitemap);
            urls.push(...nestedUrls);
        }
    }
    
    return urls;
  } catch (e) {
    return [];
  }
}

async function discoverUrls(baseUrl) {
    const urls = new Set();
    const sitemapsToTry = [`${baseUrl}/sitemap.xml`, `${baseUrl}/sitemap_index.xml`];
    
    // Check robots.txt for explicit sitemap declarations
    try {
        const robotsRes = await fetch(`${baseUrl}/robots.txt`, { signal: AbortSignal.timeout(3000) });
        if (robotsRes.ok) {
            const robotsText = await robotsRes.text();
            const sitemapMatch = robotsText.match(/Sitemap:\s*(.+)/i);
            if (sitemapMatch && sitemapMatch[1]) {
                sitemapsToTry.unshift(sitemapMatch[1].trim());
            }
        }
    } catch (e) {}

    for (const smUrl of sitemapsToTry) {
        const smUrls = await fetchSitemap(smUrl);
        if (smUrls.length > 0) {
            smUrls.forEach(u => urls.add(normalizeUrl(u)));
            break; // found a valid sitemap, stop trying others
        }
    }
    return Array.from(urls);
}

/**
 * Main crawler entry point.
 * Crawls the business website and extracts structured data.
 *
 * @param {string} url - Target website URL
 * @param {Function} onProgress - SSE progress callback (message) => void
 * @returns {Promise<Object>} Structured crawled data
 */
export async function crawlWebsite(url, onProgress = () => {}) {
  const normalised = normaliseUrl(url);
  const crawledData = {
    url: normalised,
    crawledAt: new Date().toISOString(),
    pages: [],
    homepage: null,
    aboutPage: null,
    metaSignals: {},
    headings: [],
    ctaText: [],
    socialLinks: [],
    schema: [],
    emailForms: [],
    leadMagnets: [],
    productsServices: [],
    testimonials: [],
    pricingCopy: [],
    claims: [],
    contentTypes: [],
    brandSignals: {},
    businessSummary: {},
    coreWebVitals: {},
    allCopy: {},
    geography: 'Australia',
    brandVoice: null,
    auditDataset: [], // Optimized dataset for Claude
  };

  try {
    onProgress('Phase 1: Discovering URLs (sitemaps & robots.txt)…');
    const discoveredFromSitemap = await discoverUrls(normalised);
    
    onProgress('Phase 2: Analysing Homepage…');
    const homepageData = await crawlPage(normalised);
    crawledData.homepage = homepageData;
    crawledData.pages.push(homepageData);
    crawledData.headings.push(...(homepageData.headings || []));
    crawledData.ctaText.push(...(homepageData.ctaText || []));
    crawledData.socialLinks.push(...(homepageData.socialLinks || []));
    crawledData.schema.push(...(homepageData.schema || []));
    
    const homepageNormalized = normalizeUrl(normalised);
    crawledData.auditDataset.push({
        url: homepageData.url,
        title: homepageData.title,
        category: 'Homepage',
        priority: 100,
        bodySnippet: (homepageData.bodyText || '').slice(0, 2000)
    });

    // Merge homepage internal links with sitemap links
    const allInternalLinks = new Set([
        ...discoveredFromSitemap,
        ...(homepageData.internalLinks || []).map(normalizeUrl)
    ]);
    
    // Remove homepage from pool to avoid re-crawling
    allInternalLinks.delete(homepageNormalized);

    // Phase 3 & 4: Classification & Prioritization
    let urlPool = Array.from(allInternalLinks)
        .filter(link => isInternalLink(link, normalised))
        .map(link => {
            const category = categorizeUrl(link, normalised);
            return { link, category };
        })
        .filter(item => item.category !== null)
        .sort((a, b) => b.category.score - a.category.score); // Highest priority first

    onProgress(`Discovered ${urlPool.length} internal pages. Prioritising…`);

    // Phase 5: Adaptive Crawl Limits
    let crawlBudget = 200; // Small site
    if (urlPool.length > 100) crawlBudget = 500; // Large site
    else if (urlPool.length > 20) crawlBudget = 300; // Medium site

    // Deduct homepage cost
    crawlBudget -= URL_CATEGORIES[0].cost;

    // Phase 6: Content Sampling
    const categoryCounts = {};
    const pagesToCrawl = [];
    
    for (const item of urlPool) {
        const catName = item.category.name;
        if (!categoryCounts[catName]) categoryCounts[catName] = 0;
        
        if (categoryCounts[catName] < item.category.limit) {
            pagesToCrawl.push(item);
            categoryCounts[catName]++;
        }
    }

    onProgress(`Selected ${pagesToCrawl.length} high-value pages for crawling (Budget: ${crawlBudget})…`);

    // Phase 7 & 8: Crawl Budget & Business Guarantee
    const batchSize = 5;
    for (let i = 0; i < pagesToCrawl.length; i += batchSize) {
      if (crawlBudget <= 0) {
          onProgress(`Crawl budget exhausted. Stopping early to save tokens and time.`);
          break;
      }
      
      const batch = pagesToCrawl.slice(i, i + batchSize);
      const results = await Promise.all(batch.map(async (item) => {
        try {
          // Deduct budget immediately for attempted crawls
          crawlBudget -= item.category.cost;
          const data = await crawlPage(item.link);
          return { data, category: item.category };
        } catch (err) {
          console.warn(`[Crawler] Skipping ${item.link}: ${err.message}`);
          return null;
        }
      }));

      for (const result of results) {
        if (!result || !result.data) continue;
        const pageData = result.data;
        const pageUrl = pageData.url;
        const category = result.category;
        
        crawledData.pages.push(pageData);
        crawledData.headings.push(...(pageData.headings || []));
        crawledData.ctaText.push(...(pageData.ctaText || []));
        crawledData.schema.push(...(pageData.schema || []));

        // Phase 10: Audit Dataset
        crawledData.auditDataset.push({
            url: pageUrl,
            title: pageData.title,
            category: category.name,
            priority: category.score,
            bodySnippet: (pageData.bodyText || '').slice(0, 2000)
        });

        if (category.name === 'About') crawledData.aboutPage = pageData;
        if (category.name === 'Pricing') crawledData.pricingCopy.push(pageData.bodyText || '');
        if (category.name === 'Case Studies') crawledData.testimonials.push(...(pageData.testimonials || []));
      }
    }

    // Extract signals
    crawledData.metaSignals = extractMetaSignals(crawledData.pages);
    crawledData.emailForms = extractEmailForms(crawledData.pages);
    crawledData.claims = extractClaims(crawledData.pages);
    crawledData.contentTypes = detectContentTypes(crawledData.pages);
    crawledData.businessSummary = buildBusinessSummary(crawledData);
    crawledData.allCopy = buildAllCopy(crawledData.pages);

    crawledData.socialLinks = [...new Set(crawledData.socialLinks)];

    onProgress(`Crawl complete — ${crawledData.pages.length} high-value pages analysed.`);

    // Perplexity research
    await enrichWithPerplexity(crawledData, onProgress);

    return crawledData;

  } catch (err) {
    console.error(`[Crawler] Fatal error: ${err.message}`);
    crawledData.error = err.message;
    return crawledData;
  }
}

// ─── Page Crawler ─────────────────────────────────────────────
async function crawlPage(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ClickTrends-AI-Audit/1.0 (+https://clicktrends.com.au/audit-bot)',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  const page = {
    url,
    title: $('title').text().trim(),
    metaDescription: $('meta[name="description"]').attr('content') || '',
    metaRobots: $('meta[name="robots"]').attr('content') || '',
    canonical: $('link[rel="canonical"]').attr('href') || '',
    h1: $('h1').map((_, el) => $(el).text().trim()).get(),
    h2: $('h2').map((_, el) => $(el).text().trim()).get(),
    headings: [],
    bodyText: $('body').text().replace(/\s+/g, ' ').trim().slice(0, 5000),
    ctaText: [],
    internalLinks: [],
    externalLinks: [],
    socialLinks: [],
    images: [],
    schema: [],
    testimonials: [],
    copy: {},
  };

  // Headings
  page.headings = [
    ...$('h1').map((_, el) => ({ level: 1, text: $(el).text().trim() })).get(),
    ...$('h2').map((_, el) => ({ level: 2, text: $(el).text().trim() })).get(),
    ...$('h3').map((_, el) => ({ level: 3, text: $(el).text().trim() })).get(),
  ];

  // CTAs
  const ctaSelectors = ['a.btn', 'a.button', '.cta a', 'button', '[class*="cta"]', '[class*="btn"]'];
  ctaSelectors.forEach(sel => {
    $(sel).each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length < 80) page.ctaText.push(text);
    });
  });

  // Links
  const baseHost = new URL(url).hostname;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const absolute = toAbsolute(href, url);
    if (!absolute) return;

    if (/linkedin|twitter|facebook|instagram|youtube|tiktok/i.test(absolute)) {
      page.socialLinks.push(absolute);
    } else if (new URL(absolute).hostname === baseHost) {
      page.internalLinks.push(absolute);
    } else {
      page.externalLinks.push(absolute);
    }
  });

  // Schema.org
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() || '{}');
      page.schema.push(json);
    } catch (_) {}
  });

  // Images
  $('img').each((_, el) => {
    page.images.push({
      src: $(el).attr('src') || '',
      alt: $(el).attr('alt') || '',
      hasAlt: !!($(el).attr('alt')),
    });
  });

  // Testimonials
  $('[class*="testimonial"], [class*="review"], blockquote').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 20) page.testimonials.push(text.slice(0, 500));
  });

  // Key copy sections
  page.copy = {
    heroHeadline: page.h1[0] || '',
    heroSubtext: $('[class*="hero"] p, [class*="banner"] p').first().text().trim(),
    aboutSection: $('[class*="about"] p').map((_, el) => $(el).text().trim()).get().join(' ').slice(0, 1000),
  };

  return page;
}

// ─── Helpers ──────────────────────────────────────────────────
function normaliseUrl(url) {
  if (!url.startsWith('http')) url = 'https://' + url;
  const u = new URL(url);
  return u.origin + (u.pathname === '/' ? '' : u.pathname);
}

function toAbsolute(href, base) {
  try {
    return new URL(href, base).href;
  } catch (_) {
    return null;
  }
}

function isInternalLink(link, base) {
  try {
    return new URL(link).hostname === new URL(base).hostname;
  } catch (_) {
    return false;
  }
}

function extractMetaSignals(pages) {
  const missingTitles = pages.filter(p => !p.title).length;
  const missingMeta = pages.filter(p => !p.metaDescription).length;
  const missingH1 = pages.filter(p => !p.h1?.length).length;
  const missingAlt = pages.reduce((acc, p) => acc + (p.images || []).filter(i => !i.hasAlt).length, 0);
  const hasSchema = pages.some(p => p.schema?.length > 0);
  const schemaTypes = [...new Set(pages.flatMap(p => (p.schema || []).map(s => s['@type'])).filter(Boolean))];

  return {
    totalPages: pages.length,
    missingTitles,
    missingMetaDescriptions: missingMeta,
    missingH1: missingH1,
    missingImageAlt: missingAlt,
    hasStructuredData: hasSchema,
    schemaTypes,
    canonicalCoverage: `${pages.filter(p => p.canonical).length}/${pages.length}`,
  };
}

function extractEmailForms(pages) {
  return pages.flatMap(p => {
    const forms = [];
    if (/subscribe|newsletter|email|get.*audit|free.*report/i.test(p.bodyText || '')) {
      forms.push({ page: p.url, type: 'Email capture detected' });
    }
    return forms;
  });
}

function extractClaims(pages) {
  const claimPatterns = [
    /\b(#1|number one|best|leading|top|guaranteed|world[- ]class|award[- ]winning|fastest|cheapest|most [a-z]+)\b/gi,
  ];
  return pages.flatMap(p =>
    claimPatterns.flatMap(pattern => {
      const matches = (p.bodyText || '').match(pattern) || [];
      return matches.map(m => ({ claim: m, page: p.url }));
    })
  );
}

function detectContentTypes(pages) {
  const types = [];
  if (pages.some(p => /blog|article|post/i.test(p.url))) types.push('Blog');
  if (pages.some(p => /case-stud|success/i.test(p.url))) types.push('Case Studies');
  if (pages.some(p => /video|youtube/i.test(p.bodyText || ''))) types.push('Video');
  if (pages.some(p => /podcast/i.test(p.bodyText || ''))) types.push('Podcast');
  if (pages.some(p => /faq/i.test(p.url))) types.push('FAQ');
  return types;
}

function buildBusinessSummary(data) {
  const homepage = data.homepage || {};
  return {
    name: homepage.title?.split('|')[0]?.split('-')[0]?.trim() || 'Unknown',
    headline: homepage.copy?.heroHeadline || '',
    description: homepage.copy?.heroSubtext || homepage.metaDescription || '',
    hasAboutPage: !!data.aboutPage,
    totalPages: data.pages.length,
  };
}

function buildAllCopy(pages) {
  const result = {};
  pages.forEach(p => {
    result[p.url] = {
      title: p.title,
      metaDescription: p.metaDescription,
      h1: p.h1,
      bodySnippet: (p.bodyText || '').slice(0, 2000),
    };
  });
  return result;
}
