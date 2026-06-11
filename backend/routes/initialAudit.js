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
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'complete', ...entry.result })}\n\n`);
    res.end();
    return;
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
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

Return this exact JSON structure:
{
  "score": <number 0-100 reflecting overall digital marketing health>,
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
    const meta = crawledData.metaSignals || {};
    const total = meta.totalPages || 1;
    const issues = (meta.missingMetaDescriptions || 0) + (meta.missingH1 || 0);
    const score = Math.max(20, Math.round(100 - (issues / total) * 60));
    
    return {
      score,
      businessName: crawledData.businessSummary?.name || extractDomain(crawledData.url),
      insight: 'Several technical and content improvements identified.',
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

export default router;
