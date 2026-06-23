// ============================================================
// backend/routes/admin.js — Admin Panel API
//
// Mounted at /api/admin with `requireAuthAPI, requireAdminAPI` so EVERY route
// here requires an authenticated admin session (401 if unauth, 403 if not
// admin). No route in this file may be reached otherwise.
// ============================================================
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import {
  // users
  listUsers, getUserDetail, updateUser, setUserPassword, softDeleteUser, hardDeleteUser,
  getUserDeletionImpact, getUserForImpersonation, getUserPasswordHash,
  // reports / audits
  listAllAudits, getAuditFull, deleteAudit, reassignAudit, getAuditById, updateAuditStatus,
  // plugins
  listAllPlugins, getPluginById, createPlugin, updatePlugin, togglePlugin, deletePlugin,
  getPluginUsageCount, reorderPlugins,
  // audit trail / stats
  getAllAuditTrail, getAuditTrailEventTypes, getPlatformStats, getRecentActivity,
  // shared
  createAuditTrailEntry,
} from '../db/queries.js';
import { getConfigList, getRawValue, setConfig, testKey } from '../services/configService.js';
import { runAnalyzePipeline } from './audit.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-clicktrends-key-for-dev';
const COOKIE_NAME = 'ct_auth_token';

// ─── Helpers ──────────────────────────────────────────────────
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || 'unknown';
}

// Write an admin action to the platform audit trail. IP is stored in metadata
// (the audit_trail table has no ip column). Best-effort — never blocks a route.
async function trail(req, { eventType, auditId = null, pluginId = null, changeId = null, actionDetails, metadata = {} }) {
  try {
    await createAuditTrailEntry({
      businessId: 'admin-panel',
      eventType,
      auditId, pluginId, changeId,
      actionDetails,
      performedBy: req.user?.email || 'admin',
      metadata: { ...metadata, ip: clientIp(req) },
    });
  } catch (err) {
    console.error('[Admin] audit trail write failed:', err.message);
  }
}

// Verify the admin re-typed their password (gate for sensitive config changes).
async function verifyAdminPassword(req, password) {
  if (!password) return false;
  const hash = await getUserPasswordHash(req.user.id);
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

const asyncRoute = (fn) => (req, res) => fn(req, res).catch(err => {
  console.error(`[Admin] ${req.method} ${req.originalUrl} error:`, err.message);
  res.status(500).json({ error: err.message });
});

// ════════════════════════════════════════════════════════════
// STATS / DASHBOARD
// ════════════════════════════════════════════════════════════
router.get('/stats', asyncRoute(async (req, res) => {
  const [stats, activity] = await Promise.all([getPlatformStats(), getRecentActivity(20)]);
  res.json({ success: true, stats, activity });
}));

// ════════════════════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════════════════════
router.get('/users', asyncRoute(async (req, res) => {
  const users = await listUsers({
    search: req.query.search || '', role: req.query.role || '', status: req.query.status || '',
    sort: req.query.sort || 'created_at', dir: req.query.dir || 'desc',
  });
  res.json({ success: true, users });
}));

router.get('/users/:userId', asyncRoute(async (req, res) => {
  const user = await getUserDetail(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ success: true, user });
}));

router.patch('/users/:userId', asyncRoute(async (req, res) => {
  if (req.params.userId === req.user.id && req.body.role && req.body.role !== 'admin') {
    return res.status(400).json({ error: 'You cannot remove your own admin role.' });
  }
  const updated = await updateUser(req.params.userId, req.body || {});
  if (!updated) return res.status(404).json({ error: 'User not found.' });
  await trail(req, { eventType: 'admin_update_user', actionDetails: `Updated user ${updated.email}`, metadata: { fields: Object.keys(req.body || {}), userId: updated.id } });
  res.json({ success: true, user: updated });
}));

// Preview what a delete removes (for the confirm modal).
router.get('/users/:userId/deletion-impact', asyncRoute(async (req, res) => {
  res.json({ success: true, impact: await getUserDeletionImpact(req.params.userId) });
}));

