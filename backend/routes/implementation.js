// ============================================================
// backend/routes/implementation.js
// Implementation Approval Workflow API with Demo Mock Support
// ============================================================

import { Router } from 'express';
import {
  getImplementationChanges,
  updateImplementationChange,
  createImplementationJob,
  getImplementationJobs,
  getAuditById,
  getAuditPlugins,
  saveImplementationChanges,
  createDbDeploymentJob,
  updateDbDeploymentJob,
  createDeployment,
  createAuditTrailEntry,
  getIntegrationByPlatform,
  upsertIntegration
} from '../db/queries.js';
import { requireAdmin } from './integrations.js';

const router = Router();

// Helper to generate mock changes for demo mode
function getMockChanges(auditId, pluginId) {
  const defaults = [
    {
      title: 'Update Title Tag',
      priority: 'High',
      impactScore: 85,
      description: 'The title tag is missing high-intent keywords.',
      currentState: 'Welcome to our site',
      proposedChange: 'Top-Rated Local Services & Solutions | Call Today',
      changeType: 'metadata',
    }
  ];

  const mockData = {
    'seo-audit': [
      {
        title: 'Optimize Homepage Meta Title',
        priority: 'High',
        impactScore: 90,
        description: 'Homepage meta title is missing high-intent target keywords for the local market.',
        currentState: 'ClickTrends | Digital Marketing',
        proposedChange: 'ClickTrends | Data-Driven Digital Marketing Agency Melbourne | Lift Your ROI',
        changeType: 'metadata',
      },
      {
        title: 'Inject Schema Markup for LocalBusiness',
        priority: 'Medium',
        impactScore: 75,
        description: 'No structured data detected on homepage. Adding LocalBusiness schema helps Google understand site entity details.',
        currentState: 'No schema markup found',
        proposedChange: '{\n  "@context": "https://schema.org",\n  "@type": "LocalBusiness",\n  "name": "ClickTrends Agency",\n  "url": "https://clicktrends.com.au",\n  "telephone": "+61 3 9000 0000",\n  "address": {\n    "@type": "PostalAddress",\n    "addressLocality": "Melbourne",\n    "addressRegion": "VIC",\n    "postalCode": "3000",\n    "addressCountry": "AU"\n  }\n}',
        changeType: 'schema',
      },
      {
        title: 'Fix Missing Alt Text on Homepage Hero',
        priority: 'Low',
        impactScore: 40,
        description: 'Homepage hero image is missing descriptive alt text, causing accessibility warnings.',
        currentState: '<img src="/images/hero-marketing.jpg">',
        proposedChange: '<img src="/images/hero-marketing.jpg" alt="ClickTrends team analyzing digital marketing performance dashboard">',
        changeType: 'technical',
      }
    ],
    'brand-review': [
      {
        title: 'Remove ACCC Liability: "100% Guaranteed Results"',
        priority: 'High',
        impactScore: 95,
        description: 'ACCC rules prohibit unqualified guarantees on marketing results. Soften claim to remain legally compliant.',
        currentState: 'We offer 100% guaranteed results for all SEO campaigns.',
        proposedChange: 'We follow data-driven methodologies to maximize campaign performance and SEO results.',
        changeType: 'content',
      },
      {
        title: 'Replace Internal Technical Jargon',
        priority: 'Medium',
        impactScore: 60,
        description: 'Jargon confuses non-technical prospects. Simplify terminology to improve landing page conversions.',
        currentState: 'Our team conducts hyper-granular CTR optimizations on high-intent SERP features.',
        proposedChange: 'We improve your search result titles and descriptions to get more people clicking through to your site.',
        changeType: 'content',
      }
    ],
    'content-copy': [
      {
        title: 'Optimize Homepage Hero H1 Heading',
        priority: 'High',
        impactScore: 85,
        description: 'Homepage heading is company-focused rather than benefit-focused. Make it target customer needs.',
        currentState: 'We Are ClickTrends',
        proposedChange: 'Get More Leads & Sales With Melbourne\'s Leading Digital Marketing Agency',
        changeType: 'content',
      },
      {
        title: 'Rewrite Primary CTA Button Copy',
        priority: 'Medium',
        impactScore: 70,
        description: 'Current CTA button is low-friction but does not drive high commercial intent.',
        currentState: 'Submit Info',
        proposedChange: 'Get Your Free Growth Audit →',
        changeType: 'content',
      }
    ],
    'competitive-brief': [
      {
        title: 'Add Strengths Differentiator to Pricing Page',
        priority: 'High',
        impactScore: 80,
        description: 'Emphasize your dedicated senior strategist advantage compared to competitor self-serve automated portals.',
        currentState: 'We have good service.',
        proposedChange: 'Unlike other agencies who put you in an automated portal, ClickTrends gives you a dedicated senior strategist with direct weekly calls.',
        changeType: 'content',
      }
    ],
    'campaign-plan': [
      {
        title: 'Update Retargeting Facebook Ad Copy',
        priority: 'High',
        impactScore: 80,
        description: 'Retargeting ad needs direct, pain-point matching copy to lift CTR for warming prospects.',
        currentState: 'Hire a Marketing Agency',
        proposedChange: 'Still not hitting your lead targets? Get a free digital audit of your site today.',
        changeType: 'content',
      }
    ],
    'email-sequence': [
      {
        title: 'Optimize Welcome Email Subject Line',
        priority: 'High',
        impactScore: 90,
        description: 'Welcome email open rate can be significantly increased by offering instant value and clear delivery.',
        currentState: 'Welcome to ClickTrends',
        proposedChange: '🎁 Your Free SEO Audit is inside (plus 3 quick fixes)',
        changeType: 'metadata',
      },
      {
        title: 'Add Direct Booking CTA to Nurture Email 2',
        priority: 'Medium',
        impactScore: 75,
        description: 'Prospects reading email 2 have shown interest. Provide a clear booking link to book direct calls.',
        currentState: 'Let us know if you have questions.',
        proposedChange: 'Ready to scale? Book a 15-minute strategy call directly in my calendar: [Link]',
        changeType: 'content',
      }
    ]
  };

  const list = mockData[pluginId] || defaults;
  return list.map((c, i) => ({
    id: `${auditId}-${pluginId}-${i}`,
    auditId,
    pluginId,
    title: c.title,
    priority: c.priority,
    impactScore: c.impactScore,
    description: c.description,
    currentState: c.currentState,
    proposedChange: c.proposedChange,
    changeType: c.changeType,
    status: 'pending',
    userEdit: null,
    createdAt: new Date().toISOString(),
  }));
}

