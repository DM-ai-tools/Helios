// ============================================================
// backend/routes/status.js
// GET /api/audit/:id/status — Server-Sent Events (SSE) progress
// ============================================================

import { Router } from 'express';
import { sseClients } from './audit.js';
import { getAuditById, getAuditPlugins } from '../db/queries.js';
import redisClient from '../services/redisClient.js';

const router = Router();

/**
 * GET /api/audit/:id/status
 * Opens an SSE connection. Frontend listens for progress events.
 * Events: step | plugin-queued | plugin-running | plugin-complete | complete | error
 */
// NOTE: :id([^/]+) allows dots in UUIDs — Express strips everything after '.' by default.
router.get('/:id([^/]+)/status', async (req, res) => {
  const { id: auditId } = req.params;

  // Validate audit exists
  const audit = await getAuditById(auditId).catch(() => null);
  if (!audit) {
    return res.status(404).json({ error: 'Audit not found' });
  }

  // If audit is already complete, send complete event over SSE and close
  if (audit.status === 'complete') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({
      type: 'complete',
      auditId,
      overallScore: audit.overall_score,
      reportUrl: audit.report_url,
      docxUrl: audit.docx_url,
    })}\n\n`);
    res.end();
    return;
  }

  // If audit has failed, send error event over SSE and close
  if (audit.status === 'failed') {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({
      type: 'error',
      message: 'Audit execution failed. Please try again.',
      auditId,
    })}\n\n`);
    res.end();
    return;
  }

  // ── Set up SSE ────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Register client
  if (!sseClients[auditId]) sseClients[auditId] = [];
  sseClients[auditId].push(res);

  // Send initial state
  const pluginStatuses = await getAuditPlugins(auditId).catch(() => []);
  res.write(`data: ${JSON.stringify({
    type: 'connected',
    message: 'Connected to live audit stream',
    auditId,
    pluginStatuses,
  })}\n\n`);

  // Heartbeat to keep connection alive (every 15s)
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 15000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients[auditId] = (sseClients[auditId] || []).filter(c => c !== res);
    console.log(`[SSE] Client disconnected from audit: ${auditId}`);
  });
});

/**
 * GET /api/audit/:id — Get audit state (polling fallback)
 */
router.get('/:id([^/]+)', async (req, res) => {
  const auditId = req.params.id;

  try {
        const cachedDataStr = await redisClient.get(`audit_final_json:${auditId}`);
    if (cachedDataStr) {
      console.log(`[Status Route] Serving audit ${auditId} from temp cache`);
      return res.json(JSON.parse(cachedDataStr));
    }
    // Quietly fall back to database query without throwing noisy console logs
  } catch(e) {
    console.error(`[Status Route] Redis cache error:`, e);
  }

  const audit = await getAuditById(auditId).catch(() => null);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });

  const plugins = await getAuditPlugins(req.params.id).catch(() => []);

  // ── PLUGIN_META lookup for human-readable names ──────────────────
  // Plugin records in Redis only store plugin_id, NOT the human name.
  // We must map id → name here, same as the frontend PLUGIN_META table.
  const PLUGIN_NAMES = {
    'seo-audit':         'SEO Audit',
    'competitive-brief': 'Competitive Intelligence',
    'campaign-plan':     'Campaign Plan',
    'content-copy':      'Content & Copy',
    'email-sequence':    'Email Sequence',
    'brand-review':      'Brand Review',
  };

  // ── Build pluginOutputs — the full claude_output per plugin ──────
  // Each plugin's claude_output contains ALL sub-sections (detailedFindings,
  // legalAndComplianceFlags, revisedSections, voiceAndToneProfile, etc.)
  // that the report.html render functions need.
  const pluginOutputs = {};
  plugins.forEach(p => {
    if (p.claude_output) {
      try {
        pluginOutputs[p.plugin_id] = typeof p.claude_output === 'string'
          ? JSON.parse(p.claude_output)
          : p.claude_output;
      } catch (e) {
        console.error(`[Status Route] Failed to parse claude_output for plugin ${p.plugin_id}:`, e.message);
      }
    }
  });

  let synthesis = null;
  if (audit.synthesis) {
    try { synthesis = typeof audit.synthesis === 'string' ? JSON.parse(audit.synthesis) : audit.synthesis; } catch (e) {}
  }

  // Parse crawled data to expose page/keyword stats to the report
  let crawledStats = {};
  if (audit.crawled_data) {
    try {
      const cd = typeof audit.crawled_data === 'string' ? JSON.parse(audit.crawled_data) : audit.crawled_data;
      crawledStats = {
        pagesAudited: (cd.pages || []).length,
        stats: {
          pages:    (cd.pages || []).length,
          keywords: cd.keywordStats?.total ?? 0,
          ranked:   cd.keywordStats?.ranked ?? 0,
        },
      };
    } catch (e) {}
  }

  // Build plugins array with correct human-readable names and full summaries
  const pluginsArray = plugins.map(p => ({
    id:      p.plugin_id,
    name:    PLUGIN_NAMES[p.plugin_id] || p.plugin_id,
    status:  p.status,
    score:   p.score,
    summary: p.summary || (pluginOutputs[p.plugin_id]?.summary ?? ''),
  }));

  res.json({
    id: audit.id,
    status: audit.status,
    url: audit.url,
    industry: audit.industry,
    overallScore: audit.overall_score,
    executiveSummary: audit.executive_summary,
    synthesis,
    pluginOutputs,
    ...crawledStats,
    reportUrl: audit.report_url,
    docxUrl: audit.docx_url,
    publicToken: audit.public_token,
    createdAt: audit.created_at,
    completedAt: audit.completed_at,
    plugins: pluginsArray,
  });
});

/**
 * GET /api/audit/:id/debug — Full audit data dump (dev only)
 */
router.get('/:id([^/]+)/debug', async (req, res) => {
  const audit = await getAuditById(req.params.id).catch(() => null);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  const crawled = audit.crawled_data ? (typeof audit.crawled_data === 'string' ? JSON.parse(audit.crawled_data) : audit.crawled_data) : {};
  res.json({
    id: audit.id,
    status: audit.status,
    url: audit.url,
    industry: audit.industry,
    pages: crawled.pages?.length ?? 0,
    keywordStats: crawled.keywordStats ?? {},
    metaSignals: crawled.metaSignals ?? {},
    socialLinks: crawled.socialLinks ?? [],
    ctaText: crawled.ctaText ?? [],
    businessSummary: crawled.businessSummary ?? {},
    perplexityBusiness: crawled.perplexityBusiness ?? null,
    perplexityCompetitors: crawled.perplexityCompetitors ?? null,
    perplexityIndustry: crawled.perplexityIndustry ?? null,
    homepage: crawled.homepage ?? {},
  });
});

export default router;