router.delete('/users/:userId', asyncRoute(async (req, res) => {
  if (req.params.userId === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  const hard = req.query.hard === 'true';
  const deleted = hard ? await hardDeleteUser(req.params.userId) : await softDeleteUser(req.params.userId);
  if (!deleted) return res.status(404).json({ error: 'User not found.' });
  await trail(req, { eventType: 'admin_delete_user', actionDetails: `${hard ? 'Hard' : 'Soft'}-deleted user ${deleted.email}`, metadata: { userId: deleted.id, hard } });
  res.json({ success: true, deleted, hard });
}));

// Reset password — generates a temporary password (returned once to the admin).
router.post('/users/:userId/reset-password', asyncRoute(async (req, res) => {
  const user = await getUserDetail(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  // Strong temp password meeting the registration rules (upper+lower+digit, 8+).
  const tempPassword = 'Ct' + crypto.randomBytes(6).toString('hex') + '9';
  const hash = await bcrypt.hash(tempPassword, await bcrypt.genSalt(10));
  await setUserPassword(req.params.userId, hash);
  await trail(req, { eventType: 'admin_reset_password', actionDetails: `Reset password for ${user.email}`, metadata: { userId: user.id } });
  res.json({ success: true, tempPassword, message: 'Share this temporary password with the user. It is shown only once.' });
}));

// Impersonate — issue a session as the target user, with a revertable claim.
router.post('/users/:userId/impersonate', asyncRoute(async (req, res) => {
  const target = await getUserForImpersonation(req.params.userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You are already this user.' });

  const token = jwt.sign(
    { id: target.id, email: target.email, role: target.role || 'user', impersonatedBy: { id: req.user.id, email: req.user.email } },
    JWT_SECRET, { expiresIn: '2h' }
  );
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 2 * 60 * 60 * 1000,
  });
  await trail(req, { eventType: 'admin_impersonate', actionDetails: `${req.user.email} started impersonating ${target.email}`, metadata: { targetUserId: target.id } });
  res.json({ success: true, message: `Now viewing as ${target.email}.`, redirect: '/' });
}));

// ════════════════════════════════════════════════════════════
// REPORTS (audits)
// ════════════════════════════════════════════════════════════
router.get('/reports', asyncRoute(async (req, res) => {
  const reports = await listAllAudits({
    search: req.query.search || '', userId: req.query.userId || '', status: req.query.status || '',
    pluginId: req.query.pluginId || '', from: req.query.from || '', to: req.query.to || '',
    sort: req.query.sort || 'created_at', dir: req.query.dir || 'desc',
  });
  res.json({ success: true, reports });
}));

router.get('/reports/:auditId', asyncRoute(async (req, res) => {
  const report = await getAuditFull(req.params.auditId);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  res.json({ success: true, report });
}));

// Download report as JSON.
router.get('/reports/:auditId/download', asyncRoute(async (req, res) => {
  const report = await getAuditFull(req.params.auditId);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="report_${req.params.auditId}.json"`);
  res.send(JSON.stringify(report, null, 2));
}));

router.delete('/reports/:auditId', asyncRoute(async (req, res) => {
  const deleted = await deleteAudit(req.params.auditId);
  if (!deleted) return res.status(404).json({ error: 'Report not found.' });
  await trail(req, { eventType: 'admin_delete_report', auditId: req.params.auditId, actionDetails: `Deleted report for ${deleted.url}`, metadata: { url: deleted.url } });
  res.json({ success: true, deleted });
}));

router.post('/reports/:auditId/reassign', asyncRoute(async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required.' });
  const target = await getUserDetail(userId);
  if (!target) return res.status(404).json({ error: 'Target user not found.' });
  const updated = await reassignAudit(req.params.auditId, userId);
  if (!updated) return res.status(404).json({ error: 'Report not found.' });
  await trail(req, { eventType: 'admin_reassign_report', auditId: req.params.auditId, actionDetails: `Reassigned report to ${target.email}`, metadata: { userId } });
  res.json({ success: true });
}));

router.post('/reports/:auditId/rerun', asyncRoute(async (req, res) => {
  const auditId = req.params.auditId;
  const full = await getAuditFull(auditId);
  if (!full) return res.status(404).json({ error: 'Report not found.' });

  let crawledData = full.crawled_data;
  if (typeof crawledData === 'string') { try { crawledData = JSON.parse(crawledData); } catch (_) {} }
  if (!crawledData) {
    return res.status(409).json({ error: 'This report has no stored crawl data and cannot be re-run from the admin panel. Run a fresh audit for this URL instead.' });
  }

  const selectedPlugins = (full.plugins || []).map(p => p.plugin_id).filter(Boolean);
  await updateAuditStatus(auditId, 'running');
  await trail(req, { eventType: 'admin_rerun_report', auditId, actionDetails: `Re-ran report for ${full.url}`, metadata: { plugins: selectedPlugins } });

  // Fire-and-forget — mirrors the /analyze route's background dispatch.
  runAnalyzePipeline({
    auditId, crawledData, url: full.url, industry: full.industry,
    email: full.user_email || 'admin@clicktrends.com.au', selectedPlugins,
  }).catch(err => console.error(`[Admin] rerun pipeline error for ${auditId}:`, err.message));

  res.json({ success: true, message: 'Re-run started.', statusUrl: `/api/audit/${auditId}/status` });
}));

// ════════════════════════════════════════════════════════════
// PLUGINS (registry / metadata)
// ════════════════════════════════════════════════════════════
router.get('/plugins', asyncRoute(async (req, res) => {
  res.json({ success: true, plugins: await listAllPlugins() });
}));

router.post('/plugins', asyncRoute(async (req, res) => {
  const { id, name, description, category, icon, promptTemplate, isActive } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name are required.' });
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return res.status(400).json({ error: 'Plugin id must be a lowercase slug (a-z, 0-9, hyphens).' });
  if (await getPluginById(id)) return res.status(409).json({ error: `Plugin id "${id}" already exists.` });
  const plugin = await createPlugin({ id, name, description, category, icon, promptTemplate, isActive: isActive !== false });
  await trail(req, { eventType: 'admin_create_plugin', pluginId: id, actionDetails: `Registered plugin "${name}" (${id})`, metadata: { executable: false } });
  res.json({ success: true, plugin, warning: 'Registry entry created. This plugin is not executable until a developer adds the backend/plugins/' + id + '.js module.' });
}));

// Reorder MUST be declared before the parameterized :pluginId routes.
router.patch('/plugins/reorder', asyncRoute(async (req, res) => {
  const { order } = req.body; // [{ id, display_order }]
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array is required.' });
  const plugins = await reorderPlugins(order);
  await trail(req, { eventType: 'admin_reorder_plugins', actionDetails: 'Reordered plugins', metadata: { order: order.map(o => o.id) } });
  res.json({ success: true, plugins });
}));

router.get('/plugins/:pluginId', asyncRoute(async (req, res) => {
  const plugin = await getPluginById(req.params.pluginId);
  if (!plugin) return res.status(404).json({ error: 'Plugin not found.' });
  res.json({ success: true, plugin, usageCount: await getPluginUsageCount(req.params.pluginId) });
}));

router.patch('/plugins/:pluginId', asyncRoute(async (req, res) => {
  const updated = await updatePlugin(req.params.pluginId, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Plugin not found.' });
  await trail(req, { eventType: 'admin_update_plugin', pluginId: req.params.pluginId, actionDetails: `Updated plugin ${updated.name}`, metadata: { fields: Object.keys(req.body || {}) } });
  res.json({ success: true, plugin: updated });
}));

router.post('/plugins/:pluginId/toggle', asyncRoute(async (req, res) => {
  const current = await getPluginById(req.params.pluginId);
  if (!current) return res.status(404).json({ error: 'Plugin not found.' });
  const next = typeof req.body.isActive === 'boolean' ? req.body.isActive : !current.is_active;
  const plugin = await togglePlugin(req.params.pluginId, next);
  await trail(req, { eventType: 'admin_toggle_plugin', pluginId: req.params.pluginId, actionDetails: `${next ? 'Enabled' : 'Disabled'} plugin ${plugin.name}` });
  res.json({ success: true, plugin });
}));

router.delete('/plugins/:pluginId', asyncRoute(async (req, res) => {
  const usageCount = await getPluginUsageCount(req.params.pluginId);
  const deleted = await deletePlugin(req.params.pluginId);
  if (!deleted) return res.status(404).json({ error: 'Plugin not found.' });
  await trail(req, { eventType: 'admin_delete_plugin', pluginId: req.params.pluginId, actionDetails: `Deleted plugin ${deleted.name} (used by ${usageCount} reports)`, metadata: { usageCount } });
  res.json({ success: true, deleted, usageCount });
}));

// ════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════
router.get('/config', asyncRoute(async (req, res) => {
  res.json({ success: true, config: await getConfigList() });
}));

// Reveal a single secret's raw value — requires password re-auth.
router.post('/config/reveal/:key', asyncRoute(async (req, res) => {
  if (!(await verifyAdminPassword(req, req.body.confirmPassword))) {
    return res.status(401).json({ error: 'Password confirmation failed.' });
  }
  const value = await getRawValue(req.params.key);
  await trail(req, { eventType: 'admin_reveal_config', actionDetails: `Revealed secret ${req.params.key}`, metadata: { key: req.params.key } });
  res.json({ success: true, key: req.params.key, value: value ?? '' });
}));

// Test an integration key (real ping). Optional explicit value to test before saving.
router.post('/config/test/:key', asyncRoute(async (req, res) => {
  const result = await testKey(req.params.key, req.body?.value);
  res.json({ success: true, key: req.params.key, ...result });
}));

// Save one or more config changes — password-gated; logs masked old/new.
router.patch('/config', asyncRoute(async (req, res) => {
  const { changes, confirmPassword } = req.body; // changes: [{ key, value }]
  if (!Array.isArray(changes) || changes.length === 0) return res.status(400).json({ error: 'changes array is required.' });
  if (!(await verifyAdminPassword(req, confirmPassword))) {
    return res.status(401).json({ error: 'Password confirmation failed.' });
  }
  for (const c of changes) {
    if (!c.key || !/^[A-Z][A-Z0-9_]*$/.test(c.key)) {
      return res.status(400).json({ error: `Invalid variable name "${c.key}". Use UPPER_SNAKE_CASE.` });
    }
  }
  const results = [];
  for (const c of changes) {
    const r = await setConfig(c.key, c.value ?? '', req.user.email);
    results.push(r);
    // Log masked values only — never the raw secret.
    await trail(req, {
      eventType: 'admin_update_config',
      actionDetails: `Updated config ${c.key}`,
      metadata: { key: c.key, oldValue: r.oldMasked, newValue: r.newMasked, isSecret: r.isSecret, restartRequired: r.restartRequired },
    });
  }
  const restartKeys = results.filter(r => r.restartRequired).map(r => r.key);
  res.json({ success: true, results, restartRequired: restartKeys });
}));

// ════════════════════════════════════════════════════════════
// AUDIT TRAIL
// ════════════════════════════════════════════════════════════
router.get('/audit-trail', asyncRoute(async (req, res) => {
  const { rows, total } = await getAllAuditTrail({
    search: req.query.search || '', user: req.query.user || '', eventType: req.query.eventType || '',
    auditId: req.query.auditId || '', from: req.query.from || '', to: req.query.to || '',
    limit: req.query.limit || 50, offset: req.query.offset || 0,
  });
  res.json({ success: true, entries: rows, total, eventTypes: await getAuditTrailEventTypes() });
}));

export default router;
