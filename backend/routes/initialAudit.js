// ============================================================
// backend/routes/initialAudit.js
// POST /api/audit/initial  — quick crawl + Perplexity pre-score
// GET  /api/audit/initial/:id/status — SSE progress stream
// ============================================================

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { crawlWebsite } from '../services/crawler.js';

const router = Router();

// In-memory store for initial audits (lightweight, no DB needed)
const initialAudits = {};   // { [preAuditId]: { status, result, clients[] } }

// ─── SSE helper ───────────────────────────────────────────────
function emit(preAuditId, type, data) {
  const entry = initialAudits[preAuditId];
  if (!entry) return;
  const payload = JSON.stringify({ type, ...data, ts: Date.now() });
  (entry.clients || []).forEach(res => {
    try { res.write(`data: ${payload}\n\n`); } catch (_) {}
  });
  console.log(`[InitialAudit:${preAuditId}] ${type}:`, data.message || '');
}

// ─── POST /api/audit/initial ───────────────────────────────────
router.post('/initial', async (req, res) => {
  const { url, industry = 'General', email } = req.body;

  if (!url) return res.status(400).json({ error: 'url is required' });

  const preAuditId = uuidv4();
  initialAudits[preAuditId] = { status: 'running', result: null, clients: [] };

  // Respond immediately with ID
  res.json({ preAuditId, statusUrl: `/api/audit/initial/${preAuditId}/status` });

  // Run async
  runInitialAudit(preAuditId, url, industry, email);
});

// ─── GET /api/audit/initial/:id/status (SSE) ──────────────────
router.get('/initial/:id/status', (req, res) => {
  const { id } = req.params;
  const entry = initialAudits[id];

  if (!entry) return res.status(404).json({ error: 'Pre-audit not found' });

  // If already complete, send result immediately as JSON
  if (entry.status === 'complete') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    req.socket.setTimeout(0);
    req.socket.setKeepAlive(true);
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'complete', ...entry.result })}\n\n`);
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  req.socket.setTimeout(0);
  req.socket.setKeepAlive(true);
  res.flushHeaders();

  entry.clients.push(res);

  res.write(`data: ${JSON.stringify({ type: 'connected', preAuditId: id })}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    if (initialAudits[id]) {
      initialAudits[id].clients = initialAudits[id].clients.filter(c => c !== res);
    }
  });
});

// ─── Initial Audit Pipeline ────────────────────────────────────
async function runInitialAudit(preAuditId, url, industry, email) {
  try {
    // Step 1: Crawl
    emit(preAuditId, 'step', { step: 'crawling', message: 'Crawling your website…', progress: 10 });

    const crawledData = await crawlWebsite(url, (msg) => {
      emit(preAuditId, 'step', { step: 'crawling', message: msg, progress: 20 });
    });

    const pageCount   = crawledData.pages.length;
    const kwStats     = crawledData.keywordStats ?? {};
    const kwCount     = kwStats.total ?? 0;

    emit(preAuditId, 'crawl-complete', {
      message: `Crawled ${crawledData.totalPages || pageCount} pages — ${kwCount} keywords found`,
      progress: 40,
      stats: {
        pages:    crawledData.totalPages || pageCount,
        keywords: kwCount,
        ranked:   kwStats.ranked ?? 0,
      },
    });

    // Step 2: Quick Perplexity analysis
    emit(preAuditId, 'step', {
      step: 'analysing',
      message: 'Perplexity is analysing your site…',
      progress: 55,
    });

    const claudeResult = await runQuickAnalysis(crawledData, industry);

    emit(preAuditId, 'step', {
      step: 'scoring',
      message: 'Calculating preliminary score…',
      progress: 85,
      score: claudeResult.score,
    });

    // Step 3: Complete
    const result = {
      preAuditId,
      url,
      industry,
      email,
      score: claudeResult.score,
      businessName: claudeResult.businessName || crawledData.businessSummary?.name || extractDomain(url),
      insight: claudeResult.insight,
      discoveries: claudeResult.discoveries || [],
      stats: {
        pages:     crawledData.totalPages || pageCount,
        keywords:  kwCount,
        ranked:    kwStats.ranked ?? 0,
        quickWins: (claudeResult.discoveries || []).length,
      },
      crawledData: {
        // Only pass what the next page needs — don't expose full crawl
        url: crawledData.url,
        pagesCount: pageCount,
        metaSignals: crawledData.metaSignals,
        businessSummary: crawledData.businessSummary,
      },
    };

    initialAudits[preAuditId].status = 'complete';
    initialAudits[preAuditId].result = result;

    emit(preAuditId, 'complete', { ...result, progress: 100, message: 'Initial analysis complete!' });

    // Clean up after 30 minutes
    setTimeout(() => { delete initialAudits[preAuditId]; }, 30 * 60 * 1000);

  } catch (err) {
    console.error(`[InitialAudit] Error for ${preAuditId}:`, err);
    emit(preAuditId, 'error', { message: err.message });
    if (initialAudits[preAuditId]) initialAudits[preAuditId].status = 'failed';
  }
}