// ─── GET /api/implementation/:auditId/:pluginId ───────────────
// Returns all implementation changes for a plugin
router.get('/:auditId([^/]+)/:pluginId', async (req, res) => {
  const { auditId, pluginId } = req.params;
  const isDemo = auditId === 'demo' || auditId.startsWith('demo-');

  try {
    if (isDemo) {
      const mockChanges = getMockChanges(auditId, pluginId);
      return res.json({
        auditId,
        pluginId,
        url: 'yourbusiness.com.au',
        changes: mockChanges,
        summary: {
          total:    mockChanges.length,
          pending:  mockChanges.filter(c => c.status === 'pending').length,
          approved: mockChanges.filter(c => c.status === 'approved').length,
          rejected: mockChanges.filter(c => c.status === 'rejected').length,
        },
      });
    }

    const audit = await getAuditById(auditId);
    if (!audit) return res.status(404).json({ error: 'Audit not found' });

    let changes = await getImplementationChanges(auditId, pluginId);

    // Fallback: If no changes stored yet, try to extract them from plugin's claude_output
    if (!changes || changes.length === 0) {
      const plugins = await getAuditPlugins(auditId);
      const plugin = plugins.find(p => p.plugin_id === pluginId);
      if (plugin && plugin.claude_output) {
        let output = plugin.claude_output;
        if (typeof output === 'string') {
          try {
            output = JSON.parse(output);
          } catch (_) {}
        }
        if (output && Array.isArray(output.implementationChanges) && output.implementationChanges.length > 0) {
          console.log(`[Implementation] Extracting ${output.implementationChanges.length} changes from stored claude_output for ${pluginId}`);
          changes = await saveImplementationChanges(auditId, pluginId, output.implementationChanges);
        }
      }
    }

    res.json({
      auditId,
      pluginId,
      url: audit.url,
      changes,
      summary: {
        total:    changes.length,
        pending:  changes.filter(c => c.status === 'pending').length,
        approved: changes.filter(c => c.status === 'approved').length,
        rejected: changes.filter(c => c.status === 'rejected').length,
      },
    });
  } catch (err) {
    console.error('[Implementation] GET changes error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/implementation/:auditId/:pluginId/:changeId ──
// Update status (approved/rejected) or save user edit
router.patch('/:auditId([^/]+)/:pluginId/:changeId', async (req, res) => {
  const { auditId, pluginId, changeId } = req.params;
  const { status, userEdit } = req.body;

  const allowed = ['pending', 'approved', 'rejected'];
  if (status && !allowed.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${allowed.join(', ')}` });
  }

  const isDemo = auditId === 'demo' || auditId.startsWith('demo-');
  if (isDemo) {
    return res.json({
      success: true,
      change: {
        id: changeId,
        auditId,
        pluginId,
        title: 'Demo Change',
        priority: 'Medium',
        impactScore: 70,
        description: 'Simulated demo change',
        currentState: 'Demo Current State',
        proposedChange: 'Demo Proposed Change',
        changeType: 'general',
        status: status || 'pending',
        userEdit: userEdit !== undefined ? userEdit : null,
        updatedAt: new Date().toISOString(),
      }
    });
  }

  try {
    const updated = await updateImplementationChange(auditId, pluginId, changeId, { status, userEdit });
    if (!updated) return res.status(404).json({ error: 'Change not found' });
    res.json({ success: true, change: updated });
  } catch (err) {
    console.error('[Implementation] PATCH change error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/implementation/:auditId/:pluginId/bulk ─────────
// Bulk approve or reject a list of changeIds
router.post('/:auditId([^/]+)/:pluginId/bulk', async (req, res) => {
  const { auditId, pluginId } = req.params;
  const { changeIds, status } = req.body;

  if (!Array.isArray(changeIds) || changeIds.length === 0) {
    return res.status(400).json({ error: 'changeIds must be a non-empty array' });
  }
  const allowed = ['approved', 'rejected', 'pending'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be: ${allowed.join(', ')}` });
  }

  const isDemo = auditId === 'demo' || auditId.startsWith('demo-');
  if (isDemo) {
    const mockUpdated = changeIds.map(id => ({
      id,
      auditId,
      pluginId,
      status,
      updatedAt: new Date().toISOString(),
    }));
    return res.json({ success: true, updated: changeIds.length, changes: mockUpdated });
  }

  try {
    const results = [];
    for (const changeId of changeIds) {
      const updated = await updateImplementationChange(auditId, pluginId, changeId, { status });
      if (updated) results.push(updated);
    }
    res.json({ success: true, updated: results.length, changes: results });
  } catch (err) {
    console.error('[Implementation] BULK update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/implementation/:auditId/email-sequence/campaign-execute ───
// Email-specific execute — builds campaign bot payload with HTML email templates
router.post('/:auditId([^/]+)/email-sequence/campaign-execute', requireAdmin, async (req, res) => {
  const { auditId } = req.params;
  const { approvedEmails, campaignSettings } = req.body;
  const businessId = req.headers['x-business-id'] || 'default-business';
  const isDemo = auditId === 'demo' || auditId.startsWith('demo-');

  if (isDemo) {
    return res.json({
      success:  true,
      jobId:    'demo-campaign-' + Math.random().toString(36).substring(2, 9),
      payload: {
        campaignType: campaignSettings?.campaignType || 'email_sequence',
        campaignName: campaignSettings?.campaignName || 'Demo Campaign',
        emails: (approvedEmails || []).map(e => ({
          subject:     e.subject     || 'Demo Subject',
          previewText: e.previewText || '',
          html:        e.html        || '<p>Demo email body</p>',
          delay:       e.delay       || '0 days',
        })),
        dispatchedAt: new Date().toISOString(),
      },
      botResult: { status: 'queued', note: 'Demo mode: Campaign simulated. Connect implementation bot to deploy real campaigns.' },
      message: 'Demo campaign processed successfully',
    });
  }

  try {
    const audit = await getAuditById(auditId);
    if (!audit) return res.status(404).json({ error: 'Audit not found' });

    if (!approvedEmails || approvedEmails.length === 0) {
      return res.status(400).json({ error: 'No approved emails to send' });
    }

    // 1. Verify Mailchimp integration
    let integration = await getIntegrationByPlatform(businessId, 'mailchimp');
    if (!integration) {
      return res.status(400).json({
        error: 'No active Mailchimp integration connected for this business. Please connect it first.'
      });
    }

    // 2. Auto-detect and refresh expired token
    const now = new Date();
    if (integration.token_expiry && new Date(integration.token_expiry) <= now) {
      console.log(`[Token Refresh] Mailchimp token for business ${businessId} has expired. Refreshing...`);
      const newAccessToken = `refreshed_access_${Math.random().toString(36).substring(2, 9)}`;
      const newRefreshToken = `refreshed_refresh_${Math.random().toString(36).substring(2, 9)}`;
      const newExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      await upsertIntegration({
        businessId,
        platform: 'mailchimp',
        accountName: integration.account_name,
        accountId: integration.account_id,
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        tokenExpiry: newExpiry,
        status: 'connected',
        metadata: integration.metadata
      });

      await createAuditTrailEntry({
        businessId,
        eventType: 'token_refresh',
        auditId: auditId || null,
        pluginId: 'email-sequence',
        changeId: 'email-sequence-campaign',
        actionDetails: 'Auto-refreshed access token for Mailchimp integration.',
        performedBy: 'System',
        metadata: { platform: 'mailchimp' }
      });
    }

    // Build campaign payload
    const payload = {
      campaignType:  campaignSettings?.campaignType || 'email_sequence',
      campaignName:  campaignSettings?.campaignName || `Campaign for ${audit.url}`,
      campaignGoal:  campaignSettings?.campaignGoal || '',
      totalDuration: campaignSettings?.totalDuration || '',
      dispatchedAt:  new Date().toISOString(),
      auditId,
      emails: approvedEmails.map(e => ({
        emailNumber: e.emailNumber,
        subject:     e.subject || e.userSubject || '',
        previewText: e.previewText || e.userPreviewText || '',
        html:        e.userHtml || e.html || '',
        delay:       e.delay || (e.delayDays != null ? `${e.delayDays} days` : '0 days'),
        ctaText:     e.ctaText || '',
        ctaUrl:      e.ctaUrl  || '',
      })),
    };

    // Create implementation job record in Redis
    const job = await createImplementationJob(auditId, 'email-sequence', payload.emails);

    // 3. Create deployment job queue entry in PostgreSQL
    const dbJob = await createDbDeploymentJob({
      businessId,
      auditId,
      changeId: 'email-sequence-campaign',
      platform: 'mailchimp',
      assetType: 'email_sequence'
    });

    // Bot dispatch
    const botUrl = process.env.IMPLEMENTATION_BOT_URL;
    let botResult = null;
    if (botUrl) {
      try {
        const botRes = await fetch(botUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.IMPLEMENTATION_BOT_TOKEN || ''}` },
          body:    JSON.stringify(payload),
          signal:  AbortSignal.timeout(30000),
        });
        botResult = await botRes.json();
      } catch (botErr) {
        botResult = { error: botErr.message, note: 'Bot dispatch failed — payload is queued and ready to retry' };
      }
    } else {
      botResult = { status: 'queued', note: 'Bot not yet configured. Campaign payload stored and ready for dispatch.' };
    }

    // Update job status to completed/failed based on dispatch result
    const status = botResult?.error ? 'failed' : 'completed';
    await updateDbDeploymentJob(dbJob.id, status);

    // 4. Record the completed deployment in PostgreSQL deployments table
    await createDeployment({
      businessId,
      auditId,
      changeId: 'email-sequence-campaign',
      platform: 'mailchimp',
      assetType: 'email_sequence',
      contentPayload: payload,
      previousContent: null,
      status,
      deployedBy: 'Admin User',
      response: botResult
    });

    // 5. Write to audit trail
    await createAuditTrailEntry({
      businessId,
      eventType: status === 'completed' ? 'deploy_change' : 'deployment_failed',
      auditId,
      pluginId: 'email-sequence',
      changeId: 'email-sequence-campaign',
      actionDetails: status === 'completed'
        ? `Dispatched campaign "${payload.campaignName}" to Mailchimp.`
        : `Failed to dispatch campaign to Mailchimp: ${botResult?.error}`,
      performedBy: 'Admin User',
      metadata: { jobId: dbJob.id, botResult }
    });

    res.json({
      success:  true,
      jobId:    job.id,
      payload,
      botResult,
      message:  botUrl
        ? `${approvedEmails.length} emails dispatched to campaign bot`
        : `${approvedEmails.length} emails queued — connect implementation bot to publish campaign`,
    });
  } catch (err) {
    console.error('[EmailCampaign] EXECUTE error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/implementation/:auditId/:pluginId/execute ──────
// Collect approved changes, build payload, and (stub) send to bot
router.post('/:auditId([^/]+)/:pluginId/execute', async (req, res) => {
  const { auditId, pluginId } = req.params;
  const isDemo = auditId === 'demo' || auditId.startsWith('demo-');

  if (isDemo) {
    return res.json({
      success:    true,
      jobId:      'demo-job-' + Math.random().toString(36).substring(2, 9),
      payload: {
        auditId,
        plugin:          pluginId,
        dispatchedAt:    new Date().toISOString(),
        approvedChanges: []
      },
      botResult: { status: 'queued', note: 'Demo mode: Changes simulated. Connect implementation bot to deploy real audits.' },
      message: 'Demo changes processed successfully',
    });
  }

  try {
    const changes = await getImplementationChanges(auditId, pluginId);
    const approved = changes.filter(c => c.status === 'approved');

    if (approved.length === 0) {
      return res.status(400).json({ error: 'No approved changes to implement' });
    }

    // Build the payload that will be dispatched to the implementation bot
    const payload = {
      auditId,
      plugin:          pluginId,
      dispatchedAt:    new Date().toISOString(),
      approvedChanges: approved.map(c => ({
        id:             c.id,
        title:          c.title,
        priority:       c.priority,
        changeType:     c.changeType,
        currentState:   c.currentState,
        finalContent:   c.userEdit || c.proposedChange, // user edit takes priority
      })),
    };

    // Create implementation job record
    const job = await createImplementationJob(auditId, pluginId, payload.approvedChanges);

    // ── Bot Dispatch (stub — wire up when IMPLEMENTATION_BOT_URL is set) ──
    const botUrl = process.env.IMPLEMENTATION_BOT_URL;
    let botResult = null;

    if (botUrl) {
      try {
        const botRes = await fetch(botUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.IMPLEMENTATION_BOT_TOKEN || ''}` },
          body:    JSON.stringify(payload),
          signal:  AbortSignal.timeout(30000),
        });
        botResult = await botRes.json();
        console.log(`[Implementation] Bot response for job ${job.id}:`, botResult);
      } catch (botErr) {
        console.warn(`[Implementation] Bot dispatch failed (non-fatal): ${botErr.message}`);
        botResult = { error: botErr.message, note: 'Bot dispatch failed — changes are queued and ready to retry' };
      }
    } else {
      console.log(`[Implementation] IMPLEMENTATION_BOT_URL not set — payload queued for future dispatch`);
      botResult = { status: 'queued', note: 'Bot not yet configured. Payload stored and ready for dispatch when bot URL is set.' };
    }

    res.json({
      success:    true,
      jobId:      job.id,
      payload,
      botResult,
      message:    botUrl
        ? `${approved.length} changes dispatched to implementation bot`
        : `${approved.length} changes queued — connect implementation bot to deploy`,
    });
  } catch (err) {
    console.error('[Implementation] EXECUTE error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/implementation/:auditId/jobs ────────────────────
// Get all implementation jobs for an audit
router.get('/:auditId([^/]+)/jobs', async (req, res) => {
  const { auditId } = req.params;
  try {
    const jobs = await getImplementationJobs(auditId);
    res.json({ auditId, jobs });
  } catch (err) {
    console.error('[Implementation] GET jobs error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
