// ============================================================
// backend/services/crawler.js
// Website crawler — extracts SEO, content, meta, CWV signals
// ============================================================

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { enrichWithPerplexity } from './perplexity.js';


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
  };

  try {
    onProgress('Fetching homepage…');
    const homepageData = await crawlPage(normalised);
    crawledData.homepage = homepageData;
    crawledData.pages.push(homepageData);
    crawledData.headings.push(...(homepageData.headings || []));
    crawledData.ctaText.push(...(homepageData.ctaText || []));
    crawledData.socialLinks.push(...(homepageData.socialLinks || []));
    crawledData.schema.push(...(homepageData.schema || []));

    // Extract internal links to crawl
    const internalLinks = (homepageData.internalLinks || [])
      .filter(link => isInternalLink(link, normalised))
      .slice(0, 20); // Cap at 20 pages

    onProgress(`Found ${internalLinks.length} internal pages — crawling…`);

    // Crawl internal pages (cap at 10 for performance)
    const pagesToCrawl = internalLinks.slice(0, 10);
    for (const pageUrl of pagesToCrawl) {
      try {
        const pageData = await crawlPage(pageUrl);
        crawledData.pages.push(pageData);
        crawledData.headings.push(...(pageData.headings || []));
        crawledData.ctaText.push(...(pageData.ctaText || []));
        crawledData.schema.push(...(pageData.schema || []));

        // Classify special pages
        if (/about|our-story|who-we-are/i.test(pageUrl)) {
          crawledData.aboutPage = pageData;
        }
        if (/pricing|plans|packages/i.test(pageUrl)) {
          crawledData.pricingCopy.push(pageData.bodyText || '');
        }
        if (/testimonial|reviews|case-stud/i.test(pageUrl)) {
          crawledData.testimonials.push(...(pageData.testimonials || []));
        }
      } catch (err) {
        console.warn(`[Crawler] Skipping ${pageUrl}: ${err.message}`);
      }
    }

    // Extract signals from all pages
    crawledData.metaSignals = extractMetaSignals(crawledData.pages);
    crawledData.emailForms = extractEmailForms(crawledData.pages);
    crawledData.claims = extractClaims(crawledData.pages);
    crawledData.contentTypes = detectContentTypes(crawledData.pages);
    crawledData.businessSummary = buildBusinessSummary(crawledData);
    crawledData.allCopy = buildAllCopy(crawledData.pages);

    // Social links dedup
    crawledData.socialLinks = [...new Set(crawledData.socialLinks)];

    onProgress(`Crawl complete — ${crawledData.pages.length} pages analysed`);

    // ── Perplexity web research ───────────────────────────────
    // Uses live web search (via OpenRouter) to gather competitor
    // intelligence, business reputation, and industry trends.
    // Runs ONLY with OPENROUTER_API_KEY set. Falls back silently.
    await enrichWithPerplexity(crawledData, onProgress);

    // NOTE: Keyword research (enrichWithDataForSEO) runs separately
    // in the init pipeline after crawling, so keywords are stored
    // to the DB and available for all subsequent plugin analyze runs.

    return crawledData;


  } catch (err) {
    console.error(`[Crawler] Fatal error: ${err.message}`);
    // Return partial data rather than throwing
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
    // node-fetch v3 dropped the timeout option — use AbortSignal instead
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
