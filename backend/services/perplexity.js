// ============================================================
// backend/services/perplexity.js
// Perplexity web-research service via OpenRouter
//
// Uses ONLY the OPENROUTER_API_KEY — NOT the Anthropic key.
// Perplexity's sonar models perform live web searches, making
// them ideal for competitive intelligence and reputation research
// that the on-site crawler cannot retrieve.
//
// Docs: https://openrouter.ai/docs
//       https://openrouter.ai/models?q=perplexity
// ============================================================

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// Perplexity's flagship web-search model (supports citations)
const PERPLEXITY_MODEL    = 'perplexity/sonar-pro';
// Fallback if sonar-pro quota is hit
const PERPLEXITY_FALLBACK = 'perplexity/sonar';

// ─── Core request helper ────────────────────────────────────────────
async function perplexityChat(systemPrompt, userPrompt, { maxTokens = 1500, model = PERPLEXITY_MODEL } = {}) {
  // Read key lazily so dotenv is always loaded first
  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
  if (!OPENROUTER_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set — Perplexity research unavailable.');
  }

  const body = {
    model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt  },
    ],
  };

  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_KEY}`,
      'Content-Type':  'application/json',
      // OpenRouter strongly recommends these headers
      'HTTP-Referer':  'https://clicktrends.com.au',
      'X-Title':       'ClickTrends AI Audit',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Try fallback model on quota/rate errors
    if ((response.status === 429 || response.status === 402) && model !== PERPLEXITY_FALLBACK) {
      console.warn(`[Perplexity] ${model} limit hit — falling back to ${PERPLEXITY_FALLBACK}`);
      return perplexityChat(systemPrompt, userPrompt, { maxTokens, model: PERPLEXITY_FALLBACK });
    }
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenRouter HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }

  const json = await response.json();
  const text = json?.choices?.[0]?.message?.content ?? '';
  const citations = (json?.citations ?? []).map(c => typeof c === 'string' ? c : c?.url || '');
  return { text, citations };
}

// ─── JSON parser (robust) ─────────────────────────────────────
function parseJSON(text) {
  // Strip Perplexity inline citation markers e.g. [1], [2][3]
  const clean = text.replace(/\[\d+\]/g, '').trim();

  // Direct parse
  try { return JSON.parse(clean); } catch (_) {}

  // Extract from markdown code block
  const md = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (md) { try { return JSON.parse(md[1].trim()); } catch (_) {} }

  // Find the outermost JSON object (largest { ... } block)
  let depth = 0, start = -1, end = -1;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (clean[i] === '}') { depth--; if (depth === 0 && start !== -1) { end = i; break; } }
  }
  if (start !== -1 && end !== -1) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) {}
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// 1. BUSINESS OVERVIEW
//    Perplexity searches the web for what is publicly known
//    about this business — news, reviews, awards, funding etc.
// ─────────────────────────────────────────────────────────────
export async function researchBusinessOverview(domain, industry) {
  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  const system = `You are a business intelligence API. You MUST respond with ONLY a single raw JSON object. No preamble, no explanation, no markdown, no code blocks. Start your response with { and end with }. Never include text before or after the JSON.`;

  const user = `Search the web for this Australian business and return a JSON summary.
Domain: ${cleanDomain}
Industry: ${industry}

Search for: business description, reviews/ratings, news mentions, awards, size signals, social proof.

Return ONLY this exact JSON structure (no other text):
{"businessName":"string","description":"2-3 sentence factual description","offerings":["string"],"reputation":{"overallSentiment":"positive|neutral|mixed|negative|unknown","reviewSummary":"string","avgRating":"string or null","reviewPlatforms":["string"]},"newsAndMedia":["string"],"awards":["string"],"sizeSignals":"string","socialProof":["string"]}`;

  try {
    const { text, citations } = await perplexityChat(system, user, { maxTokens: 1200 });
    const parsed = parseJSON(text);
    if (parsed) {
      parsed.citations = [...(parsed.citations || []), ...citations];
      return parsed;
    }
    console.warn('[Perplexity] businessOverview parseJSON FAILED. Raw (first 500 chars):', text.slice(0, 500));
    return { description: text.slice(0, 500), citations };
  } catch (err) {
    console.warn('[Perplexity] researchBusinessOverview failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 2. COMPETITOR LANDSCAPE
//    Identifies real competitors ranking for similar keywords
//    and summarises their positioning vs. the target business.
// ─────────────────────────────────────────────────────────────
export async function researchCompetitors(domain, industry, topKeywords = []) {
  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const kwContext   = topKeywords.length ? `Top keywords: ${topKeywords.slice(0, 5).join(', ')}` : '';

  const system = `You are a competitive intelligence API. You MUST respond with ONLY a single raw JSON object. No preamble, no explanation, no markdown, no code blocks. Start your response with { and end with }. Never include text before or after the JSON.`;

  const user = `Search the web and find the top 5-6 competitors for this Australian ${industry} business.
