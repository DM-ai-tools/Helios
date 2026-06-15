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
import { runQuickAnalysis } from './initialAudit.js';
import Anthropic from '@anthropic-ai/sdk';

const router = Router();

// In-memory SSE clients registry
// Format: { [auditId]: [res, res, ...] }
export const sseClients = {};

/**
 * GET /api/audit/history
 * Fetch user's audit history
 */
router.get('/history', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const query = `
      SELECT id, url, industry, status, overall_score, created_at, completed_at
      FROM audits
      WHERE user_id = $1
      ORDER BY created_at DESC
    `;
    const { pool } = await import('../db/db.js');
    const { rows } = await pool.query(query, [userId]);
    res.json(rows);
  } catch (err) {
    console.error('[Audit History] Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

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
 * Body: { url, industry }
 */
router.post('/init', async (req, res) => {
  const { url, industry } = req.body;

  // Validate required fields
  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  try {
    // 1. Get user from JWT middleware
    const user = req.user; // populated by requireAuthAPI middleware

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
// NOTE: Express truncates route params at '.' by default (treats them as file extensions).
// Using a regex suffix :id([^/]+) forces Express to capture the full UUID including any dots.
router.post('/:id([^/]+)/analyze', async (req, res) => {
  const auditId = req.params.id;
  const { selectedPlugins = [], campaignInputs } = req.body;
  const email = req.user?.email || 'anonymous@clicktrends.com.au';

  const audit = await getAuditById(auditId);
  if (!audit) {
    return res.status(404).json({ error: 'Audit not found' });
  }

  // Validation: campaignInputs are now completely optional.

  // ── Reset audit state so plugin-scanning.html always waits for the new run ──
  // If this audit was previously complete, the old Redis cache would cause
  // plugin-scanning.html to see status=complete and jump straight to the old
  // report — skipping the new plugin run entirely.
  await updateAuditStatus(auditId, 'running');
  try { await redisClient.del(`audit_final_json:${auditId}`); } catch (_) {}

  res.json({
    message: 'Deep scan started.',
    statusUrl: `/api/audit/${auditId}/status`,
  });

  // Run the wait and pipeline in the background
  (async () => {
    try {
      let resolvedAudit = audit;
      if (!resolvedAudit.crawled_data) {
        emit(auditId, 'step', { step: 'waiting', message: 'Waiting for website crawl to finish…', progress: 48 });
        const MAX_WAIT_MS   = 3 * 60 * 1000;
        const POLL_INTERVAL = 3000;
        const deadline      = Date.now() + MAX_WAIT_MS;

        while (!resolvedAudit.crawled_data && Date.now() < deadline) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL));
          resolvedAudit = await getAuditById(auditId).catch(() => resolvedAudit);
        }

        if (!resolvedAudit.crawled_data) {
          emit(auditId, 'error', { message: 'Crawl timed out before analysis could start.' });
          await updateAuditStatus(auditId, 'failed');
          return;
        }
      }

      const crawledData = typeof resolvedAudit.crawled_data === 'string' ? JSON.parse(resolvedAudit.crawled_data) : resolvedAudit.crawled_data;

      // Merge campaign inputs into crawledData so they persist in DB + flow to plugins
      if (campaignInputs) {
        crawledData.campaignInputs = campaignInputs;
        // Persist to DB so reports can be regenerated with original inputs
        await updateAuditCrawledData(auditId, crawledData);
      }

      runAnalyzePipeline({ auditId, crawledData, url: resolvedAudit.url, industry: resolvedAudit.industry, email, selectedPlugins });
    } catch (err) {
      console.error(`[Analyze Queue] Error for ${auditId}:`, err);
      emit(auditId, 'error', { message: `Analyze setup failed: ${err.message}` });
      await updateAuditStatus(auditId, 'failed');
    }
  })();
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
      message: `Crawled ${crawledData.totalPages || crawledData.pages.length} pages — ${crawledData.keywordStats?.total ?? 0} keywords found`,
      progress: 30,
      stats: {
        pages:    crawledData.totalPages || crawledData.pages.length,
        keywords: crawledData.keywordStats?.total ?? 0,
        ranked:   crawledData.keywordStats?.ranked ?? 0,
        signals:  Object.keys(crawledData.metaSignals || {}).length,
      },
    });

    // ── AI Consultant Quick Analysis ─────────────
    emit(auditId, 'step', { step: 'analysing', message: 'Generating preliminary insights…', progress: 50 });
    const aiAnalysis = await runQuickAnalysis(crawledData, industry);

    emit(auditId, 'init-analysis', {
      score:              aiAnalysis.score,
      businessName:       aiAnalysis.businessName,
      insight:            aiAnalysis.insight,
      businessInsights:   aiAnalysis.businessInsights || [],
      seoInsights:        aiAnalysis.seoInsights || [],
      contentInsights:    aiAnalysis.contentInsights || [],
      conversionInsights: aiAnalysis.conversionInsights || [],
      technicalInsights:  aiAnalysis.technicalInsights || [],
      topOpportunities:   aiAnalysis.topOpportunities || [],
      predictedEstimates: aiAnalysis.predictedEstimates || {},
      stats: {
        pages:    crawledData.totalPages || crawledData.pages.length,
        keywords: crawledData.keywordStats?.total ?? 0,
      },
      crawledDataSummary: {
        metaSignals: crawledData.metaSignals,
        socialLinks: crawledData.socialLinks,
        ctaText: crawledData.ctaText,
        headings: crawledData.headings,
        contentTypes: crawledData.contentTypes,
        perplexityBusiness: crawledData.perplexityBusiness,
        perplexityCompetitors: crawledData.perplexityCompetitors
      }
    });

    emit(auditId, 'init-complete', { message: 'Initialization complete.' });

  } catch (err) {
    console.error(`[Init Pipeline] Fatal error for ${auditId}:`, err);
    emit(auditId, 'error', { message: `Init failed: ${err.message}` });
    await updateAuditStatus(auditId, 'failed');
  }
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
      message: `${crawledData.totalPages || crawledData.pages?.length || 0} pages crawled · ${crawledData.keywordStats?.total ?? 0} keywords found`,
      progress: 5,
      stats: {
        pages:    crawledData.totalPages || crawledData.pages?.length    || 0,
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
    crawledData._auditId = auditId; // allow aiRunner to save implementationChanges per plugin
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
        pagesAnalysed: crawledData.totalPages || crawledData.pages?.length || 0,
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
      pagesAudited: crawledData.totalPages || crawledData.pages?.length || 0,
      stats: {
        pages:    crawledData.totalPages || crawledData.pages?.length || 0,
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
      pagesAudited: crawledData.totalPages || crawledData.pages?.length || 0,
    });

  } catch (err) {
    console.error(`[Analyze Pipeline] Fatal error for ${auditId}:`, err);
    emit(auditId, 'error', { message: `Audit failed: ${err.message}` });
    await updateAuditStatus(auditId, 'failed');
  }
}

