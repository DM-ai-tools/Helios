import { Router } from 'express';
import { requireAdmin } from './integrations.js';
import {
  createDbDeploymentJob,
  getDbDeploymentJob,
  updateDbDeploymentJob,
  createDeployment,
  getDeployments,
  getDeploymentById,
  getLatestDeployment,
  createAuditTrailEntry,
  getAuditTrail,
  getIntegrationByPlatform,
  getImplementationChanges,
  upsertIntegration
} from '../db/queries.js';

const router = Router();

// Helper to extract business context
function getBusinessId(req) {
  return req.headers['x-business-id'] || req.query.businessId || (req.body && req.body.businessId) || 'default-business';
}

import axios from 'axios';
import { addDeploymentJob } from '../services/deploymentQueue.js';

// ─── GET /api/deployment/check-page ───────────────────────────────
router.get('/check-page', requireAdmin, async (req, res) => {
  const { platform, slug } = req.query;
  const businessId = getBusinessId(req);
  if (!platform || !slug) return res.status(400).json({ error: 'Missing platform or slug' });
  
  try {
    let integration = await getIntegrationByPlatform(businessId, platform.toLowerCase());
    if (!integration) return res.json({ exists: false });

    if (platform.toLowerCase() === 'wordpress') {
      let siteUrl = process.env.WORDPRESS_SITE_URL || integration.account_name;
      siteUrl = siteUrl.replace(/\/$/, '').replace(/\/wp-admin$/, '');
      const username = process.env.WORDPRESS_USERNAME || integration.account_id;
      const password = process.env.WORDPRESS_PASSWORD || integration.access_token;
      
      if (!siteUrl.startsWith('http://') && !siteUrl.startsWith('https://')) {
        siteUrl = `https://${siteUrl}`;
      }
      const restPrefix = siteUrl.includes('?') ? '' : '/wp-json';
      const endpoint = siteUrl + (restPrefix === '/wp-json' ? `/wp-json/wp/v2/pages?slug=${encodeURIComponent(slug)}&_fields=id,title` : `/?rest_route=/wp/v2/pages&slug=${encodeURIComponent(slug)}&_fields=id,title`);

      const authHeader = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
      const wpRes = await axios.get(endpoint, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        timeout: 10000
      });
      
      if (wpRes.data && wpRes.data.length > 0) {
        return res.json({ exists: true, title: wpRes.data[0].title.rendered });
      }
    }
    return res.json({ exists: false });
  } catch (err) {
    console.warn('[Deployment Check] Check page error:', err.message);
    res.json({ exists: false, error: err.message });
  }
});