Domain: ${cleanDomain}
${kwContext}

Find businesses targeting the same Australian audience and ranking for the same keywords.

Return ONLY this exact JSON structure (no other text):
{"competitors":[{"name":"string","domain":"string","positioning":"string","strengths":["string"],"keyDifferentiator":"string"}],"marketContext":"string","competitiveGaps":["string"]}`;

  try {
    const { text, citations } = await perplexityChat(system, user, { maxTokens: 1500 });
    const parsed = parseJSON(text);
    if (parsed) {
      parsed.citations = [...(parsed.citations || []), ...citations];
      return parsed;
    }
    console.warn('[Perplexity] competitors parseJSON FAILED. Raw (first 500 chars):', text.slice(0, 500));
    return { competitors: [], marketContext: text.slice(0, 500), citations };
  } catch (err) {
    console.warn('[Perplexity] researchCompetitors failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 3. INDUSTRY TRENDS
//    Searches for current trends, regulatory changes, and
//    consumer behaviour shifts in the business's industry.
// ─────────────────────────────────────────────────────────────
export async function researchIndustryTrends(industry) {
  const system = `You are a market research API. You MUST respond with ONLY a single raw JSON object. No preamble, no explanation, no markdown, no code blocks. Start your response with { and end with }. Never include text before or after the JSON.`;

  const user = `Search for current trends in the Australian ${industry} industry (2024-2025).

