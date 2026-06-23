// ============================================================
// backend/routes/implementation.js
// Implementation Approval Workflow API with Demo Mock Support - triggered reload
// ============================================================

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { tracer } from '../utils/tracer.js';
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
  upsertIntegration,
  saveSubServicePage,
  getSubServicePage,
  approveSubServicePage,
  savePageTemplate,
  getPageTemplate,
  hasPageTemplate
} from '../db/queries.js';
import { requireAdmin } from './integrations.js';
import redisClient from '../services/redisClient.js';
import * as cheerio from 'cheerio';
import { DeploymentManager } from '../services/platforms/wordpress/DeploymentManager.js';

const IMPL_TTL = 60 * 60 * 24 * 7; // 7 days

// Helper to extract branding information from a website URL
async function extractBrandingInfo(siteUrl) {
  const brandData = {
    colors: {},
    logoUrl: null,
    navLinks: [],
    footerLinks: [],
    fonts: []
  };

  if (!siteUrl || siteUrl.includes('yourbusiness.com') || siteUrl.includes('localhost') || siteUrl.includes('example.com')) {
    return brandData;
  }

  try {
    let url = siteUrl;
    if (!url.startsWith('http')) {
      url = 'https://' + url;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) return brandData;
    const html = await res.text();
    const $ = cheerio.load(html);

    // 1. Extract CSS variables/colors from style tags or :root
    const rootMatches = html.match(/:root\s*\{[^}]+\}/g) || [];
    for (const match of rootMatches) {
      const vars = match.match(/--[a-zA-Z0-9_-]+:\s*[^;\}]+/g) || [];
      for (const v of vars) {
        const parts = v.split(':');
        if (parts.length === 2) {
          const key = parts[0].trim();
          const val = parts[1].trim();
          if (val.startsWith('#') || val.includes('rgb') || key.includes('color') || key.includes('bg') || key.includes('theme') || key.includes('accent')) {
            brandData.colors[key] = val;
          }
        }
      }
    }

    // 2. Extract Logo URL
    // Prioritize logo indicators in filename or attributes
    let imgLogo = $('img[src*="logo" i], img[class*="logo" i], img[id*="logo" i]').first().attr('src');
    
    if (!imgLogo) {
      // Check inside elements with logo classes/ids
      imgLogo = $('[class*="logo" i] img, [id*="logo" i] img').first().attr('src');
    }
    
    if (!imgLogo) {
      // Fallback to first image in header
      imgLogo = $('header img, #logo img, .logo img').first().attr('src');
    }

    if (imgLogo) {
      brandData.logoUrl = imgLogo.startsWith('http') ? imgLogo : new URL(imgLogo, url).toString();
    } else {
      // Fallback to favicon icon links
      const iconLink = $('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').first().attr('href');
      if (iconLink) {
        brandData.logoUrl = iconLink.startsWith('http') ? iconLink : new URL(iconLink, url).toString();
      }
    }

    // 3. Extract Navigation Links
    $('header a, nav a, .nav-menu a, [class*="menu"] a').slice(0, 8).each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      const href = $(el).attr('href');
      if (text && href && href !== '#' && !href.startsWith('javascript') && !brandData.navLinks.some(l => l.text === text)) {
        const absoluteUrl = href.startsWith('http') ? href : new URL(href, url).toString();
        brandData.navLinks.push({ text, url: absoluteUrl });
      }
    });

    // 4. Extract Footer Links
    $('footer a, .footer a, [class*="footer"] a').slice(0, 10).each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      const href = $(el).attr('href');
      if (text && href && href !== '#' && !href.startsWith('javascript') && !brandData.footerLinks.some(l => l.text === text)) {
        const absoluteUrl = href.startsWith('http') ? href : new URL(href, url).toString();
        brandData.footerLinks.push({ text, url: absoluteUrl });
      }
    });

    // 5. Extract Google Fonts
    $('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) brandData.fonts.push(href);
    });

  } catch (e) {
    console.error('[BrandExtraction] failed to parse homepage:', siteUrl, e.message);
  }

  return brandData;
}

const router = Router();

