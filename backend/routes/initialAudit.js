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
      message: `Crawled ${pageCount} pages — ${kwCount} keywords found`,
      progress: 40,
      stats: {
        pages:    pageCount,
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
        pages:     pageCount,
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
async function runQuickAnalysis(crawledData, industry) {
  const homepage = crawledData.homepage || {};
  const meta = crawledData.metaSignals || {};

  const systemPrompt = `You are a senior digital marketing analyst conducting a rapid website audit.
Analyse the provided website data and return a JSON assessment.
Be specific, direct, and commercially useful. Write in Australian English.
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
  "scoreBreakdown": {
    "seo": <0-100>,
    "content": <0-100>,
    "technical": <0-100>,
    "conversion": <0-100>
  },
  "discoveries": [
    { "severity": "critical|warning|opportunity", "title": "<short title>", "detail": "<one sentence detail>" },
    { "severity": "critical|warning|opportunity", "title": "...", "detail": "..." },
    { "severity": "critical|warning|opportunity", "title": "...", "detail": "..." },
    { "severity": "critical|warning|opportunity", "title": "...", "detail": "..." },
    { "severity": "opportunity", "title": "...", "detail": "..." }
  ]
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
    
    const discoveries = [
      { severity: 'warning', title: 'AI web research unavailable', detail: 'Using local crawl signals. Configure OPENROUTER_API_KEY with credits for full live web analysis.' }
    ];
    if ((meta.missingMetaDescriptions || 0) > 0) {
      discoveries.push({ severity: 'warning', title: `${meta.missingMetaDescriptions} pages missing meta descriptions`, detail: 'Missing meta descriptions reduce search snippet click-through rates.' });
    }
    if ((meta.missingH1 || 0) > 0) {
      discoveries.push({ severity: 'warning', title: `${meta.missingH1} pages missing H1 tags`, detail: 'H1 tags signal key topic to search engines.' });
    }
    if ((meta.missingImageAlt || 0) > 0) {
      discoveries.push({ severity: 'warning', title: `${meta.missingImageAlt} images missing alt text`, detail: 'Alt text is required for accessibility and image search.' });
    }
    if (!meta.hasStructuredData) {
      discoveries.push({ severity: 'opportunity', title: 'No structured data detected', detail: 'Schema markup can gain rich snippets in Google.' });
    }

    return {
      score,
      businessName: crawledData.businessSummary?.name || extractDomain(crawledData.url),
      insight: 'Several technical and content improvements identified.',
      discoveries,
    };
  }
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch (_) {}
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) { try { return JSON.parse(match[1].trim()); } catch (_) {} }
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch (_) {} }
  return { score: 50, businessName: 'Your Business', insight: 'Analysis complete.', discoveries: [] };
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return url; }
}

export default router;