// ─── POST /api/deployment/queue ───────────────────────────────
router.post('/queue', requireAdmin, async (req, res) => {
  const { auditId, pluginId, changeId, platform, assetType, customPayload } = req.body;
  const businessId = getBusinessId(req);
  const user = 'Admin User';

  if (!platform || !changeId) {
    return res.status(400).json({ error: 'platform and changeId are required.' });
  }

  try {
    // 1. Check if compatible integration exists
    let integration = await getIntegrationByPlatform(businessId, platform.toLowerCase());
    if (!integration) {
      return res.status(400).json({
        error: `No active integration connected for platform: ${platform}. Please connect it first.`
      });
    }

    // 2. Detect expired token and auto-refresh
    const now = new Date();
    if (integration.token_expiry && new Date(integration.token_expiry) <= now) {
      console.log(`[Token Refresh] Token for platform ${platform} in business ${businessId} has expired. Refreshing...`);
      // Simulate token refresh
      const newAccessToken = `refreshed_access_${Math.random().toString(36).substring(2, 9)}`;
      const newRefreshToken = `refreshed_refresh_${Math.random().toString(36).substring(2, 9)}`;
      const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      // Update the database with the refreshed tokens
      await upsertIntegration({
        businessId,
        platform: platform.toLowerCase(),
        accountName: integration.account_name,
        accountId: integration.account_id,
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        tokenExpiry: newExpiry,
        status: 'connected',
        metadata: integration.metadata
      });

      // Write to audit trail
      await createAuditTrailEntry({
        businessId,
        eventType: 'token_refresh',
        auditId: auditId || null,
        pluginId,
        changeId,
        actionDetails: `Auto-refreshed access token for ${platform} integration.`,
        performedBy: 'System',
        metadata: { platform }
      });
    }

    // 3. Fetch change details (resolve from Redis or use customPayload / payload)
    let payload = customPayload || req.body.payload;
    if (!payload && auditId !== 'demo') {
      const changes = await getImplementationChanges(auditId, pluginId);
      const matched = changes.find(c => c.id === changeId);
      if (matched) {
        payload = {
          title:         matched.title,
          currentState:  matched.currentState,
          proposedChange: matched.userEdit || matched.proposedChange,
          description:   matched.description,
          changeType:    matched.changeType,
          actionType:    matched.actionType  || 'replace',
          targetSelector:matched.targetSelector || null,
          sourceUrl:     matched.sourceUrl   || null,
          location:      matched.location    || null,
        };
      }
    }

    // Fallback for demo/missing
    if (!payload) {
      payload = {
        title: 'WordPress Deployment Update',
        currentState: 'Welcome page draft',
        proposedChange: 'Top rated localized SEO landing page design and content hooks',
        description: 'SEO optimization update',
        changeType: 'general'
      };
    }

    // 4. Queue Deployment Job in database
    const job = await createDbDeploymentJob({
      businessId,
      auditId,
      changeId,
      platform: platform.toLowerCase(),
      assetType
    });

    // 5. Enqueue background job process via BullMQ
    await addDeploymentJob({
      jobDbId: job.id,
      businessId,
      auditId,
      changeId,
      platform: platform.toLowerCase(),
      assetType,
      payload,
      deployedBy: user,
      isRollback: false,
      originalDeploymentId: null
    });

    res.json({
      success: true,
      message: `Deployment queued. Job ID: ${job.id}`,
      jobId: job.id
    });

  } catch (err) {
    console.error('[Deployment Route] Queue error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/deployment/jobs/:id ────────────────────────────
router.get('/jobs/:id', async (req, res) => {
  const { id } = req.params;
  const businessId = getBusinessId(req);
  try {
    const job = await getDbDeploymentJob(id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found.' });
    }
    // Verify tenant isolation
    if (businessId && job.business_id && job.business_id !== businessId) {
      return res.status(403).json({ error: 'Permission Denied: Cross-tenant access is not allowed.' });
    }

    if (job.status === 'completed' || job.status === 'failed') {
      const deploymentResult = await getLatestDeployment(businessId, job.platform, job.change_id);
      if (deploymentResult && deploymentResult.response) {
        job.response_payload = deploymentResult.response.response_payload || deploymentResult.response;
      }
    }
    
    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/deployment/history ─────────────────────────────
router.get('/history', async (req, res) => {
  const businessId = getBusinessId(req);
  try {
    const list = await getDeployments(businessId);
    const auditLogs = await getAuditTrail(businessId);
    res.json({ success: true, history: list, auditTrail: auditLogs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/deployment/rollback/:id ─────────────────────────
router.post('/rollback/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const businessId = getBusinessId(req);
  const user = 'Admin User';

  try {
    // 1. Fetch deployment record
    const original = await getDeploymentById(id);
    if (!original) {
      return res.status(404).json({ error: 'Deployment record not found.' });
    }

    // Verify tenant isolation
    if (original.business_id && original.business_id !== businessId) {
      return res.status(403).json({ error: 'Permission Denied: Cross-tenant rollback is not allowed.' });
    }

    if (!original.previous_content) {
      return res.status(400).json({
        error: 'No rollback version content exists for this deployment record.'
      });
    }

    // 2. Queue Rollback Job in database
    const job = await createDbDeploymentJob({
      businessId,
      auditId: original.audit_id,
      changeId: original.change_id,
      platform: original.platform,
      assetType: original.asset_type
    });

    // Content payload is the original's previous_content
    const payload = original.previous_content;
    // Append rolled-back indicator to title
    if (payload.title && !payload.title.includes('Rolled Back')) {
      payload.title = `${payload.title} (Rolled Back)`;
    }

    // 3. Enqueue Rollback Job via BullMQ
    await addDeploymentJob({
      jobDbId: job.id,
      businessId,
      auditId: original.audit_id,
      changeId: original.change_id,
      platform: original.platform,
      assetType: original.asset_type,
      payload,
      deployedBy: user,
      isRollback: true,
      originalDeploymentId: original.id
    });

    res.json({
      success: true,
      message: `Rollback job queued. Job ID: ${job.id}`,
      jobId: job.id
    });

  } catch (err) {
    console.error('[Deployment Route] Rollback error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