/**
 * POST /api/audit/:id/regenerate-email
 * Regenerate an individual email using Claude based on user prompt
 */
router.post('/:id([^/]+)/regenerate-email', async (req, res) => {
  const { id: auditId } = req.params;
  const { emailIndex, emailData, prompt } = req.body;

  if (!emailData || !prompt) {
    return res.status(400).json({ error: 'Missing email data or prompt' });
  }

  try {
    const systemPrompt = `You are an elite marketing copywriter. You are rewriting an email for an AI Marketing Audit tool.
The user has provided a prompt to modify the email content.
Keep the same general format (subject, preview text, body paragraphs, CTA).
Return ONLY valid JSON matching this structure:
{
  "subject": "The new subject line",
  "previewText": "The new preview text",
  "bodyCopy": "The new body copy (use plain text with \\n\\n for paragraphs)",
  "ctaText": "The new CTA button text",
  "ctaUrl": "The new CTA URL (keep the same if not instructed otherwise)"
}`;

    const userPrompt = `Here is the current email data:
Subject: ${emailData.userSubject || emailData.subject}
Preview Text: ${emailData.userPreviewText || emailData.previewText}
CTA Text: ${emailData.userCtaText || emailData.ctaText}
CTA URL: ${emailData.userCtaUrl || emailData.ctaUrl}
Body:
${emailData.bodyCopy}

Here is the instruction on how to modify it:
"${prompt}"

Rewrite the email accordingly. Ensure the tone fits a professional B2B/B2C email.`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: '{' }
      ]
    });
    
    const rawOutput = '{' + (message.content[0]?.text || '');
    const generated = JSON.parse(rawOutput);
    
    // Validate output
    if (!generated || !generated.subject || !generated.bodyCopy) {
      throw new Error('Claude returned invalid JSON or missing fields');
    }

    res.json(generated);
  } catch (err) {
    console.error(`[Regenerate Email] Failed for ${auditId} index ${emailIndex}:`, err);
    res.status(500).json({ error: 'Failed to regenerate email. Please try again.' });
  }
});

export default router;