// ─── Quick Perplexity Analysis ─────────────────────────────────────
export async function runQuickAnalysis(crawledData, industry) {
  const homepage = crawledData.homepage || {};
  const meta = crawledData.metaSignals || {};

  const systemPrompt = `You are a senior digital marketing analyst conducting a rapid website audit.
Analyze ONLY the data collected during the initial crawl and generate useful, engaging, business-focused insights.
IMPORTANT RULES:
1. Use only information available from the crawl. Do not invent findings.
2. Do not make definitive claims. Use phrases such as "appears to", "may indicate", "potentially", "preliminary analysis suggests".
3. Insights should feel like observations from an experienced consultant. Keep them concise and easy to scan.
4. Prioritize business value over technical jargon.
5. Return 10-20 high-quality preliminary insights that provide immediate value while users wait for the complete audit report.
OUTPUT: Valid JSON only — no markdown, no explanation outside the JSON.`;

  const calculated = computeQuickScore(crawledData);

  const userPrompt = `Website: ${crawledData.url}
Industry: ${industry}
Pages crawled: ${crawledData.pages.length}
Business name (from title): ${crawledData.businessSummary?.name || 'Unknown'}
Homepage title: ${homepage.title || 'Missing'}
Homepage H1: ${(homepage.h1 || []).join(', ') || 'Missing'}
Meta description: ${homepage.metaDescription || 'Missing'}
Has schema markup: ${meta.hasStructuredData ? 'Yes' : 'No'}
Missing meta descriptions: ${meta.missingMetaDescriptions || 0}/${meta.totalPages || 0} pages
Missing H1 tags: ${meta.missingH1 || 0} pages
Missing image alt text: ${meta.missingImageAlt || 0} images
Social links found: ${(crawledData.socialLinks || []).length}
CTAs found: ${(crawledData.ctaText || []).slice(0, 5).join(', ') || 'None detected'}
Sample headings: ${(crawledData.headings || []).slice(0, 6).map(h => h.text).join(' | ') || 'None'}
Content types: ${(crawledData.contentTypes || []).join(', ') || 'Standard pages only'}
Keywords found (Perplexity): ${crawledData.keywordStats?.total ?? 0}
Top competitors (Perplexity): ${(crawledData.businessSummary?.topCompetitors || []).join(', ') || 'Not researched'}
Business reputation: ${crawledData.businessSummary?.reputation?.overallSentiment ?? 'Unknown'}
Market context: ${crawledData.businessSummary?.marketContext ?? 'Not available'}

CRITICAL INSTRUCTION:
The overall health score has been mathematically calculated as: ${calculated.score}.
You MUST return EXACTLY this number in the "score" field of your JSON.
For the "insight" field, you may use or refine this mathematically-derived insight: "${calculated.insight}"

Return this exact JSON structure:
{
  "score": ${calculated.score},
  "businessName": "<clean business name>",
  "insight": "<one punchy sentence summarising the site's biggest opportunity>",
  "businessInsights": ["insight 1", "insight 2"],
  "seoInsights": ["insight 1", "insight 2"],
  "contentInsights": ["insight 1", "insight 2"],
  "conversionInsights": ["insight 1", "insight 2"],
  "technicalInsights": ["insight 1", "insight 2"],
  "topOpportunities": ["opportunity 1", "opportunity 2"],
  "predictedEstimates": {
    "seoReadiness": "72-80",
    "contentQuality": "68-75",
    "technicalHealth": "80-88",
    "conversionReadiness": "65-78",
    "brandConsistency": "75-85"
  }
}`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://clicktrends.com.au',
        'X-Title': 'ClickTrends AI Audit'
      },
      body: JSON.stringify({
        model: 'perplexity/sonar-pro',
        max_tokens: 1500,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`OpenRouter HTTP ${response.status}`);
    }

    const data = await response.json();
    const text = data.choices[0]?.message?.content || '{}';
    return parseJSON(text);

  } catch (err) {
    console.error('[InitialAudit] Perplexity error:', err.message);
    const calculated = computeQuickScore(crawledData);
    
    return {
      score: calculated.score,
      businessName: crawledData.businessSummary?.name || extractDomain(crawledData.url),
      insight: calculated.insight,
      businessInsights: ['The website appears to focus on local or online services.', 'Further analysis may reveal deeper customer segment focus.'],
      seoInsights: [
        ((meta.missingMetaDescriptions || 0) > 0 ? `Several pages may benefit from stronger metadata (${meta.missingMetaDescriptions} missing).` : 'Most pages appear to have metadata.'),
        ((meta.missingH1 || 0) > 0 ? `Content hierarchy appears to be missing H1 tags on several pages.` : 'Content hierarchy appears structured.')
      ],
      contentInsights: ['Content depth will be fully assessed during the deep scan.', 'Calls-to-action appear on several pages.'],
      conversionInsights: ['Conversion paths appear straightforward.', 'Additional conversion opportunities may exist.'],
      technicalInsights: [
        ((meta.missingImageAlt || 0) > 0 ? 'Image accessibility could potentially be improved.' : 'Images appear to have accessible alt text.'),
        (!meta.hasStructuredData ? 'Schema markup does not appear to be present.' : 'Schema markup detected.')
      ],
      topOpportunities: ['Enhance metadata coverage.', 'Strengthen conversion-focused content.'],
      predictedEstimates: {
        seoReadiness: '65-75', contentQuality: '60-70', technicalHealth: '70-80', conversionReadiness: '65-75', brandConsistency: '75-85'
      }
    };
  }
}

