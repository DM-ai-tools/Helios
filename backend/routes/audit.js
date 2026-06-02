// ============================================================
// backend/routes/audit.js
// POST /api/audit/init — initialization route
// POST /api/audit/:id/analyze — analysis route
// ============================================================

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { upsertUser, createAudit, updateAuditStatus, updateAuditCrawledData,
         createAuditPlugins, updateAuditPlugin, finaliseAudit, getAuditById } from '../db/queries.js';
import { loadPlugins } from '../services/pluginLoader.js';
import { crawlWebsite } from '../services/crawler.js';
import { enrichWithDataForSEO } from '../services/dataforseo.js';
import { runAllPlugins, generateSynthesis, calculateOverallScore } from '../services/aiRunner.js';
import { buildReport } from '../services/reportBuilder.js';
import { sendAuditReport } from '../services/emailService.js';
import redisClient from '../services/redisClient.js';

const router = Router();

// In-memory SSE clients registry
// Format: { [auditId]: [res, res, ...] }
export const sseClients = {};

const emit = (auditId, type, data) => {
  const clients = sseClients[auditId] || [];
  const payload = JSON.stringify({ type, ...data, timestamp: Date.now() });
  clients.forEach(client => {
    try { client.write(`data: ${payload}\n\n`); } catch (_) {}
  });
  console.log(`[SSE:${auditId}] ${type}:`, data.message || data.step || '');
};

/**
 * POST /api/audit/init
 * Body: { url, industry, email }
 */
router.post('/init', async (req, res) => {
  const { url, industry, email } = req.body;

  // Validate required fields
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  try {
    // 1. Upsert user
    const userEmail = email || 'anonymous@clicktrends.com.au';
    const user = await upsertUser(userEmail);

    // 2. Create audit record
    const audit = await createAudit({ userId: user.id, url, industry });
    const auditId = audit.id;

    // 3. Respond immediately with auditId
    res.json({
      auditId,
      publicToken: audit.public_token,
      message: 'Initialization started. Connect to SSE endpoint for live progress.',
      statusUrl: `/api/audit/${auditId}/status`,
    });

    // 4. Run initialization pipeline asynchronously
    runInitPipeline({ auditId, url, industry });

  } catch (err) {
    console.error('[Audit Route] Error creating audit:', err);
    res.status(500).json({ error: 'Failed to create audit', detail: err.message });
  }
});

/**
 * POST /api/audit/:id/analyze
 * Body: { selectedPlugins: string[], email: string }
 */
router.post('/:id/analyze', async (req, res) => {
  const auditId = req.params.id;
  const { selectedPlugins = [], email } = req.body;

  const audit = await getAuditById(auditId);
  if (!audit) {
    return res.status(404).json({ error: 'Audit not found' });
  }

  // If crawled_data isn't ready yet (init pipeline still running),
  // wait up to 3 minutes for it to finish before starting analyze.
  let resolvedAudit = audit;
  if (!resolvedAudit.crawled_data) {
    const MAX_WAIT_MS   = 3 * 60 * 1000; // 3 minutes
    const POLL_INTERVAL = 3000;           // check every 3s
    const deadline      = Date.now() + MAX_WAIT_MS;

    while (!resolvedAudit.crawled_data && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      resolvedAudit = await getAuditById(auditId).catch(() => resolvedAudit);
    }

    if (!resolvedAudit.crawled_data) {
      return res.status(400).json({ error: 'Crawl timed out — please try again.' });
    }
  }

  // ── Reset audit state so plugin-scanning.html always waits for the new run ──
  // If this audit was previously complete, the old Redis cache would cause
  // plugin-scanning.html to see status=complete and jump straight to the old
  // report — skipping the new plugin run entirely.
  await updateAuditStatus(auditId, 'analyzing');
  try { await redisClient.del(`audit_final_json:${auditId}`); } catch (_) {}

  res.json({
    message: 'Deep scan started.',
    statusUrl: `/api/audit/${auditId}/status`,
  });

  const crawledData = typeof resolvedAudit.crawled_data === 'string' ? JSON.parse(resolvedAudit.crawled_data) : resolvedAudit.crawled_data;
  runAnalyzePipeline({ auditId, crawledData, url: resolvedAudit.url, industry: resolvedAudit.industry, email, selectedPlugins });
});


