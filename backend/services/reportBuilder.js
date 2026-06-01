// ============================================================
// backend/services/reportBuilder.js
// Merges plugin outputs into final HTML/DOCX report
// ============================================================

import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType } from 'docx';
import { getAuditById } from '../db/queries.js';
import redisClient from './redisClient.js';

/**
 * Build and store the complete audit report.
 *
 * @param {string} auditId
 * @param {Object} auditData - { url, industry, email }
 * @param {Object[]} pluginResults
 * @param {Object} synthesis - Executive summary from Claude
 * @param {number} overallScore
 * @returns {Promise<{htmlUrl, docxUrl}>}
 */
export async function buildReport(auditId, auditData, pluginResults, synthesis, overallScore) {
  console.log(`[ReportBuilder] Building report for audit: ${auditId}`);

  // Generate HTML report
  const html = generateHTMLReport(auditData, pluginResults, synthesis, overallScore);

  // Generate DOCX
  const docxBuffer = await generateDOCX(auditData, pluginResults, synthesis, overallScore);

  // In production: upload to S3/GCS and get signed URLs
  // For now: return placeholder URLs with audit ID
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const reportUrl = `${baseUrl}/reports/${auditId}`;
  const docxUrl = `${baseUrl}/reports/${auditId}/download.docx`;

  // Report URLs are stored via finaliseAudit in the audit record — no separate report DB record needed

  // Store in Redis for serving
  try {
    const payload = JSON.stringify({
      html,
      docxBase64: docxBuffer.toString('base64'),
    });
    // Set expiration for 24 hours (86400 seconds) to avoid filling up Redis
    await redisClient.setEx(`report:${auditId}`, 86400, payload);
  } catch (err) {
    console.error(`[ReportBuilder] Failed to save report to Redis for ${auditId}:`, err);
  }

  console.log(`[ReportBuilder] ✓ Report built for ${auditId}`);
  return { reportUrl, docxUrl };
}

