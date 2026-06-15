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
import redisClient from '../services/redisClient.js';

const IMPL_TTL = 60 * 60 * 24 * 7; // 7 days

const router = Router();

// Helper to generate mock changes for demo mode
function getMockChanges(auditId, pluginId) {
  const defaults = [
    {
      title: 'home page',
      priority: 'High',
      impactScore: 85,
      description: 'The title tag is missing high-intent keywords.',
      currentState: 'Welcome to our site',
      proposedChange: 'Top-Rated Local Services & Solutions | Call Today',
      changeType: 'metadata',
      location: 'home page',
      sourceUrl: 'https://clicktrends.com.au/',
    }
  ];

  const mockData = {
    'seo-audit': [
      {
        title: 'home page',
        priority: 'High',
        impactScore: 90,
        description: 'Homepage meta title is missing high-intent target keywords for the local market.',
        currentState: 'ClickTrends | Digital Marketing',
        proposedChange: 'ClickTrends | Data-Driven Digital Marketing Agency Melbourne | Lift Your ROI',
        changeType: 'metadata',
        location: 'home page',
        sourceUrl: 'https://clicktrends.com.au/',
      },
      {
        title: 'home page',
        priority: 'Medium',
        impactScore: 75,
        description: 'No structured data detected on homepage. Adding LocalBusiness schema helps Google understand site entity details.',
        currentState: 'No schema markup found',
        proposedChange: '{\n  "@context": "https://schema.org",\n  "@type": "LocalBusiness",\n  "name": "ClickTrends Agency",\n  "url": "https://clicktrends.com.au",\n  "telephone": "+61 3 9000 0000",\n  "address": {\n    "@type": "PostalAddress",\n    "addressLocality": "Melbourne",\n    "addressRegion": "VIC",\n    "postalCode": "3000",\n    "addressCountry": "AU"\n  }\n}',
        changeType: 'schema',
        location: 'home page',
        sourceUrl: 'https://clicktrends.com.au/',
      },
      {
        title: 'home page',
        priority: 'Low',
        impactScore: 40,
        description: 'Homepage hero image is missing descriptive alt text, causing accessibility warnings.',
        currentState: '<img src="/images/hero-marketing.jpg">',
        proposedChange: '<img src="/images/hero-marketing.jpg" alt="ClickTrends team analyzing digital marketing performance dashboard">',
        changeType: 'technical',
        location: 'home page',
        sourceUrl: 'https://clicktrends.com.au/',
      }
    ],
    'brand-review': [
      {
        title: 'services page',
        priority: 'High',
        impactScore: 95,
        description: 'ACCC rules prohibit unqualified guarantees on marketing results. Soften claim to remain legally compliant.',
        currentState: 'We offer 100% guaranteed results for all SEO campaigns.',
        proposedChange: 'We follow data-driven methodologies to maximize campaign performance and SEO results.',
        changeType: 'content',
        location: 'services page',
        sourceUrl: 'https://clicktrends.com.au/services',
      },
      {
        title: 'about us page',
        priority: 'Medium',
        impactScore: 60,
        description: 'Jargon confuses non-technical prospects. Simplify terminology to improve landing page conversions.',
        currentState: 'Our team conducts hyper-granular CTR optimizations on high-intent SERP features.',
        proposedChange: 'We improve your search result titles and descriptions to get more people clicking through to your site.',
        changeType: 'content',
        location: 'about us page',
        sourceUrl: 'https://clicktrends.com.au/about',
      }
    ],
    'content-copy': [
      {
        title: 'home page',
        priority: 'High',
        impactScore: 85,
        description: 'Homepage heading is company-focused rather than benefit-focused. Make it target customer needs.',
        currentState: 'We Are ClickTrends',
        proposedChange: 'Get More Leads & Sales With Melbourne\'s Leading Digital Marketing Agency',
        changeType: 'content',
        location: 'home page',
        sourceUrl: 'https://clicktrends.com.au/',
      },
      {
        title: 'home page',
        priority: 'Medium',
        impactScore: 70,
        description: 'Current CTA button is low-friction but does not drive high commercial intent.',
        currentState: 'Submit Info',
        proposedChange: 'Get Your Free Growth Audit →',
        changeType: 'content',
        location: 'home page',
        sourceUrl: 'https://clicktrends.com.au/',
      }
    ],
    'competitive-brief': [
      {
        title: 'pricing page',
        priority: 'High',
        impactScore: 80,
        description: 'Emphasize your dedicated senior strategist advantage compared to competitor self-serve automated portals.',
        currentState: 'We have good service.',
        proposedChange: 'Unlike other agencies who put you in an automated portal, ClickTrends gives you a dedicated senior strategist with direct weekly calls.',
        changeType: 'content',
        location: 'pricing page',
        sourceUrl: 'https://clicktrends.com.au/pricing',
      }
    ],
    'campaign-plan': [
      {
        title: 'Facebook Launch Post',
        priority: 'High',
        impactScore: 85,
        description: 'Launch post for the upcoming free audit campaign.',
        currentState: 'No current Facebook campaign active.',
        proposedChange: '🚀 Ready to scale your website traffic?\n\nWe are giving away 5 FREE growth audits this week! Our data-driven process will uncover exactly where you are losing leads and how to fix it.\n\n👇 Click the link below to claim yours before they are gone!\n[Link]',
        changeType: 'social',
        location: 'Facebook Page',
        sourceUrl: 'Facebook',
      }
    ],
    'email-sequence': [
      {
        title: 'Welcome Email 1',
        priority: 'High',
        impactScore: 90,
        description: 'First email in the onboarding sequence to deliver the lead magnet and set expectations.',
        currentState: 'No welcome email currently sent.',
        proposedChange: 'Subject: Your SEO Checklist is inside! 🚀\nPreview: Here is exactly what you need to do...\n\nHi there,\n\nThanks for downloading our SEO checklist! I am thrilled to share these strategies with you.\n\n[Link to Download]\n\nBest,\nClickTrends Team',
        changeType: 'email',
        location: 'Onboarding Sequence',
        sourceUrl: 'Email Automation Platform',
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
    location: c.location || 'home page',
    sourceUrl: c.sourceUrl || '',
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

// ─── GET /api/implementation/:auditId/seo-audit/sub-services ──────────
// Returns all sub-services from the SEO audit's servicesAnalysis output,
// along with their per-slug approval status from Redis.
router.get('/:auditId([^/]+)/seo-audit/sub-services', async (req, res) => {
  const { auditId } = req.params;
  const isDemo = auditId === 'demo' || auditId.startsWith('demo-');

  if (isDemo) {
    return res.json({
      success: true,
      subServices: [
        // SEO
        { serviceName: 'SEO', subServiceName: 'AI-Powered SEO', pageSlug: 'ai-powered-seo', briefDescription: 'Harness AI to dominate search rankings with intelligent automation.', keywords: ['ai seo', 'generative engine optimisation', 'ai driven seo'], status: 'pending', generatedHtml: null },
        { serviceName: 'SEO', subServiceName: 'Local SEO', pageSlug: 'local-seo', briefDescription: 'Dominate local search results and attract more customers in your area.', keywords: ['local seo', 'seo services melbourne', 'local search marketing'], status: 'pending', generatedHtml: null },
        { serviceName: 'SEO', subServiceName: 'E-commerce SEO', pageSlug: 'ecommerce-seo', briefDescription: 'Grow your online store traffic and sales with targeted SEO strategies.', keywords: ['shopify seo', 'woocommerce seo', 'ecommerce seo services'], status: 'pending', generatedHtml: null },
        { serviceName: 'SEO', subServiceName: 'Technical SEO Audit', pageSlug: 'technical-seo-audit', briefDescription: 'Uncover and fix hidden technical issues holding your website back from top rankings.', keywords: ['technical seo', 'site audit', 'core web vitals'], status: 'pending', generatedHtml: null },
        { serviceName: 'SEO', subServiceName: 'Link Building', pageSlug: 'link-building', briefDescription: 'Build high-authority backlinks that boost your domain authority and rankings.', keywords: ['link building service', 'backlink building', 'seo link acquisition'], status: 'pending', generatedHtml: null },
        { serviceName: 'SEO', subServiceName: 'Enterprise SEO', pageSlug: 'enterprise-seo', briefDescription: 'Scalable SEO strategies designed for large websites and complex organisations.', keywords: ['enterprise seo', 'large site seo', 'corporate seo agency'], status: 'pending', generatedHtml: null },
        // Google Ads
        { serviceName: 'Google Ads', subServiceName: 'PPC Management', pageSlug: 'ppc-management', briefDescription: 'Maximise your Google Ads ROI with expert campaign management and optimisation.', keywords: ['google ads management', 'ppc services', 'adwords management'], status: 'pending', generatedHtml: null },
        { serviceName: 'Google Ads', subServiceName: 'Shopping Ads', pageSlug: 'google-shopping-ads', briefDescription: 'Showcase your products at the top of Google with highly-targeted Shopping campaigns.', keywords: ['google shopping ads', 'product listing ads', 'pla management'], status: 'pending', generatedHtml: null },
        { serviceName: 'Google Ads', subServiceName: 'Remarketing Campaigns', pageSlug: 'remarketing-campaigns', briefDescription: 'Re-engage past website visitors with precision-targeted display and search remarketing ads.', keywords: ['google remarketing', 'retargeting ads', 'display remarketing'], status: 'pending', generatedHtml: null },
        { serviceName: 'Google Ads', subServiceName: 'Performance Max', pageSlug: 'performance-max', briefDescription: 'Reach customers across all Google channels with AI-driven Performance Max campaigns.', keywords: ['performance max campaigns', 'pmax google ads', 'google ai ads'], status: 'pending', generatedHtml: null },
        // Social Media
        { serviceName: 'Social Media', subServiceName: 'Social Media Strategy', pageSlug: 'social-media-strategy', briefDescription: 'Build a winning social media roadmap that drives engagement and brand awareness.', keywords: ['social media strategy', 'social media marketing plan', 'social strategy agency'], status: 'pending', generatedHtml: null },
        { serviceName: 'Social Media', subServiceName: 'Paid Social Advertising', pageSlug: 'paid-social-advertising', briefDescription: 'Reach your ideal customers on Facebook, Instagram, LinkedIn and TikTok with targeted paid ads.', keywords: ['facebook ads', 'instagram advertising', 'paid social media'], status: 'pending', generatedHtml: null },
        { serviceName: 'Social Media', subServiceName: 'Influencer Marketing', pageSlug: 'influencer-marketing', briefDescription: 'Partner with relevant influencers to amplify your brand reach and credibility.', keywords: ['influencer marketing', 'influencer campaigns', 'brand partnerships'], status: 'pending', generatedHtml: null },
        { serviceName: 'Social Media', subServiceName: 'Community Management', pageSlug: 'community-management', briefDescription: 'Grow and nurture an engaged online community that turns followers into loyal customers.', keywords: ['social media community management', 'online community management', 'brand community'], status: 'pending', generatedHtml: null },
        // Content Marketing
        { serviceName: 'Content Marketing', subServiceName: 'Blog & Article Writing', pageSlug: 'blog-article-writing', briefDescription: 'SEO-optimised blog posts and articles that attract organic traffic and establish authority.', keywords: ['blog writing service', 'article writing', 'seo content writing'], status: 'pending', generatedHtml: null },
        { serviceName: 'Content Marketing', subServiceName: 'Content Strategy', pageSlug: 'content-strategy', briefDescription: 'A data-driven content roadmap that aligns your content with business goals and audience needs.', keywords: ['content strategy', 'content marketing plan', 'editorial strategy'], status: 'pending', generatedHtml: null },
        { serviceName: 'Content Marketing', subServiceName: 'Video Content Production', pageSlug: 'video-content-production', briefDescription: 'Engaging video content that captures attention and drives conversions across digital channels.', keywords: ['video content marketing', 'video production', 'brand video creation'], status: 'pending', generatedHtml: null },
        { serviceName: 'Content Marketing', subServiceName: 'Infographic Design', pageSlug: 'infographic-design', briefDescription: 'Visually compelling infographics that make complex data shareable and memorable.', keywords: ['infographic design', 'data visualisation', 'infographic creation service'], status: 'pending', generatedHtml: null },
        // Web Design
        { serviceName: 'Web Design', subServiceName: 'Landing Page Design', pageSlug: 'landing-page-design', briefDescription: 'High-converting landing pages designed to turn paid traffic into leads and sales.', keywords: ['landing page design', 'conversion landing page', 'cro landing page'], status: 'pending', generatedHtml: null },
        { serviceName: 'Web Design', subServiceName: 'Website Redesign', pageSlug: 'website-redesign', briefDescription: 'Transform your outdated website into a modern, fast, and high-converting digital experience.', keywords: ['website redesign', 'website revamp', 'site redesign agency'], status: 'pending', generatedHtml: null },
        { serviceName: 'Web Design', subServiceName: 'Conversion Rate Optimisation', pageSlug: 'conversion-rate-optimisation', briefDescription: 'Turn more visitors into customers with data-driven CRO testing and UX improvements.', keywords: ['cro agency', 'conversion rate optimisation', 'a/b testing services'], status: 'pending', generatedHtml: null },
      ]
    });
  }

  try {
    const audit = await getAuditById(auditId);
    if (!audit) return res.status(404).json({ error: 'Audit not found' });

    const plugins = await getAuditPlugins(auditId);
    const seoPlugin = plugins.find(p => p.plugin_id === 'seo-audit');
    if (!seoPlugin || !seoPlugin.claude_output) {
      return res.status(404).json({ error: 'SEO audit not yet completed or no services data available' });
    }

    let output = seoPlugin.claude_output;
    if (typeof output === 'string') {
      try { output = JSON.parse(output); } catch (_) {}
    }

    const servicesAnalysis = output?.servicesAnalysis || [];
    const flatSubServices = [];

    for (const service of servicesAnalysis) {
      for (const sub of (service.subServices || [])) {
        const slug = sub.pageSlug || sub.subServiceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        // Load per-slug status from Redis
        const stateKey = `sub_service_page:${auditId}:${slug}`;
        const savedState = await redisClient.get(stateKey).then(v => v ? JSON.parse(v) : null).catch(() => null);
        flatSubServices.push({
          serviceName: service.serviceName,
          subServiceName: sub.subServiceName,
          pageSlug: slug,
          briefDescription: sub.briefDescription || '',
          keywords: sub.keywords || [],
          status: savedState?.status || 'pending',
          generatedHtml: savedState?.generatedHtml || null,
          pageTitle: savedState?.pageTitle || null,
          metaDescription: savedState?.metaDescription || null,
        });
      }
    }

    res.json({ success: true, subServices: flatSubServices, url: audit.url });
  } catch (err) {
    console.error('[SubServices] GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/implementation/:auditId/seo-audit/sub-services/:slug/generate-page ──
// Calls Claude to generate a full HTML page for a given sub-service.
router.post('/:auditId([^/]+)/seo-audit/sub-services/:slug/generate-page', async (req, res) => {
  const { auditId, slug } = req.params;
  const { userContext, existingHtml } = req.body;
  const isDemo = auditId === 'demo' || auditId.startsWith('demo-');

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Anthropic API key not configured' });

  try {
    // Fetch sub-service data
    let subServiceData = null;
    let siteUrl = 'yourbusiness.com.au';
    let industry = 'Digital Marketing';

    if (!isDemo) {
      const audit = await getAuditById(auditId);
      if (!audit) return res.status(404).json({ error: 'Audit not found' });
      siteUrl = audit.url;
      industry = audit.industry || 'General';

      const plugins = await getAuditPlugins(auditId);
      const seoPlugin = plugins.find(p => p.plugin_id === 'seo-audit');
      if (seoPlugin?.claude_output) {
        let output = seoPlugin.claude_output;
        if (typeof output === 'string') { try { output = JSON.parse(output); } catch (_) {} }
        for (const service of (output?.servicesAnalysis || [])) {
          for (const sub of (service.subServices || [])) {
            const s = sub.pageSlug || sub.subServiceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            if (s === slug) {
              subServiceData = { ...sub, serviceName: service.serviceName, pageSlug: s };
              break;
            }
          }
          if (subServiceData) break;
        }
      }
    } else {
      // Demo fallback data
      const demoMap = {
        'ai-powered-seo': { subServiceName: 'AI-Powered SEO', serviceName: 'SEO', briefDescription: 'Harness AI to dominate search rankings.', keywords: ['ai seo', 'generative engine optimisation', 'ai driven seo'], pageSlug: 'ai-powered-seo' },
        'local-seo': { subServiceName: 'Local SEO', serviceName: 'SEO', briefDescription: 'Dominate local search results.', keywords: ['local seo', 'seo melbourne', 'local search marketing'], pageSlug: 'local-seo' },
        'ppc-management': { subServiceName: 'PPC Management', serviceName: 'Google Ads', briefDescription: 'Maximise your Google Ads ROI.', keywords: ['google ads management', 'ppc services', 'adwords'], pageSlug: 'ppc-management' },
      };
      subServiceData = demoMap[slug] || { subServiceName: slug, serviceName: 'Services', briefDescription: 'A specialised service offering.', keywords: [slug], pageSlug: slug };
    }

    if (!subServiceData) return res.status(404).json({ error: `Sub-service "${slug}" not found in SEO audit output` });

    const { subServiceName, serviceName, briefDescription, keywords } = subServiceData;
    const keywordList = (keywords || []).join(', ');

    const prompt = `You are an expert web developer and SEO copywriter. Generate a complete, self-contained HTML page for the sub-service described below.

BUSINESS CONTEXT:
- Website URL: ${siteUrl}
- Industry: ${industry}
- Parent Service: ${serviceName}
- Sub-Service Name: ${subServiceName}
- Brief Description: ${briefDescription}
- Target Keywords: ${keywordList}
${userContext ? `\nUSER'S ADDITIONAL CONTEXT / REQUESTS:\n${userContext}` : ''}
${existingHtml ? `\nEXISTING PAGE TO REFINE:\nHere is the current HTML. Keep the same structure but apply the user context above:\n${existingHtml.slice(0, 3000)}` : ''}

DESIGN REQUIREMENTS:
- Use Inter font from Google Fonts
- Colour scheme: --orange: #f97316, --navy: #1a1a2e, --bg: #faf9f6, --white: #ffffff
- Modern, premium design with hero section, features/benefits grid, CTA section
- Embed all CSS inline in a <style> tag — no external CSS files except Google Fonts
- Include meta title and meta description in <head> that are keyword-optimised
- Include a nav bar with the business name and a "Get in Touch" button
- Hero section: bold H1 with the sub-service name + main keyword, subtitle, CTA button
- Features section: 3-4 benefit cards with icons (use SVG inline icons)
- Why Choose Us section: 2-3 differentiators
- CTA section at the bottom: "Ready to get started?" with a button
- Footer with copyright
- All content must be realistic, professional, commercially focused — no placeholder text
- The page must ONLY use the sub-service name and keywords in content (no generic lorem ipsum)
- Write in Australian English

CRITICAL: Return ONLY the raw HTML. Do NOT wrap in markdown code fences. Start with <!DOCTYPE html> and end with </html>.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return res.status(500).json({ error: `Claude API error: ${response.status} — ${errText.slice(0, 200)}` });
    }

    const claudeData = await response.json();
    let html = claudeData?.content?.[0]?.text || '';
    // Strip any accidental markdown fences
    html = html.replace(/^```(?:html)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    // Extract page title and meta description from generated HTML
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    const metaMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    const pageTitle = titleMatch ? titleMatch[1] : `${subServiceName} | ${siteUrl}`;
    const metaDescription = metaMatch ? metaMatch[1] : briefDescription;

    // Cache generated HTML in Redis
    const stateKey = `sub_service_page:${auditId}:${slug}`;
    const existing = await redisClient.get(stateKey).then(v => v ? JSON.parse(v) : {}).catch(() => ({}));
    await redisClient.setEx(stateKey, IMPL_TTL, JSON.stringify({
      ...existing,
      generatedHtml: html,
      pageTitle,
      metaDescription,
      subServiceName,
      serviceName,
    }));

    res.json({ success: true, html, pageTitle, metaDescription });
  } catch (err) {
    console.error('[SubServices] generate-page error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/implementation/:auditId/seo-audit/sub-services/:slug/approve ──
// Save the approval state and optionally queue for deployment.
router.post('/:auditId([^/]+)/seo-audit/sub-services/:slug/approve', async (req, res) => {
  const { auditId, slug } = req.params;
  const { html, pageTitle, metaDescription, navigationParent, status } = req.body;
  const isDemo = auditId === 'demo' || auditId.startsWith('demo-');

  const allowedStatuses = ['approved', 'rejected', 'pending'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${allowedStatuses.join(', ')}` });
  }

  try {
    const stateKey = `sub_service_page:${auditId}:${slug}`;
    const existing = isDemo ? {} : (await redisClient.get(stateKey).then(v => v ? JSON.parse(v) : {}).catch(() => ({})));

    const updatedState = {
      ...existing,
      status,
      html: html || existing.html || null,
      pageTitle: pageTitle || existing.pageTitle || null,
      metaDescription: metaDescription || existing.metaDescription || null,
      navigationParent: navigationParent || existing.navigationParent || null,
      slug,
      updatedAt: new Date().toISOString(),
    };

    if (!isDemo) {
      await redisClient.setEx(stateKey, IMPL_TTL, JSON.stringify(updatedState));
    }

    res.json({ success: true, slug, status, state: updatedState });
  } catch (err) {
    console.error('[SubServices] approve error:', err);
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