// ─── Async Initialization Pipeline ──────────────────────────────
async function runInitPipeline({ auditId, url, industry }) {
  try {
    emit(auditId, 'step', { step: 'crawling', message: `Crawling ${url}…`, progress: 15 });

    const crawledData = await crawlWebsite(url, (msg) => {
      emit(auditId, 'step', { step: 'crawling', message: msg, progress: 20 });
    });

    crawledData.industry = industry;

    // ── Keyword enrichment via Perplexity — keywords, on-page audit, SERP rankings ──
    emit(auditId, 'step', { step: 'crawling', message: 'Fetching keyword data via Perplexity…', progress: 25 });
    await enrichWithDataForSEO(crawledData, (msg) => {
      emit(auditId, 'step', { step: 'crawling', message: msg, progress: 27 });
    });
    console.log(`[Init] Perplexity keyword enrichment complete — ${crawledData.keywordStats?.total ?? 0} keywords`);


    await updateAuditCrawledData(auditId, crawledData);


    emit(auditId, 'step', {
      step: 'crawl-complete',
      message: `Crawled ${crawledData.pages.length} pages — ${crawledData.keywordStats?.total ?? 0} keywords found`,
      progress: 30,
      stats: {
        pages:    crawledData.pages.length,
        keywords: crawledData.keywordStats?.total ?? 0,
        ranked:   crawledData.keywordStats?.ranked ?? 0,
        signals:  Object.keys(crawledData.metaSignals || {}).length,
      },
    });

    // ── Quick scoring from crawled + Perplexity data ─────────────
    emit(auditId, 'step', { step: 'analysing', message: 'Scoring your digital presence…', progress: 50 });
    const quickScore = computeQuickScore(crawledData);

    emit(auditId, 'init-analysis', {
      score:        quickScore.score,
      businessName: crawledData.perplexityBusiness?.businessName
                    || crawledData.businessSummary?.name
                    || new URL(crawledData.url).hostname.replace(/^www\./, ''),
      insight:      quickScore.insight,
      discoveries:  quickScore.discoveries,
      competitors:  crawledData.perplexityCompetitors?.competitors?.length ?? 0,
      stats: {
        pages:    crawledData.pages.length,
        keywords: crawledData.keywordStats?.total ?? 0,
      },
    });

    emit(auditId, 'init-complete', { message: 'Initialization complete.' });

  } catch (err) {
    console.error(`[Init Pipeline] Fatal error for ${auditId}:`, err);
    emit(auditId, 'error', { message: `Init failed: ${err.message}` });
    await updateAuditStatus(auditId, 'failed');
  }
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


// ─── Async Analyze Pipeline ─────────────────────────────────────
async function runAnalyzePipeline({ auditId, crawledData, url, industry, email, selectedPlugins }) {
  const startTime = Date.now();

  try {
    // ── Immediately push crawl stats so the processing page shows real numbers ──
    // The crawl already happened during init — the analyze pipeline just reads the
    // stored data. Without this emit the keyword counter stays at 0.
    emit(auditId, 'step', {
      step: 'crawl-complete',
      message: `${crawledData.pages?.length || 0} pages crawled · ${crawledData.keywordStats?.total ?? 0} keywords found`,
      progress: 5,
      stats: {
        pages:    crawledData.pages?.length    || 0,
        keywords: crawledData.keywordStats?.total  ?? 0,
        ranked:   crawledData.keywordStats?.ranked ?? 0,
      },
    });

    emit(auditId, 'step', { step: 'loading-plugins', message: 'Loading AI modules…', progress: 5 });
    const plugins = await loadPlugins(selectedPlugins);

    if (plugins.length === 0) {
      emit(auditId, 'error', { message: 'No valid plugins could be loaded' });
      await updateAuditStatus(auditId, 'failed');
      return;
    }

    // Build a meta map of pluginId -> name for DB storage
    const pluginMeta = Object.fromEntries(plugins.map(p => [p.id, { name: p.name }]));
    await createAuditPlugins(auditId, plugins.map(p => p.id), pluginMeta);
    emit(auditId, 'step', { step: 'plugins-loaded', message: `${plugins.length} Claude AI modules ready`, progress: 10,
      plugins: plugins.map(p => ({ id: p.id, name: p.name })) });

    // Progress slots: 10% reserved for setup, 70% shared across plugins, 20% for scoring+synthesis+report
    const baseProgress = 10;
    const pluginProgressRange = 70;
    const progressPerPlugin = Math.floor(pluginProgressRange / plugins.length);
    let currentProgress = baseProgress;

    // Emit queued status for all plugins upfront
    for (const plugin of plugins) {
      emit(auditId, 'plugin-queued', { pluginId: plugin.id, pluginName: plugin.name });
    }

    // Run all plugins in parallel — each fires its own running/complete SSE events
    const pluginResults = await runAllPlugins(
      plugins,
      crawledData,
      // onProgress: MUST be synchronous — it is called fire-and-forget inside runAllPlugins.
      // Any async work (DB writes) must be done with their own .catch() to prevent
      // unhandled promise rejections that would crash the server and reset SSE connections.
      (msg) => {
        const matchedPlugin = plugins.find(p => msg.includes(p.name));
        if (!matchedPlugin) return;

        const isComplete = msg.toLowerCase().includes('complete') || msg.toLowerCase().includes('score:');

        if (!isComplete) {
          currentProgress = Math.min(currentProgress + Math.floor(progressPerPlugin * 0.3), 79);
          emit(auditId, 'plugin-running', {
            pluginId:   matchedPlugin.id,
            pluginName: matchedPlugin.name,
            message:    msg,
            progress:   currentProgress,
          });
          // Fire-and-forget DB write — errors logged but never thrown to caller
          updateAuditPlugin(auditId, matchedPlugin.id, { status: 'running', startedAt: true })
            .catch(e => console.error(`[SSE] updateAuditPlugin running failed:`, e.message));
        } else {
          currentProgress = Math.min(currentProgress + Math.ceil(progressPerPlugin * 0.7), 79);
          emit(auditId, 'plugin-complete', {
            pluginId:   matchedPlugin.id,
            pluginName: matchedPlugin.name,
            message:    msg,
            progress:   currentProgress,
          });
        }
      },
      // onPluginComplete: fires once per plugin with full result
      (result) => {
        emit(auditId, 'plugin-result', {
          pluginId:        result.pluginId,
          score:           result.score,
          recommendations: result.recommendations,
          summary:         result.summary,
        });
      }
    );

    // Persist each plugin result to DB
    for (const result of pluginResults) {
      await updateAuditPlugin(auditId, result.pluginId, {
        status:          result.error ? 'failed' : 'complete',
        score:           result.score,
        claudeOutput:    result.output,
        summary:         result.summary,
        recommendations: result.recommendations,
        errorMessage:    result.error || null,
        completedAt:     true,
      });
    }

    const overallScore = calculateOverallScore(pluginResults);
    emit(auditId, 'step', { step: 'scoring', message: 'Calculating overall score…', progress: 82, score: overallScore });

    emit(auditId, 'step', { step: 'synthesis', message: 'Claude is synthesising your full audit report…', progress: 85 });
    const synthesis = await generateSynthesis(pluginResults, crawledData, overallScore);

    emit(auditId, 'step', { step: 'building-report', message: 'Rendering audit document…', progress: 90 });
    const duration = Math.round((Date.now() - startTime) / 1000);

    // buildReport generates HTML/DOCX — wrap in try/catch so a DOCX failure
    // does not prevent finaliseAudit from marking the audit complete
    const _baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    let reportUrl = `${_baseUrl}/reports/${auditId}`;
    let docxUrl   = `${_baseUrl}/reports/${auditId}/download.docx`;
    try {
      const built = await buildReport(auditId, {
        url, industry, email,
        pagesAnalysed: crawledData.pages?.length || 0,
        duration,
      }, pluginResults, synthesis, overallScore);
      reportUrl = built.reportUrl;
      docxUrl   = built.docxUrl;
    } catch (buildErr) {
      console.error('[Analyze] buildReport failed (non-fatal):', buildErr.message);
    }

    // CREATE TEMP CACHE FOR FINAL OUTPUT
    const pluginOutputsObj = {};
    for (const r of pluginResults) {
      if (r.output) {
        // r.output is already a parsed JS object from runPlugin — use it directly
        pluginOutputsObj[r.pluginId] = typeof r.output === 'string'
          ? JSON.parse(r.output)
          : r.output;
      }
    }

    
    const finalCacheData = {
      id: auditId,
      status: 'complete',
      url,
      industry,
      overallScore,
      executiveSummary: synthesis.executiveSummary,
      synthesis,
      pluginOutputs: pluginOutputsObj,
      pagesAudited: crawledData.pages?.length || 0,
      stats: {
        pages:    crawledData.pages?.length || 0,
        keywords: crawledData.keywordStats?.total ?? 0,
        ranked:   crawledData.keywordStats?.ranked ?? 0,
      },
      reportUrl,
      docxUrl,
      plugins: pluginResults.map(p => ({
        id: p.pluginId,
        name: plugins.find(x => x.id === p.pluginId)?.name || p.pluginId,
        status: p.error ? 'failed' : 'complete',
        score: p.score,
        summary: p.summary,
      }))
    };
    
    try {
      // TTL matches the base audit:* key (7 days) so score-pillar data is
      // always available while the audit record itself is alive.
      await redisClient.setEx(`audit_final_json:${auditId}`, 604800, JSON.stringify(finalCacheData));
      console.log(`[Analyze Pipeline] Saved final output to temp cache for ${auditId}`);
    } catch(e) {
      console.error(`[Analyze Pipeline] Failed to save temp cache for ${auditId}:`, e);
    }

    // ALWAYS finalise — this sets status="complete" which the polling frontend reads
    await finaliseAudit(auditId, {
      overallScore,
      executiveSummary: synthesis.executiveSummary,
      reportUrl,
      docxUrl,
      synthesisJSON: JSON.stringify(synthesis),
    });

    emit(auditId, 'step', { step: 'emailing', message: 'Delivering your audit to inbox…', progress: 95 });

    if (email) {
      try {
        await sendAuditReport({
          to: email,
          businessName: crawledData.businessSummary?.name || url,
          reportUrl,
          docxUrl,
          overallScore,
          executiveSummary: synthesis.executiveSummary,
        });
      } catch (emailErr) {
        console.error('[Analyze] Email send failed (non-fatal):', emailErr.message);
      }
    }

    // Use a frontend-friendly report URL (the report.html page with auditId query param)
    const frontendReportUrl = `report.html?auditId=${auditId}`;

    emit(auditId, 'complete', {
      message:      'Audit complete!',
      progress:     100,
      auditId,
      overallScore,
      reportUrl:    frontendReportUrl,   // → report.html?auditId=...
      docxUrl,
      duration,
      pagesAudited: crawledData.pages?.length || 0,
    });

  } catch (err) {
    console.error(`[Analyze Pipeline] Fatal error for ${auditId}:`, err);
    emit(auditId, 'error', { message: `Audit failed: ${err.message}` });
    await updateAuditStatus(auditId, 'failed');
  }
}

export default router;
