// ============================================================
// backend/db/queries.js — Redis-only data layer
// ============================================================
import { v4 as uuidv4 } from 'uuid';
import redisClient from '../services/redisClient.js';

const AUDIT_TTL  = 60 * 60 * 24 * 7;  // 7 days
const PLUGIN_TTL = 60 * 60 * 24 * 7;

// ─── Helpers ──────────────────────────────────────────────────
async function redisGet(key) {
  const val = await redisClient.get(key);
  return val ? JSON.parse(val) : null;
}

async function redisSet(key, obj, ttl = AUDIT_TTL) {
  await redisClient.setEx(key, ttl, JSON.stringify(obj));
}

// ─── Users ────────────────────────────────────────────────────
export async function upsertUser(email) {
  const key = `user:${email}`;
  let user = await redisGet(key);
  if (!user) {
    user = { id: uuidv4(), email, createdAt: new Date().toISOString() };
    await redisSet(key, user);
  }
  return user;
}

// ─── Audits ───────────────────────────────────────────────────
export async function createAudit({ userId, url, industry }) {
  const id = uuidv4();
  const public_token = uuidv4();
  const audit = {
    id,
    user_id: userId,
    url,
    industry,
    status: 'pending',
    public_token,
    overall_score: null,
    executive_summary: null,
    crawled_data: null,
    synthesis: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await redisSet(`audit:${id}`, audit);
  await redisSet(`audit_token:${public_token}`, id);
  return audit;
}

export async function updateAuditStatus(auditId, status) {
  const audit = await redisGet(`audit:${auditId}`);
  if (!audit) return;
  audit.status = status;
  audit.updated_at = new Date().toISOString();
  await redisSet(`audit:${auditId}`, audit);
}

export async function updateAuditCrawledData(auditId, crawledData) {
  const audit = await redisGet(`audit:${auditId}`);
  if (!audit) return;
  audit.crawled_data = crawledData;
  audit.status = 'running';
  audit.updated_at = new Date().toISOString();
  await redisSet(`audit:${auditId}`, audit);
}

export async function finaliseAudit(auditId, { overallScore, executiveSummary, reportUrl, docxUrl, synthesisJSON }) {
  const audit = await redisGet(`audit:${auditId}`);
  if (!audit) return;
  audit.overall_score = overallScore;
  audit.executive_summary = executiveSummary;
  audit.synthesis = synthesisJSON;
  audit.status = 'complete';
  audit.updated_at = new Date().toISOString();
  await redisSet(`audit:${auditId}`, audit);
}

export async function getAuditById(auditId) {
  return await redisGet(`audit:${auditId}`);
}

export async function getAuditByToken(token) {
  const auditId = await redisClient.get(`audit_token:${token}`);
  if (!auditId) return null;
  // auditId may be a raw string (UUID) or a stringified UUID
  const id = auditId.startsWith('"') ? JSON.parse(auditId) : auditId;
  return await redisGet(`audit:${id}`);
}

// ─── Audit Plugins ────────────────────────────────────────────
export async function createAuditPlugins(auditId, pluginIds, pluginMeta = {}) {
  const plugins = {};
  for (const pluginId of pluginIds) {
    plugins[pluginId] = {
      id: uuidv4(),
      audit_id: auditId,
      plugin_id: pluginId,
      status: 'queued',
      score: null,
      summary: null,
      recommendations: null,
      claude_output: null,
      error_message: null,
      started_at: null,
      completed_at: null,
    };
  }
  await redisSet(`audit_plugins:${auditId}`, plugins, PLUGIN_TTL);
}

export async function updateAuditPlugin(auditId, pluginId, updates) {
  const plugins = await redisGet(`audit_plugins:${auditId}`) || {};
  if (!plugins[pluginId]) {
    plugins[pluginId] = { audit_id: auditId, plugin_id: pluginId };
  }
  const p = plugins[pluginId];

  if (updates.status          !== undefined) p.status          = updates.status;
  if (updates.score           !== undefined) p.score           = updates.score;
  if (updates.summary         !== undefined) p.summary         = updates.summary;
  if (updates.errorMessage    !== undefined) p.error_message   = updates.errorMessage;
  if (updates.recommendations !== undefined) p.recommendations = updates.recommendations;
  if (updates.claudeOutput    !== undefined) p.claude_output   = updates.claudeOutput;
  if (updates.startedAt)   p.started_at   = new Date().toISOString();
  if (updates.completedAt) p.completed_at = new Date().toISOString();

  await redisSet(`audit_plugins:${auditId}`, plugins, PLUGIN_TTL);
}

export async function getAuditPlugins(auditId) {
  const pluginsObj = await redisGet(`audit_plugins:${auditId}`);
  return pluginsObj ? Object.values(pluginsObj) : [];
}
