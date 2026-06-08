import { Router } from 'express';
import {
  getIntegrations,
  upsertIntegration,
  deleteIntegration,
  updateIntegrationStatus,
  createAuditTrailEntry
} from '../db/queries.js';

const router = Router();

// Middleware to check for Admin permission (modifying integrations/deployments)
export function requireAdmin(req, res, next) {
  const role = req.headers['x-user-role'] || 'Viewer';
  if (role !== 'Admin') {
    return res.status(403).json({
      error: 'Permission Denied: Only Admin role is allowed to perform this action.'
    });
  }
  next();
}

// Middleware to check for Manager or Admin permission (approvals)
export function requireManagerOrAdmin(req, res, next) {
  const role = req.headers['x-user-role'] || 'Viewer';
  if (role !== 'Admin' && role !== 'Manager') {
    return res.status(403).json({
      error: 'Permission Denied: Only Admin or Manager roles are allowed to perform this action.'
    });
  }
  next();
}

// Helper to extract business context
function getBusinessId(req) {
  return req.headers['x-business-id'] || req.query.businessId || (req.body && req.body.businessId) || 'default-business';
}

// ─── GET /api/integrations ────────────────────────────────────
router.get('/', async (req, res) => {
  const businessId = getBusinessId(req);
  try {
    const list = await getIntegrations(businessId);
    res.json({ success: true, integrations: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/integrations/connect ───────────────────────────
router.post('/connect', requireAdmin, async (req, res) => {
  const businessId = getBusinessId(req);
  const { platform, accountName, accountId, accessToken, refreshToken, tokenExpiry, metadata } = req.body;
  const user = 'Admin User'; // In production, resolved from JWT session

  if (!platform) {
    return res.status(400).json({ error: 'platform is required.' });
  }

  try {
    const integration = await upsertIntegration({
      businessId,
      platform: platform.toLowerCase(),
      accountName: accountName || `Mock ${platform} Account`,
      accountId: accountId || `acc_${Math.random().toString(36).substring(2, 9)}`,
      accessToken: accessToken || 'mock_access_token',
      refreshToken: refreshToken || 'mock_refresh_token',
      tokenExpiry: tokenExpiry || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'connected',
      metadata: metadata || {}
    });

    // Write to audit trail
    await createAuditTrailEntry({
      businessId,
      eventType: 'connect_integration',
      auditId: null,
      pluginId: null,
      changeId: null,
      actionDetails: `Connected ${platform} integration: ${integration.account_name}`,
      performedBy: user,
      metadata: { platform, accountName: integration.account_name, accountId: integration.account_id, connectionMetadata: metadata }
    });

    res.json({ success: true, integration });
  } catch (err) {
    console.error('[Integrations Route] Connect error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/integrations/disconnect ──────────────────────
router.delete('/disconnect', requireAdmin, async (req, res) => {
  const businessId = getBusinessId(req);
  const { platform } = req.body;
  const user = 'Admin User';

  if (!platform) {
    return res.status(400).json({ error: 'platform is required.' });
  }

  try {
    const deleted = await deleteIntegration(businessId, platform.toLowerCase());

    if (!deleted) {
      return res.status(404).json({ error: `No active integration found for platform ${platform}.` });
    }

    // Write to audit trail
    await createAuditTrailEntry({
      businessId,
      eventType: 'disconnect_integration',
      auditId: null,
      pluginId: null,
      changeId: null,
      actionDetails: `Disconnected ${platform} integration.`,
      performedBy: user,
      metadata: { platform }
    });

    res.json({ success: true, message: `Disconnected ${platform} successfully.`, integration: deleted });
  } catch (err) {
    console.error('[Integrations Route] Disconnect error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/integrations/:id/simulate-status ──────────────
router.patch('/:id/simulate-status', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'connected', 'error', 'reauth'
  const user = 'Admin User';

  const valid = ['connected', 'error', 'reauth'];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${valid.join(', ')}` });
  }

  try {
    const updated = await updateIntegrationStatus(id, status);
    if (!updated) {
      return res.status(404).json({ error: 'Integration not found.' });
    }

    // Write to audit trail
    await createAuditTrailEntry({
      businessId: updated.business_id,
      eventType: 'update_integration_status',
      auditId: null,
      pluginId: null,
      changeId: null,
      actionDetails: `Simulated status for ${updated.platform} integration: ${status}`,
      performedBy: user,
      metadata: { platform: updated.platform, status }
    });

    res.json({ success: true, integration: updated });
  } catch (err) {
    console.error('[Integrations Route] Simulate status error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