function parseJSON(text) {
  let cleanText = text.trim();
  
  try { return JSON.parse(cleanText); } catch (_) {}
  
  const match = cleanText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) { try { return JSON.parse(match[1].trim()); } catch (_) {} }
  
  const obj = cleanText.match(/\{[\s\S]*\}/);
  if (obj) { 
    try { return JSON.parse(obj[0]); } catch (_) {} 
  }
  
  console.warn('[InitialAudit] JSON parse failed. Attempting regex extraction. Raw text:', text);
  
  const scoreMatch = cleanText.match(/"score"\s*:\s*(\d+)/i);
  const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 50;
  
  const insightMatch = cleanText.match(/"insight"\s*:\s*"([^"]+)"/i);
  const insight = insightMatch ? insightMatch[1] : 'Several technical and content improvements identified.';

  const extractArray = (key) => {
    try {
      const regex = new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)\\]`, 'i');
      const arrMatch = cleanText.match(regex);
      if (!arrMatch) return [];
      const strings = arrMatch[1].match(/"([^"]+)"/g);
      return strings ? strings.map(s => s.replace(/(^"|"$)/g, '')) : [];
    } catch (e) { return []; }
  };

  return {
    score,
    businessName: 'Your Business',
    insight,
    businessInsights: extractArray('businessInsights'),
    seoInsights: extractArray('seoInsights'),
    contentInsights: extractArray('contentInsights'),
    conversionInsights: extractArray('conversionInsights'),
    technicalInsights: extractArray('technicalInsights'),
    topOpportunities: extractArray('topOpportunities'),
    predictedEstimates: {}
  };
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return url; }
}

// ── Quick score (positive model — starts at 0, max 100) ──────────────
function computeQuickScore(data) {
  const meta   = data.metaSignals || {};
  const total  = Math.max(meta.totalPages || 1, 1);
  const pages  = data.pages || [];
  const biz    = data.perplexityBusiness  || {};
  const comp   = data.perplexityCompetitors || {};
  const trends = data.perplexityIndustry  || {};

  let score = 0;
  const discoveries = [];

  // ── CATEGORY 1: On-Page SEO (35 pts) ────────────────────────────
  // Meta descriptions (0–10)
  const metaScore = Math.round((1 - (meta.missingMetaDescriptions || 0) / total) * 10);
  score += metaScore;
  if ((meta.missingMetaDescriptions || 0) > 0)
    discoveries.push({ severity: 'warning', title: `${meta.missingMetaDescriptions} pages missing meta descriptions`, detail: 'Missing meta descriptions reduce click-through rates from search results.' });

  // Title tags (0–8)
  const titleScore = Math.round((1 - (meta.missingTitles || 0) / total) * 8);
  score += titleScore;

  // H1 tags (0–8)
  const h1Score = Math.round((1 - (meta.missingH1 || 0) / total) * 8);
  score += h1Score;
  if ((meta.missingH1 || 0) > 0)
    discoveries.push({ severity: 'warning', title: `${meta.missingH1} pages missing H1 tags`, detail: 'H1 tags signal page topic to Google and should be on every page.' });

  // Image alt text (0–9) — estimate total images from pages
  const totalImages = pages.reduce((acc, p) => acc + (p.images?.length ?? 0), 0);
  const missingAlt  = meta.missingImageAlt || 0;
  const altRatio    = totalImages > 0 ? Math.max(0, 1 - missingAlt / totalImages) : (missingAlt === 0 ? 1 : 0.5);
  const altScore    = Math.round(altRatio * 9);
  score += altScore;
  if (missingAlt > 0)
    discoveries.push({ severity: 'warning', title: `${missingAlt} images missing alt text`, detail: 'Alt text is critical for accessibility and image-search SEO.' });

  // ── CATEGORY 2: Technical SEO (25 pts) ──────────────────────────
  // Structured data (0–10)
  if (meta.hasStructuredData) {
    score += 10;
  } else {
    discoveries.push({ severity: 'opportunity', title: 'No structured data (schema.org) detected', detail: 'Schema markup can earn rich snippets and lift click-through rates by up to 30%.' });
  }

  // Canonical tag coverage (0–8)
  const [canonCovered, canonTotal] = (meta.canonicalCoverage || '0/1').split('/').map(Number);
  const canonScore = Math.round((canonCovered / Math.max(canonTotal, 1)) * 8);
  score += canonScore;
  if (canonCovered < canonTotal)
    discoveries.push({ severity: 'warning', title: `${canonTotal - canonCovered} pages missing canonical tags`, detail: 'Canonical tags prevent duplicate-content penalties from Google.' });

  // Internal linking depth (0–7) — proxy: number of pages crawled
  const linkScore = pages.length >= 10 ? 7 : pages.length >= 5 ? 5 : pages.length >= 3 ? 3 : 1;
  score += linkScore;

  // ── CATEGORY 3: Content & UX (20 pts) ───────────────────────────
  // Social media presence (0–8): 2 pts per platform, max 8
  const socialPlatforms = new Set(
    (data.socialLinks || []).map(l => {
      if (/facebook/i.test(l))   return 'facebook';
      if (/instagram/i.test(l))  return 'instagram';
      if (/linkedin/i.test(l))   return 'linkedin';
      if (/youtube/i.test(l))    return 'youtube';
      if (/twitter|x\.com/i.test(l)) return 'twitter';
      if (/tiktok/i.test(l))    return 'tiktok';
      return null;
    }).filter(Boolean)
  );
  const socialScore = Math.min(8, socialPlatforms.size * 2);
  score += socialScore;
  if (socialPlatforms.size === 0)
    discoveries.push({ severity: 'opportunity', title: 'No social media links detected', detail: 'Linking to active social profiles builds trust and supports brand searches.' });

  // CTAs present (0–6)
  const ctaScore = (data.ctaText?.length || 0) >= 3 ? 6 : (data.ctaText?.length || 0) > 0 ? 3 : 0;
  score += ctaScore;

  // Content variety (0–6): blog, case studies, video, FAQ etc.
  const contentTypeScore = Math.min(6, (data.contentTypes?.length || 0) * 2);
  score += contentTypeScore;
  if ((data.contentTypes?.length || 0) === 0)
    discoveries.push({ severity: 'opportunity', title: 'No content marketing detected', detail: 'Sites with blogs or case studies rank for 3× more keywords on average.' });

  // ── CATEGORY 4: Reputation & Trust (15 pts) ─────────────────────
  // Online reputation sentiment (0–10)
  const sentiment = biz?.reputation?.overallSentiment || 'unknown';
  const sentimentMap = { positive: 10, neutral: 6, mixed: 4, unknown: 3, negative: 0 };
  const repScore = sentimentMap[sentiment] ?? 3;
  score += repScore;
  if (sentiment === 'positive')
    discoveries.push({ severity: 'opportunity', title: 'Strong online reputation', detail: biz.reputation?.reviewSummary || 'Positive sentiment detected — leverage this in marketing copy.' });
  else if (sentiment === 'negative')
    discoveries.push({ severity: 'critical', title: 'Negative online reputation detected', detail: biz.reputation?.reviewSummary || 'Negative reviews found — address before scaling paid traffic.' });
  else if (sentiment === 'unknown')
    discoveries.push({ severity: 'opportunity', title: 'No reputation signals found online', detail: 'Actively collecting Google reviews builds trust and improves local rankings.' });

  // Awards & recognition (0–5)
  const awardScore = (biz?.awards?.length || 0) > 0 ? 5 : 0;
  score += awardScore;

  // ── CATEGORY 5: Competitive Readiness (5 pts) ───────────────────
  // Competitive gaps identified (0–5)
  const gapScore = (comp?.competitiveGaps?.length || 0) > 0 ? 5 : 0;
  score += gapScore;
  if ((comp?.competitiveGaps?.length || 0) > 0)
    discoveries.push({ severity: 'opportunity', title: 'Competitive gap identified', detail: comp.competitiveGaps[0] });

  // Industry trends (discovery only, no score change)
  if (trends?.keyTrends?.length > 0) {
    const topTrend = trends.keyTrends.find(t => t.impact === 'HIGH') || trends.keyTrends[0];
    if (topTrend?.opportunity)
      discoveries.push({ severity: 'opportunity', title: `Industry trend: ${topTrend.trend}`, detail: topTrend.opportunity });
  }

  // Competitor count context
  const compCount = comp?.competitors?.length ?? 0;
  if (compCount >= 5)
    discoveries.push({ severity: 'warning', title: `High competition — ${compCount} direct competitors identified`, detail: 'Strong differentiation and content depth are essential to stand out.' });

  // Clamp 0–100
  score = Math.max(0, Math.min(100, score));

  const insight = score >= 75 ? 'Strong digital foundation — focused improvements can make you the market leader.' :
                  score >= 50 ? 'Solid base with clear SEO and content gaps to close.' :
                  score >= 30 ? 'Significant issues identified — fixing these will meaningfully improve search visibility.' :
                  'Major foundational gaps across SEO, content, and reputation — high priority action required.';

  return { score, insight, discoveries: discoveries.slice(0, 6) };
}

export default router;