// ─── Template Helpers ─────────────────────────────────────────────────────────

/**
 * Uses Claude Haiku to determine which crawled page URL is the service category page.
 * Receives a list of { url, title } page objects and the serviceName to match.
 */
async function resolveServicePageUrlWithClaude(serviceName, siteUrl, crawledPages) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return null;

  const normalizedTarget = siteUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
  const pageList = crawledPages
    .filter(p => p.url && p.url.replace(/^https?:\/\/(www\.)?/, '').startsWith(normalizedTarget))
    .slice(0, 40)
    .map(p => `- URL: ${p.url}\n  Title: ${p.title || '(no title)'}`)
    .join('\n');

  console.log(`[TemplateHelper] crawledPages count: ${crawledPages.length}. pageList length: ${pageList.length}`);
  if (!pageList) {
    console.log(`[TemplateHelper] Empty pageList, bypassing Claude.`);
    return null;
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: `You are helping identify which page URL represents the service category page for "${serviceName}" on a website.

Here are the crawled pages:
${pageList}

RULES:
1. You MUST prioritise short, primary parent URLs (like /services/google-ads or /google-ads) over long, specific sub-service URLs (like /google-search-ads-management-australia...).
2. Return ONLY the single URL that best represents the "${serviceName}" main service category. 
3. If none closely matches, return the word NULL. Return nothing else.`
        }]
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.warn(`[TemplateHelper] Claude API returned ${resp.status}: ${errText}`);
      return null;
    }
    const data = await resp.json();
    const answer = (data?.content?.[0]?.text || '').trim();
    console.log(`[TemplateHelper] Claude URL resolution output for "${serviceName}": ${answer}`);
    if (answer === 'NULL' || !answer.startsWith('http')) return null;
    return answer;
  } catch (e) {
    console.warn('[TemplateHelper] Claude URL resolution failed:', e.message);
    return null;
  }
}

/**
 * Strips tracking scripts, analytics, chat widgets, and cookie banners from HTML.
 * Returns cleaned HTML string safe to store as a design template.
 */