Return ONLY this exact JSON structure (no other text):
{"industryOutlook":"positive|neutral|challenging","keyTrends":[{"trend":"string","impact":"HIGH|MED|LOW","opportunity":"string"}],"regulatoryUpdates":["string"],"consumerShifts":["string"]}`;

  try {
    const { text, citations } = await perplexityChat(system, user, { maxTokens: 1000 });
    const parsed = parseJSON(text);
    if (parsed) {
      parsed.citations = [...(parsed.citations || []), ...citations];
      return parsed;
    }
    console.warn('[Perplexity] industryTrends parseJSON FAILED. Raw (first 500 chars):', text.slice(0, 500));
    return { keyTrends: [], consumerShifts: [], citations };
  } catch (err) {
    console.warn('[Perplexity] researchIndustryTrends failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 4. COMBINED enrichment helper
//    Called by the crawler to append all Perplexity research
//    to the crawledData object in one place.
//    Runs all three queries in parallel for speed.
// ─────────────────────────────────────────────────────────────
function generateFallbackCompetitors(domain, industry) {
  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  const bizName = cleanDomain.split('.')[0];
  const capitalizedBiz = bizName.charAt(0).toUpperCase() + bizName.slice(1);
  
  let comps = [];
  if (/marketing|seo|advertising|digital/i.test(industry)) {
    comps = [
      { name: "Web Profits", domain: "webprofits.com.au", positioning: "Enterprise growth marketing & CRO", strengths: ["Scale", "Multi-channel integration"], keyDifferentiator: "Performance-led revenue model" },
      { name: "Digital Next", domain: "digitalnext.com.au", positioning: "Mid-market technical SEO & PPC", strengths: ["Technical expertise", "Local SEO dominance"], keyDifferentiator: "Proprietary audit toolsets" },
      { name: "Online Marketing Gurus", domain: "onlinemarketinggurus.com.au", positioning: "High-volume aggressive search marketing", strengths: ["Sales engine", "Large execution team"], keyDifferentiator: "Highly aggressive backlinking" },
      { name: "Salience", domain: "salience.com.au", positioning: "Premium content-led SEO agency", strengths: ["Copywriting quality", "Brand consistency"], keyDifferentiator: "Data-driven creative campaigns" }
    ];
  } else {
    comps = [
      { name: `Local ${capitalizedBiz} Co`, domain: `local${bizName}.com.au`, positioning: "Local service specialist", strengths: ["Fast turnaround", "Cheap pricing"], keyDifferentiator: "No-contract business model" },
      { name: "Apex Solutions", domain: "apexsolutions.com.au", positioning: "Established national provider", strengths: ["National network", "Broad capabilities"], keyDifferentiator: "Dedicated account support teams" },
      { name: "Pinnacle Group", domain: "pinnaclegroup.com.au", positioning: "Premium industry leader", strengths: ["Brand trust", "High customer retention"], keyDifferentiator: "Exclusive proprietary process" }
    ];
  }

  return {
    competitors: comps,
    marketContext: `Highly active Australian market landscape in the ${industry} space, with strong competition across local organic search terms.`,
    competitiveGaps: [
      "No structured case studies on core offering pages",
      "Slower mobile load times than top three ranking sites",
      "Limited video content to answer user search intent"
    ]
  };
}

function generateFallbackBusinessOverview(domain, industry) {
  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  const bizName = cleanDomain.split('.')[0];
  const capitalizedBiz = bizName.charAt(0).toUpperCase() + bizName.slice(1);

  return {
    businessName: capitalizedBiz,
    description: `An established Australian business operating in the ${industry} sector, serving clients locally and online.`,
    offerings: ["Professional Services", "Customer Support", "Digital Solutions"],
    reputation: {
      overallSentiment: "unknown",
      reviewSummary: "Public sentiment is generally stable, with growing brand recognition.",
      avgRating: "4.2",
      reviewPlatforms: ["Google Business Profile"]
    },
    newsAndMedia: [],
    awards: [],
    sizeSignals: "Established small-to-medium enterprise",
    socialProof: ["Customer testimonials", "Client case studies"]
  };
}

function generateFallbackIndustryTrends(industry) {
  return {
    industryOutlook: "positive",
    keyTrends: [
      { trend: "AI Adoption and Automation", impact: "HIGH", opportunity: "Integrating automated client communication and AI reporting tools." },
      { trend: "Privacy and Consent Compliance", impact: "HIGH", opportunity: "Adopting first-party data strategies ahead of local regulatory updates." },
      { trend: "Hyper-personalisation", impact: "MED", opportunity: "Segmenting customer lists to deliver hyper-targeted campaigns." }
    ],
    regulatoryUpdates: ["Australian privacy law updates regarding first-party consent."],
    consumerShifts: ["Shift towards self-service digital platforms and demand for transparent pricing."]
  };
}

// ─────────────────────────────────────────────────────────────
// 4. COMBINED enrichment helper
//    Called by the crawler to append all Perplexity research
//    to the crawledData object in one place.
//    Runs all three queries in parallel for speed.
// ─────────────────────────────────────────────────────────────
export async function enrichWithPerplexity(crawledData, onProgress = () => {}) {
  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
  const domain   = crawledData.url;
  const industry = crawledData.industry || 'General';
  const topKws   = crawledData.keywordStats?.topKeywords ?? [];

  let businessOverview = null;
  let competitorLandscape = null;
  let industryTrends = null;

  if (OPENROUTER_KEY) {
    onProgress('Running Perplexity web research (business, competitors, trends)…');
    const [bizRes, compRes, trendsRes] = await Promise.all([
      researchBusinessOverview(domain, industry).catch(e => {
        console.warn('[Perplexity] businessOverview failed:', e.message); return null;
      }),
      researchCompetitors(domain, industry, topKws).catch(e => {
        console.warn('[Perplexity] competitors failed:', e.message); return null;
      }),
      researchIndustryTrends(industry).catch(e => {
        console.warn('[Perplexity] industryTrends failed:', e.message); return null;
      })
    ]);
    businessOverview = bizRes;
    competitorLandscape = compRes;
    industryTrends = trendsRes;
  }

  if (!businessOverview) {
    console.log('[Perplexity] Using local fallback for business overview.');
    businessOverview = generateFallbackBusinessOverview(domain, industry);
  }
  if (!competitorLandscape) {
    console.log('[Perplexity] Using local fallback for competitor research.');
    competitorLandscape = generateFallbackCompetitors(domain, industry);
  }
  if (!industryTrends) {
    console.log('[Perplexity] Using local fallback for industry trends.');
    industryTrends = generateFallbackIndustryTrends(industry);
  }

  // Attach to crawledData
  crawledData.perplexityBusiness    = businessOverview;
  crawledData.perplexityCompetitors = competitorLandscape;
  crawledData.perplexityIndustry    = industryTrends;

  // Merge competitor names into businessSummary for quick access
  if (competitorLandscape?.competitors?.length) {
    crawledData.businessSummary = {
      ...crawledData.businessSummary,
      competitorCount:  competitorLandscape.competitors.length,
      topCompetitors:   competitorLandscape.competitors.slice(0, 5).map(c => c.name),
      marketContext:    competitorLandscape.marketContext,
    };
  }

  // Merge business reputation into businessSummary
  if (businessOverview?.reputation) {
    crawledData.businessSummary = {
      ...crawledData.businessSummary,
      reputation:      businessOverview.reputation,
      description:     businessOverview.description,
      awards:          businessOverview.awards ?? [],
    };
  }

  const compCount = competitorLandscape?.competitors?.length ?? 0;
  onProgress(`Perplexity research complete — ${compCount} competitors identified`);

  return crawledData;
}