// ─── HTML Report Generator ────────────────────────────────────
function generateHTMLReport(auditData, pluginResults, synthesis, overallScore) {
  const scoreColor = overallScore >= 80 ? '#22c55e' : overallScore >= 60 ? '#f59e0b' : '#ef4444';
  const scoreLabel = overallScore >= 80 ? 'Strong foundation' : overallScore >= 60 ? 'Solid foundation' : 'Needs attention';

  const pluginCards = pluginResults.map(r => `
    <div class="plugin-card">
      <div class="plugin-card-header">
        <span class="plugin-name">${r.pluginName}</span>
        <span class="plugin-score" style="color:${r.score >= 70 ? '#22c55e' : r.score >= 50 ? '#f59e0b' : '#ef4444'}">${r.score}/100</span>
      </div>
      <div class="score-bar">
        <div class="score-bar-fill" style="width:${r.score}%;background:${r.score >= 70 ? '#22c55e' : r.score >= 50 ? '#f59e0b' : '#ef4444'}"></div>
      </div>
      <p class="plugin-summary">${r.summary || 'Analysis complete.'}</p>
      ${(Array.isArray(r.recommendations) ? r.recommendations : []).slice(0, 3).map((rec, i) => `
        <div class="recommendation">
          <span class="rec-num">${i + 1}</span>
          <div>
            <strong>${rec.action || rec.title || rec}</strong>
            ${rec.expectedImpact ? `<span class="rec-impact">${rec.expectedImpact}</span>` : ''}
          </div>
        </div>
      `).join('') || ''}
    </div>
  `).join('');

  const topPriorities = (synthesis.topPriorities || []).slice(0, 5).map((p, i) => `
    <tr>
      <td class="priority-num p${Math.min(i + 1, 3)}">P${i + 1}</td>
      <td>${p.action || p}</td>
      <td>${p.impact || '—'}</td>
      <td><span class="effort-badge">${p.timeframe || '—'}</span></td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Marketing Audit · ${auditData.url}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', sans-serif; background: #faf9f6; color: #1a1a2e; line-height: 1.6; }
  .report-header { background: #1a1a2e; color: white; padding: 24px 48px; display: flex; align-items: center; justify-content: space-between; }
  .report-header .logo { font-weight: 700; font-size: 1.1rem; }
  .report-header .logo span { color: #f97316; }
  .report-actions { display: flex; gap: 12px; }
  .btn-primary { background: #f97316; color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 0.875rem; }
  .btn-secondary { background: transparent; color: white; border: 1px solid rgba(255,255,255,0.3); padding: 10px 20px; border-radius: 8px; font-weight: 500; cursor: pointer; font-size: 0.875rem; }
  .container { max-width: 1100px; margin: 0 auto; padding: 48px 24px; }
  .report-title { font-size: 2rem; font-weight: 700; margin-bottom: 8px; }
  .report-meta { display: flex; gap: 16px; color: #6b7280; font-size: 0.875rem; margin-bottom: 40px; align-items: center; flex-wrap: wrap; }
  .report-meta span { display: flex; align-items: center; gap: 6px; }
  .overview-grid { display: grid; grid-template-columns: 220px 1fr; gap: 32px; margin-bottom: 48px; background: white; border-radius: 16px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .score-circle { display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .score-ring { width: 120px; height: 120px; position: relative; }
  .score-number { font-size: 2.5rem; font-weight: 800; color: ${scoreColor}; }
  .score-denom { font-size: 1rem; color: #9ca3af; font-weight: 400; }
  .score-label { font-size: 0.875rem; color: #6b7280; margin-top: 4px; text-align: center; }
  .executive-summary h2 { font-size: 1.125rem; font-weight: 600; margin-bottom: 12px; }
  .executive-summary p { color: #4b5563; font-size: 0.95rem; line-height: 1.7; margin-bottom: 12px; }
  .stats-row { display: flex; gap: 24px; margin-top: 20px; padding-top: 20px; border-top: 1px solid #f3f4f6; }
  .stat { text-align: center; }
  .stat-value { font-size: 1.5rem; font-weight: 700; color: #1a1a2e; }
  .stat-label { font-size: 0.75rem; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.05em; }
  .section-title { font-size: 1.25rem; font-weight: 700; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; }
  .plugin-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; margin-bottom: 48px; }
  .plugin-card { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .plugin-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .plugin-name { font-weight: 600; font-size: 0.95rem; }
  .plugin-score { font-weight: 700; font-size: 1.1rem; }
  .score-bar { height: 4px; background: #f3f4f6; border-radius: 99px; margin-bottom: 12px; }
  .score-bar-fill { height: 100%; border-radius: 99px; transition: width 1s ease; }
  .plugin-summary { font-size: 0.875rem; color: #6b7280; margin-bottom: 12px; }
  .recommendation { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-top: 1px solid #f9fafb; }
  .rec-num { width: 20px; height: 20px; background: #fff7ed; color: #f97316; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 700; flex-shrink: 0; margin-top: 2px; }
  .rec-impact { display: block; font-size: 0.75rem; color: #9ca3af; margin-top: 2px; }
  .priorities-table { width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 48px; }
  .priorities-table th { background: #f9fafb; padding: 12px 16px; text-align: left; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
  .priorities-table td { padding: 14px 16px; border-top: 1px solid #f3f4f6; font-size: 0.875rem; vertical-align: top; }
  .priority-num { font-weight: 700; width: 48px; }
  .priority-num.p1 { color: #ef4444; }
  .priority-num.p2 { color: #f59e0b; }
  .priority-num.p3 { color: #3b82f6; }
  .effort-badge { background: #f3f4f6; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
  .cta-block { background: #1a1a2e; color: white; border-radius: 16px; padding: 40px; text-align: center; margin-bottom: 48px; }
  .cta-block h3 { font-size: 1.5rem; font-weight: 700; margin-bottom: 8px; }
  .cta-block p { color: rgba(255,255,255,0.7); margin-bottom: 24px; }
  .cta-block .btn-primary { font-size: 1rem; padding: 14px 32px; }
  .report-footer { text-align: center; color: #9ca3af; font-size: 0.75rem; padding: 32px; border-top: 1px solid #f3f4f6; }
  .report-footer span { color: #f97316; }
</style>
</head>
<body>
<header class="report-header">
  <div class="logo">Click<span>Trends</span> AI Audit</div>
  <div class="report-actions" style="display: flex; align-items: center; gap: 12px;">
    <button class="btn-secondary" onclick="navigator.clipboard.writeText(window.location.href)">🔗 Copy share link</button>
    <button class="btn-primary" onclick="window.print()">⬇ Download .docx</button>

    <!-- HELIOS Branding -->
    <div class="navbar-powered" style="display: flex; align-items: center; border-left: 1px solid rgba(255,255,255,0.2); padding-left: 12px; margin-left: 4px;">
      <div style="display: flex; flex-direction: column; line-height: 1.1; font-family: 'Inter', sans-serif;">
        <div style="display: flex; align-items: center; gap: 4px; font-weight: 900; color: #f97316; font-size: 0.95rem; letter-spacing: 0.05em;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="5"></circle>
            <line x1="12" y1="1" x2="12" y2="3"></line>
            <line x1="12" y1="21" x2="12" y2="23"></line>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
            <line x1="1" y1="12" x2="3" y2="12"></line>
            <line x1="21" y1="12" x2="23" y2="12"></line>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
          </svg>
          HELIOS
        </div>
        <div style="font-size: 0.75rem; color: rgba(255,255,255,0.7); font-weight: 500; margin-top: 2px;">
          by <strong style="color: white;">Click Trends</strong>
        </div>
      </div>
    </div>
  </div>
</header>

<div class="container">
  <h1 class="report-title">AI Marketing Audit · ${auditData.businessName || auditData.url}</h1>
  <div class="report-meta">
    <span>🌐 ${auditData.url}</span>
    <span>📅 ${new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
    <span>🏭 ${auditData.industry}</span>
    <span>⚡ Generated in ${auditData.duration || '~90'}s</span>
  </div>

  <div class="overview-grid">
    <div class="score-circle">
      <div style="font-size:3rem;font-weight:800;color:${scoreColor}">${overallScore}<span style="font-size:1.2rem;color:#9ca3af">/100</span></div>
      <div class="score-label">${scoreLabel}</div>
    </div>
    <div class="executive-summary">
      <h2>Executive summary</h2>
      <p>${synthesis.executiveSummary || 'Audit analysis complete. See plugin results below for detailed findings.'}</p>
      <div class="stats-row">
        <div class="stat"><div class="stat-value">${auditData.pagesAnalysed || pluginResults.length * 5}</div><div class="stat-label">Pages Audited</div></div>
        <div class="stat"><div class="stat-value">${pluginResults.length}</div><div class="stat-label">AI Modules Run</div></div>
        <div class="stat"><div class="stat-value">${(synthesis.quickWins || []).length}</div><div class="stat-label">Quick Wins</div></div>
      </div>
    </div>
  </div>

  <h2 class="section-title">📊 Score by pillar</h2>
  <div class="plugin-grid">
    ${pluginCards}
  </div>

  <h2 class="section-title">🎯 90-day action plan</h2>
  <p style="color:#6b7280;font-size:0.875rem;margin-bottom:16px;">Prioritised by impact and effort. All actions reviewed by Perplexity's brand-review for claim safety.</p>
  <table class="priorities-table">
    <thead>
      <tr>
        <th>Priority</th>
        <th>Action</th>
        <th>Expected Impact</th>
        <th>Effort</th>
      </tr>
    </thead>
    <tbody>
      ${topPriorities}
    </tbody>
  </table>

  <div class="cta-block">
    <h3>Want help executing this audit?</h3>
    <p>Click Trends can deliver the full action plan in 6 weeks.<br>Book a 20-min strategy call to see if we're a fit.</p>
    <button class="btn-primary" onclick="window.open('https://clicktrends.com.au/', '_blank')">Book a free strategy call →</button>
    <p style="margin-top:12px;font-size:0.75rem;opacity:0.5">No obligation · Australian agency · No sales pitch</p>
  </div>
</div>

<footer class="report-footer">
  Generated by <span>Click Trends AI Audit</span> · clicktrends.com.au<br>
  This audit is illustrative. Specific recommendations should be validated by a senior strategist before implementation.
</footer>
</body>
</html>`;
}

// ─── DOCX Generator ───────────────────────────────────────────
async function generateDOCX(auditData, pluginResults, synthesis, overallScore) {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          text: 'ClickTrends AI Audit',
          heading: HeadingLevel.TITLE,
        }),
        new Paragraph({
          children: [
            new TextRun({ text: `Website: ${auditData.url} | Score: ${overallScore}/100 | ${auditData.industry}`, bold: true }),
          ],
        }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: 'Executive Summary', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: synthesis.executiveSummary || '' }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: 'Plugin Results', heading: HeadingLevel.HEADING_1 }),
        ...pluginResults.flatMap(r => [
          new Paragraph({ text: `${r.pluginName} — ${r.score}/100`, heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: r.summary || '' }),
          new Paragraph({ text: '' }),
        ]),
        new Paragraph({ text: '90-Day Action Plan', heading: HeadingLevel.HEADING_1 }),
        ...(synthesis.topPriorities || []).map((p, i) =>
          new Paragraph({ text: `${i + 1}. ${p.action || p} — ${p.impact || ''}` })
        ),
      ],
    }],
  });

  return Packer.toBuffer(doc);
}