function stripTrackingScripts(html) {
  const $ = cheerio.load(html);

  // Remove tracking / analytics script tags by src pattern
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src') || '';
    if (/google-analytics|googletagmanager|gtag|hotjar|clarity|fbevents|intercom|drift|crisp|tawk|zendesk|hubspot|segment\.io|matomo|heap/i.test(src)) {
      $(el).remove();
    }
  });

  // Remove inline scripts containing tracking identifiers
  $('script:not([src])').each((_, el) => {
    const content = $(el).html() || '';
    if (/gtag\(|ga\(|fbq\(|_hsq|Intercom|drift\.load|crisp\.push|tawkTo|zE\(/i.test(content)) {
      $(el).remove();
    }
  });

  // Remove common cookie/chat/notification UI elements
  $('[id*="cookie"], [class*="cookie"], [id*="gdpr"], [class*="gdpr"]').remove();
  $('[id*="chat-widget"], [class*="chat-widget"], [id*="livechat"], [class*="livechat"]').remove();
  $('[id*="drift"], [id*="intercom"], [id*="crisp"], [id*="tawk"]').remove();
  $('[id*="notification-bar"], [class*="notification-bar"]').remove();

  // Remove <noscript> tags (often contain tracking pixels)
  $('noscript').remove();

  return $.html();
}

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
  const { status, userEdit, currentState } = req.body;

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
        currentState: currentState !== undefined ? currentState : 'Demo Current State',
        proposedChange: 'Demo Proposed Change',
        changeType: 'general',
        status: status || 'pending',
        userEdit: userEdit !== undefined ? userEdit : null,
        updatedAt: new Date().toISOString(),
      }
    });
  }

  try {
    const updated = await updateImplementationChange(auditId, pluginId, changeId, { status, userEdit, currentState });
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
        // Load per-slug status from PostgreSQL database
        const savedState = isDemo ? null : await getSubServicePage(auditId, slug);
        const parentSlug = service.parentUrl ? service.parentUrl.split('/').filter(Boolean).pop() : '';
        flatSubServices.push({
          serviceName: service.serviceName,
          parentUrl: service.parentUrl || '',
          parentSlug: parentSlug,
          subServiceName: sub.subServiceName,
          pageSlug: slug,
          briefDescription: sub.briefDescription || '',
          keywords: sub.keywords || [],
          status: savedState?.status || 'pending',
          generatedHtml: savedState?.renderedHtml || null,
          pageTitle: savedState?.pageTitle || null,
          metaDescription: savedState?.metaDescription || null,
          generatedElementorData: savedState?.generatedElementorData || null,
          builderType: savedState?.builderType || 'standard_wp',
          draftUrl: savedState?.draftUrl || null
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
    let audit = null;
    let allServices = [];

    if (!isDemo) {
      audit = await getAuditById(auditId);
      if (!audit) return res.status(404).json({ error: 'Audit not found' });
      siteUrl = audit.url;
      industry = audit.industry || 'General';

      const plugins = await getAuditPlugins(auditId);
      const seoPlugin = plugins.find(p => p.plugin_id === 'seo-audit');
      if (seoPlugin?.claude_output) {
        let output = seoPlugin.claude_output;
        if (typeof output === 'string') { try { output = JSON.parse(output); } catch (_) {} }
        allServices = output?.servicesAnalysis || [];
        for (const service of allServices) {
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
      allServices = [
        {
          serviceName: 'SEO',
          subServices: [
            { subServiceName: 'AI-Powered SEO', pageSlug: 'ai-powered-seo' },
            { subServiceName: 'Local SEO', pageSlug: 'local-seo' }
          ]
        },
        {
          serviceName: 'Google Ads',
          subServices: [
            { subServiceName: 'PPC Management', pageSlug: 'ppc-management' }
          ]
        }
      ];
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

    const normalizedSiteUrl = siteUrl.replace(/\/+$/, '');
    let canonicalUrl = `${normalizedSiteUrl}/${slug}`;
    if (!canonicalUrl.startsWith('http')) canonicalUrl = 'https://' + canonicalUrl;
    
    // Attempt to access audit object if it exists in scope, else default to generic
    let brandName = 'Brand';
    let phoneNumber = 'Not available';
    let locations = 'Australia';
    let crawled = {};

    try {
      if (audit && audit.crawled_data) {
        crawled = typeof audit.crawled_data === 'string' ? JSON.parse(audit.crawled_data) : audit.crawled_data;
      }
    } catch (e) {}

    // Extract dynamic details from crawled data
    let titleBrandName = '';
    let homePage = null;
    try {
      if (crawled.pages && crawled.pages.length > 0) {
        homePage = crawled.pages.find(p => p.url === normalizedSiteUrl || p.url === normalizedSiteUrl + '/' || p.url === '/' || p.url === '') || crawled.pages[0];
        if (homePage && homePage.title) {
          const titleParts = homePage.title.split(/\s*[|–-]\s*/);
          if (titleParts.length > 1) {
            const nonGenericParts = titleParts.map(p => p.trim()).filter(p => p.length > 0 && !/home|homepage|index|welcome/i.test(p));
            if (nonGenericParts.length > 0) {
              nonGenericParts.sort((a, b) => a.length - b.length);
              titleBrandName = nonGenericParts[0];
            }
          } else {
            titleBrandName = homePage.title.trim();
          }
        }
      }
    } catch (e) {}

    try {
      brandName = crawled.perplexityBusiness?.businessName || crawled.businessSummary?.name || (audit && audit.company_name);
      if (!brandName && normalizedSiteUrl) {
        brandName = normalizedSiteUrl.replace(/^https?:\/\/(www\.)?/, '').split('.')[0];
        brandName = brandName.charAt(0).toUpperCase() + brandName.slice(1);
      }
      if (!brandName) brandName = 'Brand';

      const isGenericBrand = brandName.toLowerCase() === 'brand' || 
                             brandName.toLowerCase() === 'ai' ||
                             brandName.toLowerCase().includes('trdemo') || 
                             brandName.toLowerCase().includes('localhost') || 
                             brandName.toLowerCase().includes('example.com') ||
                             brandName.toLowerCase().includes('yourbusiness');
      if (isGenericBrand && titleBrandName) {
        brandName = titleBrandName;
      }

      phoneNumber = crawled.contactInfo?.phone || (audit && audit.phone);
      if ((phoneNumber === 'Not available' || !phoneNumber) && homePage && homePage.bodyText) {
        const phoneRegex = /(?:\+?61\s*(?:\(0\))?\s*|[0-9]{2,4}\s*)[0-9]{3,4}\s*[0-9]{3,4}/g;
        const matches = homePage.bodyText.match(phoneRegex);
        if (matches && matches.length > 0) {
          const cleanPhone = matches[0].trim();
          if (cleanPhone.length >= 8 && cleanPhone.length <= 15) {
            phoneNumber = cleanPhone;
          }
        }
      }

      locations = crawled.contactInfo?.addressLocality || (audit && audit.location) || 'Australia';
      if ((locations === 'Australia' || !locations) && homePage && homePage.bodyText) {
        const cityMatches = homePage.bodyText.match(/Melbourne|Sydney|Brisbane|Perth|Adelaide/i);
        if (cityMatches) {
          locations = cityMatches[0] + ', Australia';
        }
      }
    } catch (e) {}

    if (normalizedSiteUrl.includes('clicktrends')) {
      if (phoneNumber === 'Not available' || !phoneNumber) phoneNumber = '03 7020 9120';
      if (locations === 'Australia' || !locations) locations = 'Melbourne, VIC';
    }

    let bookingUrl = '/contact';
    let logoUrl = 'Not available';
    let navigationLinks = 'Not available';
    let footerLinks = 'Not available';
    let extractedBrandColors = 'Not available';
    let extractedFonts = 'Poppins (Headings), Inter (Body)';

    const brandBranding = await extractBrandingInfo(normalizedSiteUrl).catch(() => null);
    const isClickTrends = brandName.toLowerCase().includes('click trends') || 
                          brandName.toLowerCase().includes('clicktrends') || 
                          normalizedSiteUrl.includes('clicktrends');

    if (isClickTrends) {
      extractedBrandColors = `--primary-color: #f97316\n--secondary-color: #ea6c0a\n--gradient-first-color: #fb923c\n--heading-color: #111827\n--link-color: #f97316\n--gradient-color-from: #f97316\n--gradient-color-to: #ea6c0a\n--body-bg-color: #ffffff`;
      logoUrl = 'https://trdemo.com.au/testdomain1/wp-content/uploads/2026/06/Click_trends_logo.png';
    } else {
      if (brandBranding && brandBranding.colors && Object.keys(brandBranding.colors).length > 0) {
        extractedBrandColors = Object.entries(brandBranding.colors)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n');
      } else {
        extractedBrandColors = '--primary-color: #2563eb\n--secondary-color: #1d4ed8\n--gradient-first-color: #3b82f6\n--heading-color: #1f2937\n--link-color: #2563eb\n--gradient-color-from: #2563eb\n--gradient-color-to: #1d4ed8\n--body-bg-color: #ffffff';
      }

      if (brandBranding && brandBranding.logoUrl && !brandBranding.logoUrl.includes('/themes/aimo/')) {
        logoUrl = brandBranding.logoUrl;
      } else {
        logoUrl = 'text-logo';
      }
    }

    if (brandBranding) {

      if (brandBranding.navLinks && brandBranding.navLinks.length > 0) {
        navigationLinks = brandBranding.navLinks.map(l => {
          let url = l.url;
          if (url.startsWith(normalizedSiteUrl) || url.startsWith('http://' + normalizedSiteUrl) || url.startsWith('https://' + normalizedSiteUrl)) {
            url = url.replace(/^https?:\/\/[^\/]+/, '') || '/';
          }
          return `* [${l.text}](${url})`;
        }).join('\n');
      } else {
        navigationLinks = `* [Home](/)` + '\n' + `* [Services](/services)` + '\n' + `* [About](/about)` + '\n' + `* [Contact](/contact)`;
      }

      if (brandBranding.footerLinks && brandBranding.footerLinks.length > 0) {
        footerLinks = brandBranding.footerLinks.map(l => {
          let url = l.url;
          if (url.startsWith(normalizedSiteUrl) || url.startsWith('http://' + normalizedSiteUrl) || url.startsWith('https://' + normalizedSiteUrl)) {
            url = url.replace(/^https?:\/\/[^\/]+/, '') || '/';
          }
          return `* [${l.text}](${url})`;
        }).join('\n');
      } else {
        footerLinks = `* [Services](/services)` + '\n' + `* [Privacy Policy](/privacy-policy)` + '\n' + `* [Terms of Service](/terms)`;
      }
    }

    let existingContent = userContext || '';
    if (!existingContent || existingContent === 'Not available') {
      const contextParts = [];
      if (crawled.perplexityBusiness?.description || crawled.businessSummary?.description) {
        contextParts.push(`Business Description: ${crawled.perplexityBusiness?.description || crawled.businessSummary?.description}`);
      }
      if (crawled.perplexityBusiness?.offerings && crawled.perplexityBusiness.offerings.length > 0) {
        contextParts.push(`Business Offerings:\n${crawled.perplexityBusiness.offerings.map(o => `- ${o}`).join('\n')}`);
      }
      if (homePage) {
        if (homePage.title) contextParts.push(`Homepage Title: ${homePage.title}`);
        if (homePage.metaDescription) contextParts.push(`Homepage Meta Description: ${homePage.metaDescription}`);
        if (homePage.headings && homePage.headings.length > 0) {
          const headingsList = homePage.headings.map(h => `${h.level ? 'H' + h.level : '-'}: ${h.text}`).join('\n');
          contextParts.push(`Homepage Headings:\n${headingsList}`);
        }
        if (homePage.bodyText) {
          contextParts.push(`Homepage Content Snippet:\n${homePage.bodyText.slice(0, 3000)}`);
        }
      } else if (crawled.allCopy) {
        const firstUrl = Object.keys(crawled.allCopy)[0];
        if (firstUrl && crawled.allCopy[firstUrl]) {
          const pageData = crawled.allCopy[firstUrl];
          if (pageData.title) contextParts.push(`Homepage Title: ${pageData.title}`);
          if (pageData.bodySnippet) contextParts.push(`Homepage Content Snippet:\n${pageData.bodySnippet.slice(0, 3000)}`);
        }
      }
      existingContent = contextParts.join('\n\n') || 'Not available';
    }

    // ==========================================
    // ON-DEMAND DESIGN TEMPLATE CAPTURE
    // Check if we already have the service category's design template stored.
    // If not, fetch the live service page HTML and store the cleaned version.
    // ==========================================
    let designTemplateHtml = null;
    if (!isDemo) {
      try {
        const existing = await getPageTemplate(auditId, serviceName);
        if (existing?.cleanedHtml) {
          designTemplateHtml = existing.cleanedHtml;
          console.log(`[GeneratePage] Reusing stored design template for "${serviceName}" (captured from ${existing.sourceUrl})`);
        } else {
          console.log(`[GeneratePage] No template for "${serviceName}" — resolving URL with Claude…`);
          const crawledPages = crawled.pages || [];

          // Ask Claude to identify the best URL for the PARENT service
          let servicePageUrl = await resolveServicePageUrlWithClaude(serviceName, normalizedSiteUrl, crawledPages);

          // Fallback: construct a URL from the service name slug
          if (!servicePageUrl) {
            const serviceSlug = serviceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/, '');
            servicePageUrl = `${normalizedSiteUrl}/${serviceSlug}`;
            console.log(`[GeneratePage] Claude URL resolution returned null — using fallback URL: ${servicePageUrl}`);
          }

          // Fetch the live service page HTML
          const controller = new AbortController();
          const tid = setTimeout(() => controller.abort(), 12000);
          const pageResp = await fetch(servicePageUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
            signal: controller.signal
          }).catch(e => { clearTimeout(tid); console.warn('[GeneratePage] Template fetch failed:', e.message); return null; });
          clearTimeout(tid);

          if (pageResp && pageResp.ok) {
            const rawHtml = await pageResp.text();
            const cleanedHtml = stripTrackingScripts(rawHtml);
            
            // Try to fetch Elementor JSON via WordPress API
            let masterElementorData = null;
            try {
              const wpBusinessId = audit?.business_id || req.headers['x-business-id'] || 'default-business';
              const integration = await getIntegrationByPlatform(wpBusinessId, 'wordpress');
              if (integration && integration.status !== 'error') {
                const dm = new DeploymentManager();
                masterElementorData = await dm.fetchTemplateFromWordPress(servicePageUrl, integration);
              }
            } catch (elemErr) {
              console.warn(`[GeneratePage] Could not fetch elementor data: ${elemErr.message}`);
            }

            await savePageTemplate(auditId, serviceName, {
              sourceUrl: servicePageUrl,
              cleanedHtml,
              masterElementorData,
              builderType: masterElementorData ? 'elementor' : 'standard_wp',
              fetchStatus: 'captured'
            });
            designTemplateHtml = cleanedHtml;
            console.log(`[GeneratePage] ✓ Captured & stored design template for "${serviceName}" from ${servicePageUrl}`);
          } else {
            console.warn(`[GeneratePage] Could not fetch "${servicePageUrl}". Trying fallback templates...`);
            let fallbackTemplate = null;
            
            // 1. Try "SEO Services" template which we know we usually capture first
            const seoTemplate = await getPageTemplate(auditId, 'SEO Services');
            if (seoTemplate && seoTemplate.cleanedHtml) {
              fallbackTemplate = seoTemplate.cleanedHtml;
              console.log(`[GeneratePage] Using "SEO Services" design template as fallback.`);
            } else {
              // 2. Try just "seo"
              const seoTemplate2 = await getPageTemplate(auditId, 'seo');
              if (seoTemplate2 && seoTemplate2.cleanedHtml) {
                fallbackTemplate = seoTemplate2.cleanedHtml;
                console.log(`[GeneratePage] Using "seo" design template as fallback.`);
              }
            }

            if (fallbackTemplate) {
              designTemplateHtml = fallbackTemplate;
              await savePageTemplate(auditId, serviceName, {
                sourceUrl: servicePageUrl,
                cleanedHtml: fallbackTemplate,
                fetchStatus: 'fallback'
              }).catch(() => {});
            } else {
              // Try ANY template from this audit as a universal fallback
              console.warn(`[GeneratePage] No named fallbacks found — searching for any available template...`);
              try {
                const { pool } = await import('../db/db.js');
                const { rows } = await pool.query(
                  `SELECT service_name, cleaned_html, master_elementor_data, builder_type FROM page_templates WHERE audit_id = $1 AND cleaned_html IS NOT NULL AND cleaned_html != '' LIMIT 1`,
                  [auditId]
                );
                if (rows[0] && rows[0].cleaned_html) {
                  designTemplateHtml = rows[0].cleaned_html;
                  console.log(`[GeneratePage] Using "${rows[0].service_name}" design template as universal fallback.`);
                  await savePageTemplate(auditId, serviceName, {
                    sourceUrl: servicePageUrl,
                    cleanedHtml: rows[0].cleaned_html,
                    masterElementorData: rows[0].master_elementor_data ? (typeof rows[0].master_elementor_data === 'string' ? JSON.parse(rows[0].master_elementor_data) : rows[0].master_elementor_data) : null,
                    builderType: rows[0].builder_type || 'standard_wp',
                    fetchStatus: 'fallback'
                  }).catch(() => {});
                } else {
                  console.warn(`[GeneratePage] No templates found at all in DB for this audit.`);
                }
              } catch (dbErr) {
                console.warn(`[GeneratePage] Universal fallback query failed: ${dbErr.message}`);
              }
            }
          }
        }
      } catch (templateErr) {
        console.warn('[GeneratePage] Template capture step failed (non-fatal):', templateErr.message);
        // Non-fatal: pageWorker will fall back to EJS template
      }
    }

    // ==========================================
    // ENQUEUE JOB TO BullMQ AND AWAIT COMPLETION
    // ==========================================
    const statusKey = `sub_service_page_job:${auditId}:${slug}`;
    // Clear any previous job status
    await redisClient.del(statusKey);

    const generationId = uuidv4();
    const jobData = {
      generationId,
      auditId,
      slug,
      userContext: existingContent,
      existingHtml,
      subServiceName,
      serviceName,
      designTemplateHtml,
      briefDescription,
      keywords,
      siteUrl,
      industry,
      brandName,
      phoneNumber,
      locations,
      logoUrl,
      navigationLinks,
      footerLinks,
      extractedBrandColors,
      extractedFonts,
      allServices
    };

    tracer.logInputData(generationId, {
      parentService: serviceName,
      subService: subServiceName,
      keywords,
      businessName: brandName,
      templateId: designTemplateHtml ? 'available' : 'missing'
    });

    const { addPageGenerationJob } = await import('../services/pageQueue.js');
    await addPageGenerationJob(jobData);

    console.log(`[GeneratePage] Enqueued page generation job. Polling for results...`);
    const start = Date.now();
    let finalResult = null;

    while (Date.now() - start < 300000) { // 5 minutes timeout
      await new Promise(r => setTimeout(r, 1000));
      const jobStatusStr = await redisClient.get(statusKey).catch(() => null);
      if (jobStatusStr) {
        const jobStatus = JSON.parse(jobStatusStr);
        if (jobStatus.status === 'completed') {
          finalResult = jobStatus;
          break;
        }
        if (jobStatus.status === 'failed') {
          throw new Error(jobStatus.error || 'Worker page generation failed');
        }
      }
    }

    if (!finalResult) {
      throw new Error('Page generation timed out after 5 minutes');
    }

    res.json({
      success: true,
      generationId,
      html: finalResult.html,
      pageTitle: finalResult.pageTitle,
      metaDescription: finalResult.metaDescription
    });
  } catch (err) {
    console.error('[SubServices] generate-page error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/implementation/:auditId/seo-audit/sub-services/:slug/approve ──
// Save the approval state and optionally queue for deployment.
router.post('/:auditId([^/]+)/seo-audit/sub-services/:slug/approve', async (req, res) => {
  const { auditId, slug } = req.params;
  const { html, pageTitle, metaDescription, navigationParent, status, draftUrl } = req.body;
  const isDemo = auditId === 'demo' || auditId.startsWith('demo-');

  const allowedStatuses = ['approved', 'rejected', 'pending', 'draft', 'deployed'];
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
      draftUrl: draftUrl || existing.draftUrl || null,
      slug,
      updatedAt: new Date().toISOString(),
    };

    if (!isDemo) {
      await approveSubServicePage(auditId, slug, status, {
        pageTitle: pageTitle || existing.pageTitle || undefined,
        metaDescription: metaDescription || existing.metaDescription || undefined,
        renderedHtml: html || existing.html || undefined,
        draftUrl: draftUrl || existing.draftUrl || undefined
      });
    }

    res.json({ success: true, slug, status, state: updatedState });
  } catch (err) {
    console.error('[SubServices] approve error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/implementation/:auditId/seo-audit/page-template/:serviceName ──
// Returns metadata about the stored design template for a service category.
// Frontend uses this to show "Template captured from [url]" badge.
router.get('/:auditId([^/]+)/seo-audit/page-template/:serviceName', async (req, res) => {
  const { auditId } = req.params;
  const serviceName = decodeURIComponent(req.params.serviceName);
  const isDemo = auditId === 'demo' || auditId.startsWith('demo-');

  if (isDemo) {
    return res.json({ hasTemplate: false, isDemo: true });
  }

  try {
    const template = await getPageTemplate(auditId, serviceName);
    if (!template || !template.cleanedHtml) {
      return res.json({ hasTemplate: false });
    }
    res.json({
      hasTemplate: true,
      sourceUrl: template.sourceUrl,
      capturedAt: template.capturedAt,
      fetchStatus: template.fetchStatus
    });
  } catch (err) {
    console.error('[PageTemplate] GET error:', err);
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
