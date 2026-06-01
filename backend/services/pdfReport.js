// ============================================================
// backend/services/pdfReport.js
// Claude-generated professional PDF audit report
//
// Flow:
//   1. Claude API writes a full structured report as JSON
//   2. PDFKit renders a professional multi-page A4 PDF
//      (pure Node.js — no browser/Chrome required)
//   3. The raw Buffer is returned for streaming to the client
//   4. A JSON snapshot is saved to disk for inspection
// ============================================================

import Anthropic from '@anthropic-ai/sdk';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, '../../reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ─── Brand colours ────────────────────────────────────────────
const C = {
  navy:    '#1a1a2e',
  orange:  '#f97316',
  orangeL: '#fff7ed',
  green:   '#16a34a',
  amber:   '#d97706',
  red:     '#dc2626',
  gray900: '#111827',
  gray700: '#374151',
  gray500: '#6b7280',
  gray300: '#d1d5db',
  gray100: '#f3f4f6',
  white:   '#ffffff',
};

function hex(h) {
  h = h.replace('#', '');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

function scoreColour(score) {
  if (score >= 75) return C.green;
  if (score >= 55) return C.amber;
  return C.red;
}

function scoreLabel(score) {
  if (score >= 75) return 'Strong Foundation';
  if (score >= 55) return 'Solid Base';
  return 'Needs Attention';
}

// ─── Anthropic client ─────────────────────────────────────────
function getAnthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY_1 || process.env.ANTHROPIC_API_KEY;
  return new Anthropic({ apiKey: key });
}

// ─────────────────────────────────────────────────────────────
// STEP 1 — Ask Claude to write the full report content
// ─────────────────────────────────────────────────────────────
async function generateReportContent(auditData, pluginResults, synthesis, overallScore) {
  const client = getAnthropicClient();

  const pluginSummaries = pluginResults.map(r => ({
    name:            r.pluginName || r.pluginId || 'Unknown',
    score:           r.score || 0,
    summary:         r.summary || '',
    recommendations: (Array.isArray(r.recommendations) ? r.recommendations : []).slice(0, 6),
  }));

  const prompt = `You are a senior marketing strategist writing a COMPLETE, COMPREHENSIVE PDF audit report for ${auditData.businessName || auditData.url}.

This is a PROFESSIONAL CLIENT DELIVERABLE. Write it with depth, specificity, and actionable insight.

Audit data:
- URL: ${auditData.url}
- Industry: ${auditData.industry}
- Overall Score: ${overallScore}/100
- Pages Audited: ${auditData.pagesAnalysed || 0}
- Plugins run: ${pluginResults.length}

Executive Summary from AI synthesis:
${synthesis.executiveSummary || ''}

Plugin Results:
${JSON.stringify(pluginSummaries, null, 2)}

Top Priorities:
${JSON.stringify((synthesis.topPriorities || []).slice(0, 10), null, 2)}

Quick Wins:
${JSON.stringify((synthesis.quickWins || []).slice(0, 6), null, 2)}

Return ONLY a raw JSON object (no markdown, no code fences). The JSON must have this EXACT structure:

{
  "coverSubtitle": "string (2 sentences — compelling summary of what this audit covers and its value)",
  
  "executiveNarrative": "string (4-5 paragraphs of substantive executive-level insight. Address: overall digital health, key strengths, critical gaps, competitive position, and the opportunity available. Use \\n\\n for paragraph breaks. Minimum 350 words.)",
  
  "keyFindings": [
    { "finding": "string (concise finding title)", "detail": "string (2 sentences of specific detail)", "type": "strength|weakness|opportunity" }
  ],
  
  "pillars": [
    {
      "name": "string",
      "score": number,
      "grade": "A|B|C|D|F",
      "narrative": "string (3-4 paragraphs of SPECIFIC analysis for this pillar. Reference actual data from the audit. Explain what was found, why it matters commercially, what the data reveals, and what the risk/opportunity is. Use \\n\\n for breaks. Minimum 200 words per pillar.)",
      "keyIssues": ["string", "string", "string"],
      "topActions": [
        { "action": "string (specific, actionable task)", "why": "string (business impact in 1 sentence)", "effort": "Small|Medium|Large", "timeframe": "Week 1-2|Week 3-4|Month 2|Month 3" }
      ]
    }
  ],
  
  "actionPlan90Days": {
    "week1_2": {
      "theme": "string (theme for this period)",
      "objective": "string (what we're trying to achieve)",
      "tasks": [
        { "day": "string e.g. Day 1-2", "task": "string (specific task)", "owner": "string e.g. SEO Lead", "output": "string (deliverable)", "pillar": "string" }
      ]
    },
    "week3_4": {
      "theme": "string",
      "objective": "string",
      "tasks": [
        { "day": "string e.g. Day 8-10", "task": "string", "owner": "string", "output": "string", "pillar": "string" }
      ]
    },
    "month2": {
      "theme": "string",
      "objective": "string",
      "tasks": [
        { "day": "string e.g. Day 31-40", "task": "string", "owner": "string", "output": "string", "pillar": "string" }
      ]
    },
    "month3": {
      "theme": "string",
      "objective": "string",
      "tasks": [
        { "day": "string e.g. Day 61-70", "task": "string", "owner": "string", "output": "string", "pillar": "string" }
      ]
    }
  },
  
  "kpis": [
    { "metric": "string", "baseline": "string", "target30d": "string", "target90d": "string", "tool": "string" }
  ],
  
  "strategicOutlook": "string (3 paragraphs — forward-looking narrative: where this business will be in 6-12 months if they execute this plan. Be specific about metrics, market position, and revenue impact. Use \\n\\n for breaks. Minimum 200 words.)",
  
  "disclaimer": "string (1 professional sentence)"
}

RULES:
- Write in professional Australian B2B marketing tone — confident, direct, no fluff, no vague generalisations
- Every recommendation must be SPECIFIC to this business and industry
- actionPlan90Days must have at minimum 5 tasks per period (20+ total tasks across all 4 periods)
- kpis must have 6-8 items covering SEO, content, conversion, social, email metrics
- keyFindings must have 5-7 items
- pillars must match exactly the plugins that were run
- All string values on ONE LINE (use \\n\\n for paragraph breaks within strings)`;

  console.log('[PDFReport] Sending prompt to Claude…');
  const response = await client.messages.create({
    model:      'claude-sonnet-4-5-20250929',
    max_tokens: 8000,
    messages:   [
      { role: 'user', content: prompt },
      { role: 'assistant', content: '{' }
    ],
  });

  const raw = '{' + (response.content?.[0]?.text ?? '');
  console.log(`[PDFReport] Claude responded — ${raw.length} chars`);

  // ── Parse JSON with multiple fallback strategies ────────────
  let data = null;
  
  // Fix unescaped newlines that Claude sometimes outputs inside strings
  function fixJSON(str) {
    let out = '';
    let inString = false;
    let escape = false;
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (c === '\\' && !escape) { escape = true; out += c; continue; }
      if (c === '"' && !escape) { inString = !inString; }
      if (inString && c === '\n') { out += '\\n'; escape = false; continue; }
      if (inString && c === '\r') { escape = false; continue; } // strip \r in strings
      if (inString && c === '\t') { out += '\\t'; escape = false; continue; }
      out += c;
      escape = false;
    }
    return out;
  }

  const clean = fixJSON(raw.replace(/\[\d+\]/g, '').trim());

  try { data = JSON.parse(clean); } catch (_) {}

  if (!data) {
    const md = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (md) { try { data = JSON.parse(md[1]); } catch (_) {} }
  }

  if (!data) {
    let depth = 0, start = -1, end = -1;
    for (let i = 0; i < clean.length; i++) {
      if (clean[i] === '{') { if (!depth) start = i; depth++; }
      else if (clean[i] === '}') { depth--; if (!depth && start !== -1) { end = i; break; } }
    }
    if (start !== -1 && end !== -1) {
      try { data = JSON.parse(clean.slice(start, end + 1)); } catch (_) {}
    }
  }

  if (!data) {
    console.warn('[PDFReport] Claude JSON parse failed — using fallback');
    data = buildFallback(auditData, pluginResults, synthesis, overallScore);
    try { fs.writeFileSync(path.join(REPORTS_DIR, `failed-raw-${Date.now()}.txt`), raw); } catch (_) {}
  }

  // Save JSON snapshot to disk for inspection
  const snapshotPath = path.join(REPORTS_DIR, `report-content-${Date.now()}.json`);
  try {
    fs.writeFileSync(snapshotPath, JSON.stringify({ auditData, overallScore, content: data }, null, 2));
    console.log(`[PDFReport] JSON snapshot saved → ${snapshotPath}`);
  } catch (_) {}

  return data;
}

function buildFallback(auditData, pluginResults, synthesis, overallScore) {
  const periods = ['week1_2', 'week3_4', 'month2', 'month3'];
  const themes  = ['Foundation & Quick Wins', 'Core Optimisation', 'Growth Acceleration', 'Scale & Retain'];
  const actionPlan90Days = {};
  periods.forEach((p, i) => {
    actionPlan90Days[p] = {
      theme:     themes[i],
      objective: `Execute ${themes[i].toLowerCase()} activities`,
      tasks: (synthesis.topPriorities || []).slice(i*2, i*2+3).map((pr, j) => ({
        day:    `Day ${i*21+j*3+1}-${i*21+j*3+3}`,
        task:   pr.action || String(pr),
        owner:  'Marketing Lead',
        output: pr.impact || 'Completed',
        pillar: pr.pillar || pluginResults[0]?.pluginName || 'General',
      })),
    };
  });
  return {
    coverSubtitle:   synthesis.executiveSummary?.slice(0, 200) || 'Comprehensive AI marketing audit.',
    executiveNarrative: synthesis.executiveSummary || 'Audit complete.',
    keyFindings:     (synthesis.topPriorities || []).slice(0,5).map(p => ({ finding: p.action||'Finding', detail: p.impact||'', type: 'opportunity' })),
    pillars:         pluginResults.map(p => ({ name: p.pluginName||p.pluginId, score: p.score||0, grade: 'C', narrative: p.summary||'', keyIssues: [], topActions: [] })),
    actionPlan90Days,
    kpis:            [{ metric: 'Organic Traffic', baseline: 'Current', target30d: '+10%', target90d: '+40%', tool: 'Google Analytics' }],
    strategicOutlook: 'With execution of this plan, significant improvements in digital marketing performance are expected within 90 days.',
    disclaimer:      'This report is AI-generated and should be reviewed by a senior strategist.',
  };
}

// ─────────────────────────────────────────────────────────────
// STEP 2 — Render PDF with PDFKit
// ─────────────────────────────────────────────────────────────
function renderPDF(content, auditData, overallScore) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size:    'A4',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      info: {
        Title:   `ClickTrends AI Audit — ${auditData.businessName || auditData.url}`,
        Author:  'ClickTrends AI',
        Subject: 'Marketing Audit Report',
      },
    });

    doc.on('data', c => chunks.push(c));
    doc.on('end',  ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W    = doc.page.width;   // 595.28
    const MGLO = 52;               // outer left/right margin

    // ── Helpers ──────────────────────────────────────────────
    const colorFill = (h) => { const [r,g,b] = hex(h); doc.fillColor(r,g,b); };
    const colorStroke = (h) => { const [r,g,b] = hex(h); doc.strokeColor(r,g,b); };

    function rect(x, y, w, h, fillHex, strokeHex) {
      doc.rect(x, y, w, h);
      if (fillHex) { colorFill(fillHex); doc.fill(); }
      if (strokeHex) { colorStroke(strokeHex); doc.stroke(); }
    }

    function text(str, x, y, opts = {}) {
      const { color = C.gray900, font = 'Helvetica', size = 10, width, align = 'left', lineGap = 2 } = opts;
      colorFill(color);
      doc.font(font).fontSize(size).text(String(str || ''), x, y, {
        width, align, lineGap, lineBreak: !!width,
      });
    }

    function boldText(str, x, y, opts = {}) {
      text(str, x, y, { ...opts, font: 'Helvetica-Bold' });
    }

    function addPageHeader(title) {
      doc.addPage({ margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      // Header bar
      rect(0, 0, W, 44, C.navy);
      colorFill(C.white);
      doc.font('Helvetica-Bold').fontSize(11).text('Click', MGLO, 15, { continued: true });
      colorFill(C.orange);
      doc.font('Helvetica-Bold').fontSize(11).text('Trends', { continued: true });
      colorFill(C.white);
      doc.font('Helvetica').fontSize(11).text(' AI Audit', { lineBreak: false });

      colorFill(C.gray300);
      doc.font('Helvetica').fontSize(8).text(title.toUpperCase(), W - MGLO - 140, 18, { width: 140, align: 'right' });
      return 60; // return starting Y
    }

    function pageFooter(pageNum, total) {
      const py = doc.page.height - 32;
      rect(MGLO, py, W - MGLO*2, 1, C.gray100);
      text('Confidential · ClickTrends AI Audit · clicktrends.com.au', MGLO, py + 8, { color: C.gray300, size: 7 });
      text(`Page ${pageNum}`, W - MGLO - 40, py + 8, { color: C.gray300, size: 7, width: 40, align: 'right' });
    }

    function scoreBar(x, y, w, score) {
      const colour = scoreColour(score);
      rect(x, y, w, 5, C.gray100);
      rect(x, y, Math.max(4, (score/100)*w), 5, colour);
    }

    function effortBadge(x, y, effort) {
      const map = { Small: ['#dcfce7','#15803d'], Medium: ['#fef3c7','#92400e'], Large: ['#fce7f3','#9d174d'] };
      const [bg, fg] = map[effort] || map.Medium;
      const tw = doc.font('Helvetica-Bold').fontSize(7).widthOfString(effort.toUpperCase()) + 10;
      rect(x, y-2, tw, 12, bg);
      colorFill(fg);
      doc.font('Helvetica-Bold').fontSize(7).text(effort.toUpperCase(), x+5, y, { lineBreak: false });
      return x + tw + 6;
    }

    function wrapText(doc, str, x, y, maxWidth, size, font, colorHex, lineGap) {
      colorFill(colorHex);
      doc.font(font).fontSize(size);
      doc.text(str, x, y, { width: maxWidth, lineGap: lineGap || 2, lineBreak: true });
      return doc.y;
    }

    const businessName = auditData.businessName
      || auditData.url?.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]
      || 'Your Business';
    const date = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
    const colour = scoreColour(overallScore);

    // ═════════════════════════════════════════════════════════
    // PAGE 1 — COVER
    // ═════════════════════════════════════════════════════════
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };
    rect(0, 0, W, doc.page.height, C.navy);

    // Accent orb top right
    colorFill('#f9731608');
    doc.circle(W + 40, -40, 200).fill();
    colorFill('#f9731604');
    doc.circle(-40, doc.page.height + 40, 160).fill();

    // Orange accent bar top
    rect(0, 0, 6, doc.page.height, C.orange);

    // Logo
    colorFill(C.white);
    doc.font('Helvetica-Bold').fontSize(16).text('Click', MGLO + 8, 48, { continued: true });
    colorFill(C.orange);
    doc.font('Helvetica-Bold').fontSize(16).text('Trends', { continued: true });
    colorFill('#ffffff88');
    doc.font('Helvetica').fontSize(12).text('  AI Audit', { lineBreak: false });

    // Date
    colorFill('#ffffff44');
    doc.font('Helvetica').fontSize(8).text(date.toUpperCase(), W - MGLO - 130, 54, { width: 130, align: 'right' });

    // Score circle (drawn as concentric rings)
    const cx = W / 2, cy = 290, cr = 70;
    colorFill('#ffffff08');
    doc.circle(cx, cy, cr + 16).fill();
    colorFill('#ffffff12');
    doc.circle(cx, cy, cr).fill();

    // Score arc (drawn as multiple line segments approximation)
    const arcAngle = (overallScore / 100) * 360;
    colorFill(colour);
    doc.fontSize(48).font('Helvetica-Bold');
    const scoreW = doc.widthOfString(String(overallScore));
    doc.text(String(overallScore), cx - scoreW/2 - 8, cy - 28, { lineBreak: false });
    colorFill('#ffffff44');
    doc.font('Helvetica').fontSize(14).text('/100', cx + scoreW/2 - 6, cy - 10, { lineBreak: false });

    // Score label pill
    const lbl = scoreLabel(overallScore);
    const lblW = doc.font('Helvetica-Bold').fontSize(9).widthOfString(lbl) + 24;
    const [cr2,cg2,cb2] = hex(colour);
    doc.roundedRect(cx - lblW/2, cy + 50, lblW, 18, 9).fillColor(cr2, cg2, cb2).fillOpacity(0.25).fill();
    doc.fillOpacity(1);
    colorFill(colour);
    doc.font('Helvetica-Bold').fontSize(9).text(lbl.toUpperCase(), cx - lblW/2, cy + 54, { width: lblW, align: 'center' });

    // Eyebrow
    colorFill('#f97316cc');
    doc.font('Helvetica-Bold').fontSize(9).text('AI MARKETING AUDIT REPORT', MGLO + 8, 360, { width: W - MGLO*2 - 16, align: 'center' });

    // Business name
    colorFill(C.white);
    doc.font('Helvetica-Bold').fontSize(28).text(businessName, MGLO + 8, 380, { width: W - MGLO*2 - 16, align: 'center' });

    // URL
    colorFill('#ffffff66');
    doc.font('Helvetica').fontSize(10).text(auditData.url || '', MGLO + 8, doc.y + 8, { width: W - MGLO*2 - 16, align: 'center' });

    // Subtitle
    colorFill('#ffffffaa');
    doc.font('Helvetica').fontSize(10).text(content.coverSubtitle || '', MGLO + 8, doc.y + 16, { width: W - MGLO*2 - 16, align: 'center', lineGap: 3 });

    // Stats row
    const statsY = doc.page.height - 110;
    rect(MGLO + 8, statsY - 16, W - MGLO*2 - 16, 1, '#ffffff18');

    const stats = [
      { label: 'Overall Score', value: `${overallScore}/100` },
      { label: 'Pages Audited', value: String(auditData.pagesAnalysed || 0) },
      { label: 'AI Modules', value: String((content.pillars || []).length) },
      { label: 'Action Items', value: String((content.actionPlan90Days?.week1_2?.tasks?.length || 0) + (content.actionPlan90Days?.week3_4?.tasks?.length || 0) + (content.actionPlan90Days?.month2?.tasks?.length || 0) + (content.actionPlan90Days?.month3?.tasks?.length || 0)) },
    ];
    const colW = (W - MGLO*2 - 16) / stats.length;
    stats.forEach((s, i) => {
      const sx = MGLO + 8 + i * colW;
      colorFill(colour);
      doc.font('Helvetica-Bold').fontSize(18).text(s.value, sx, statsY, { width: colW, align: 'center' });
      colorFill('#ffffff55');
      doc.font('Helvetica').fontSize(7).text(s.label.toUpperCase(), sx, statsY + 24, { width: colW, align: 'center' });
    });

    // Footer
    colorFill('#ffffff33');
    doc.font('Helvetica').fontSize(7).text('Confidential · clicktrends.com.au', MGLO + 8, doc.page.height - 30, { width: W - MGLO*2 - 16, align: 'center' });

    // ═════════════════════════════════════════════════════════
    // PAGE 2 — EXECUTIVE SUMMARY
    // ═════════════════════════════════════════════════════════
    let y = addPageHeader('Executive Summary');
    pageFooter(2, '—');

    // Section title
    boldText('Executive Summary', MGLO, y, { color: C.navy, size: 20 });
    text(`${businessName} · ${date}`, MGLO, doc.y + 4, { color: C.gray500, size: 9 });
    y = doc.y + 20;

    // Two-column layout: narrative left, score sidebar right
    const narW = W - MGLO*2 - 170;
    const sideX = MGLO + narW + 20;
    const sideW = 150;

    // Score sidebar
    rect(sideX, y, sideW, 90, C.navy, null);
    colorFill(C.white);
    doc.font('Helvetica').fontSize(7).text('OVERALL SCORE', sideX, y + 10, { width: sideW, align: 'center' });
    colorFill(colour);
    doc.font('Helvetica-Bold').fontSize(36).text(String(overallScore), sideX, y + 20, { width: sideW, align: 'center' });
    colorFill('#ffffff66');
    doc.font('Helvetica').fontSize(8).text('/100', sideX + sideW/2 + 14, y + 34, { lineBreak: false });
    colorFill(colour);
    const lbl2 = scoreLabel(overallScore);
    doc.font('Helvetica-Bold').fontSize(7).text(lbl2.toUpperCase(), sideX, y + 64, { width: sideW, align: 'center' });

    // Pillar bars in sidebar
    let sbY = y + 100;
    boldText('SCORES BY PILLAR', sideX, sbY, { color: C.gray500, size: 7 });
    sbY += 14;
    (content.pillars || []).forEach(p => {
      const pc = scoreColour(p.score);
      colorFill(C.gray700);
      doc.font('Helvetica').fontSize(7).text(p.name, sideX, sbY, { width: sideW - 30, lineBreak: false });
      colorFill(pc);
      doc.font('Helvetica-Bold').fontSize(7).text(String(p.score), sideX + sideW - 24, sbY, { width: 24, align: 'right', lineBreak: false });
      sbY += 10;
      scoreBar(sideX, sbY, sideW, p.score);
      sbY += 10;
    });

    // Executive narrative
    let narY = y;
    (content.executiveNarrative || '').split(/\n\n+/).filter(Boolean).forEach(para => {
      narY = wrapText(doc, para.trim(), MGLO, narY, narW, 10, 'Helvetica', C.gray700, 3);
      narY += 10;
    });

    // Key Findings
    y = Math.max(narY, sbY) + 20;
    if (y > doc.page.height - 160) {
      doc.addPage({ margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      y = addPageHeader('Key Findings');
      pageFooter(3, '—');
    }

    boldText('Key Findings', MGLO, y, { color: C.navy, size: 14 });
    y += 18;

    const findings = content.keyFindings || [];
    const fColW = (W - MGLO*2 - 10) / 2;
    findings.forEach((f, i) => {
      const fx = MGLO + (i % 2) * (fColW + 10);
      const fy = i % 2 === 0 ? y : y; // both columns start same y (managed below)
      const typeColor = f.type === 'strength' ? C.green : f.type === 'weakness' ? C.red : C.orange;
      const typeIcon  = f.type === 'strength' ? '✓' : f.type === 'weakness' ? '!' : '→';

      if (i % 2 === 0 && i > 0) y = doc.y + 8;

      rect(fx, y, fColW, 52, C.gray100);
      rect(fx, y, 4, 52, typeColor);
      colorFill(typeColor);
      doc.font('Helvetica-Bold').fontSize(10).text(typeIcon, fx + 10, y + 8, { lineBreak: false });
      boldText(f.finding, fx + 24, y + 7, { color: C.navy, size: 9, width: fColW - 32 });
      text(f.detail, fx + 10, doc.y + 2, { color: C.gray500, size: 8, width: fColW - 18 });

      if (i % 2 === 1) y = doc.y + 8;
    });
    if (findings.length % 2 === 1) y = doc.y + 8;

    // ═════════════════════════════════════════════════════════
    // PILLAR PAGES
    // ═════════════════════════════════════════════════════════
    (content.pillars || []).forEach((pillar, pi) => {
      y = addPageHeader(`Pillar ${pi + 1}: ${pillar.name}`);
      pageFooter(4 + pi, '—');

      // Pillar header card
      const pc = scoreColour(pillar.score);
      rect(MGLO, y, W - MGLO*2, 56, pc + '18');
      rect(MGLO, y, 4, 56, pc);

      // Score circle
      colorFill(pc);
      doc.font('Helvetica-Bold').fontSize(22).text(String(pillar.score), MGLO + 14, y + 12, { lineBreak: false });
      colorFill(C.gray500);
      doc.font('Helvetica').fontSize(10).text('/100', MGLO + 44, y + 20, { lineBreak: false });

      boldText(pillar.name, MGLO + 70, y + 10, { color: C.navy, size: 15, width: W - MGLO*2 - 140 });
      text(scoreLabel(pillar.score) + (pillar.grade ? `  ·  Grade: ${pillar.grade}` : ''), MGLO + 70, doc.y + 2, { color: pc, size: 9 });

      // Score bar
      scoreBar(MGLO + 70, y + 42, W - MGLO*2 - 140, pillar.score);

      y += 68;

      // Narrative
      boldText('Analysis', MGLO, y, { color: C.navy, size: 12 });
      y += 16;
      (pillar.narrative || '').split(/\n\n+/).filter(Boolean).forEach(para => {
        if (doc.y > doc.page.height - 100) {
          doc.addPage({ margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          y = addPageHeader(`${pillar.name} (continued)`);
          pageFooter(4 + pi, '—');
        }
        y = wrapText(doc, para.trim(), MGLO, y, W - MGLO*2, 10, 'Helvetica', C.gray700, 3);
        y += 10;
      });

      // Key Issues
      if ((pillar.keyIssues || []).length > 0) {
        if (y > doc.page.height - 140) {
          doc.addPage({ margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          y = addPageHeader(`${pillar.name} (continued)`);
          pageFooter(4 + pi, '—');
        }
        y += 4;
        boldText('Key Issues Identified', MGLO, y, { color: C.navy, size: 11 });
        y += 14;
        pillar.keyIssues.forEach(issue => {
          colorFill(C.red);
          doc.font('Helvetica-Bold').fontSize(9).text('•', MGLO, y, { lineBreak: false });
          y = wrapText(doc, issue, MGLO + 12, y, W - MGLO*2 - 12, 9, 'Helvetica', C.gray700, 2);
          y += 5;
        });
      }

      // Actions table
      if ((pillar.topActions || []).length > 0) {
        y += 10;
        if (y > doc.page.height - 180) {
          doc.addPage({ margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          y = addPageHeader(`${pillar.name} — Actions`);
          pageFooter(4 + pi, '—');
        }
        boldText('Recommended Actions', MGLO, y, { color: C.navy, size: 11 });
        y += 14;

        // Table header
        rect(MGLO, y, W - MGLO*2, 18, C.navy);
        const cols = [
          { label: 'Action',    x: MGLO + 6,             w: 220 },
          { label: 'Impact',    x: MGLO + 6 + 225,       w: 130 },
          { label: 'Effort',    x: MGLO + 6 + 360,       w: 60  },
          { label: 'Timeframe', x: MGLO + 6 + 424,       w: 80  },
        ];
        cols.forEach(c => {
          colorFill(C.white);
          doc.font('Helvetica-Bold').fontSize(7).text(c.label.toUpperCase(), c.x, y + 6, { width: c.w, lineBreak: false });
        });
        y += 20;

        pillar.topActions.forEach((a, i) => {
          if (y > doc.page.height - 100) {
            doc.addPage({ margins: { top: 0, bottom: 0, left: 0, right: 0 } });
            y = addPageHeader(`${pillar.name} — Actions (continued)`);
            pageFooter(4 + pi, '—');
          }
          rect(MGLO, y, W - MGLO*2, 30, i % 2 === 0 ? C.white : C.gray100);
          wrapText(doc, a.action, cols[0].x, y + 4, cols[0].w - 4, 8, 'Helvetica-Bold', C.navy, 1);
          wrapText(doc, a.why, cols[1].x, y + 4, cols[1].w - 4, 8, 'Helvetica', C.gray700, 1);
          effortBadge(cols[2].x, y + 9, a.effort || 'Medium');
          text(a.timeframe || '', cols[3].x, y + 9, { color: C.gray500, size: 8, width: cols[3].w });
          y += 32;
        });
      }
    });

    // ═════════════════════════════════════════════════════════
    // 90-DAY ACTION PLAN
    // ═════════════════════════════════════════════════════════
    const plan = content.actionPlan90Days || {};
    const periods90 = [
      { key: 'week1_2',  label: 'Week 1–2 (Days 1–14)',   color: C.red    },
      { key: 'week3_4',  label: 'Week 3–4 (Days 15–30)',  color: C.orange },
      { key: 'month2',   label: 'Month 2 (Days 31–60)',   color: C.amber  },
      { key: 'month3',   label: 'Month 3 (Days 61–90)',   color: C.green  },
    ];

    y = addPageHeader('90-Day Action Plan');
    pageFooter('AP', '—');

    boldText('90-Day Action Plan', MGLO, y, { color: C.navy, size: 20 });
    text('A complete day-by-day execution roadmap prioritised by business impact.', MGLO, doc.y + 4, { color: C.gray500, size: 10 });
    y = doc.y + 16;

    periods90.forEach(period => {
      const pd = plan[period.key];
      if (!pd) return;

      if (y > doc.page.height - 200) {
        y = addPageHeader('90-Day Action Plan (continued)');
        pageFooter('AP', '—');
      }

      // Period header
      rect(MGLO, y, W - MGLO*2, 36, period.color + '18');
      rect(MGLO, y, 4, 36, period.color);
      colorFill(period.color);
      doc.font('Helvetica-Bold').fontSize(12).text(period.label, MGLO + 14, y + 8, { lineBreak: false });
      colorFill(C.navy);
      doc.font('Helvetica-Bold').fontSize(9).text(pd.theme || '', MGLO + 14, doc.y + 2, { lineBreak: false });
      text(pd.objective || '', MGLO + 14 + (doc.font('Helvetica-Bold').fontSize(9).widthOfString(pd.theme || '')) + 12, y + 23, { color: C.gray500, size: 8 });
      y += 44;

      // Table header
      rect(MGLO, y, W - MGLO*2, 16, C.navy);
      const tCols = [
        { label: 'Day',        x: MGLO + 4,   w: 55  },
        { label: 'Task',       x: MGLO + 62,  w: 195 },
        { label: 'Pillar',     x: MGLO + 260, w: 80  },
        { label: 'Owner',      x: MGLO + 343, w: 80  },
        { label: 'Deliverable',x: MGLO + 426, w: 110 },
      ];
      tCols.forEach(c => {
        colorFill(C.white);
        doc.font('Helvetica-Bold').fontSize(6.5).text(c.label.toUpperCase(), c.x, y + 5, { width: c.w, lineBreak: false });
      });
      y += 18;

      (pd.tasks || []).forEach((task, i) => {
        if (y > doc.page.height - 80) {
          doc.addPage({ margins: { top: 0, bottom: 0, left: 0, right: 0 } });
          y = addPageHeader('90-Day Action Plan (continued)');
          pageFooter('AP', '—');
          // Re-draw header
          rect(MGLO, y, W - MGLO*2, 16, C.navy);
          tCols.forEach(c => {
            colorFill(C.white);
            doc.font('Helvetica-Bold').fontSize(6.5).text(c.label.toUpperCase(), c.x, y + 5, { width: c.w, lineBreak: false });
          });
          y += 18;
        }

        const rowH = 28;
        rect(MGLO, y, W - MGLO*2, rowH, i % 2 === 0 ? C.white : C.gray100);
        // Day pill
        const dayC = period.color;
        const [dr,dg,db] = hex(dayC);
        doc.roundedRect(tCols[0].x, y + 6, 48, 14, 3).fillColor(dr,dg,db).fillOpacity(0.15).fill();
        doc.fillOpacity(1);
        colorFill(dayC);
        doc.font('Helvetica-Bold').fontSize(6.5).text(task.day || '', tCols[0].x, y + 9, { width: 48, align: 'center', lineBreak: false });

        wrapText(doc, task.task || '', tCols[1].x, y + 4, tCols[1].w - 4, 8, 'Helvetica-Bold', C.navy, 1);
        text(task.pillar || '', tCols[2].x, y + 9, { color: C.gray500, size: 7.5, width: tCols[2].w - 4 });
        text(task.owner || '', tCols[3].x, y + 9, { color: C.gray500, size: 7.5, width: tCols[3].w - 4 });
        text(task.output || '', tCols[4].x, y + 9, { color: C.gray700, size: 7.5, width: tCols[4].w - 4 });
        y += rowH;
      });

      y += 16;
    });

    // ═════════════════════════════════════════════════════════
    // KPI DASHBOARD PAGE
    // ═════════════════════════════════════════════════════════
    y = addPageHeader('KPI Dashboard');
    pageFooter('KPI', '—');

    boldText('KPI Dashboard & Success Metrics', MGLO, y, { color: C.navy, size: 16 });
    text('Track these metrics weekly to measure the impact of this action plan.', MGLO, doc.y + 4, { color: C.gray500, size: 9 });
    y = doc.y + 20;

    // KPI table
    rect(MGLO, y, W - MGLO*2, 18, C.navy);
    const kpiCols = [
      { label: 'Metric',     x: MGLO + 4,   w: 110 },
      { label: 'Baseline',   x: MGLO + 117, w: 85  },
      { label: '30-Day Target',x: MGLO+205, w: 85  },
      { label: '90-Day Target',x: MGLO+293, w: 85  },
      { label: 'Tool',       x: MGLO + 381, w: 108 },
    ];
    kpiCols.forEach(c => {
      colorFill(C.white);
      doc.font('Helvetica-Bold').fontSize(7).text(c.label.toUpperCase(), c.x, y + 5, { width: c.w, lineBreak: false });
    });
    y += 20;

    (content.kpis || []).forEach((kpi, i) => {
      rect(MGLO, y, W - MGLO*2, 24, i % 2 === 0 ? C.white : C.gray100);
      boldText(kpi.metric, kpiCols[0].x, y + 7, { color: C.navy, size: 8, width: kpiCols[0].w - 4 });
      text(kpi.baseline,  kpiCols[1].x, y + 7, { color: C.gray500, size: 8, width: kpiCols[1].w - 4 });
      colorFill(C.amber);
      doc.font('Helvetica-Bold').fontSize(8).text(kpi.target30d, kpiCols[2].x, y + 7, { width: kpiCols[2].w - 4, lineBreak: false });
      colorFill(C.green);
      doc.font('Helvetica-Bold').fontSize(8).text(kpi.target90d, kpiCols[3].x, y + 7, { width: kpiCols[3].w - 4, lineBreak: false });
      text(kpi.tool, kpiCols[4].x, y + 7, { color: C.gray500, size: 8, width: kpiCols[4].w - 4 });
      y += 26;
    });

    // ═════════════════════════════════════════════════════════
    // FINAL PAGE — STRATEGIC OUTLOOK + CTA
    // ═════════════════════════════════════════════════════════
    doc.addPage({ margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    rect(0, 0, W, doc.page.height, C.navy);
    rect(0, 0, 6, doc.page.height, C.orange);
    colorFill('#f9731606');
    doc.circle(W + 60, -60, 250).fill();

    colorFill(C.white);
    doc.font('Helvetica-Bold').fontSize(13).text('Click', MGLO + 8, 40, { continued: true });
    colorFill(C.orange);
    doc.font('Helvetica-Bold').fontSize(13).text('Trends', { continued: true });
    colorFill('#ffffff55');
    doc.font('Helvetica').fontSize(10).text('  AI Audit', { lineBreak: false });

    y = 80;
    colorFill('#f97316aa');
    doc.font('Helvetica-Bold').fontSize(8).text('6–12 MONTH STRATEGIC OUTLOOK', MGLO + 8, y);
    colorFill(C.white);
    doc.font('Helvetica-Bold').fontSize(22).text('Strategic Outlook', MGLO + 8, y + 14);
    y = doc.y + 20;

    (content.strategicOutlook || '').split(/\n\n+/).filter(Boolean).forEach(para => {
      colorFill('#ffffffcc');
      doc.font('Helvetica').fontSize(10).text(para.trim(), MGLO + 8, y, { width: W - MGLO*2 - 16, lineGap: 3 });
      y = doc.y + 14;
    });

    // Divider
    rect(MGLO + 8, y + 10, W - MGLO*2 - 16, 1, '#ffffff22');
    y += 28;

    // CTA box
    colorFill('#f9731615');
    doc.roundedRect(MGLO + 8, y, W - MGLO*2 - 16, 100, 8).fill();
    colorFill('#f97316aa');
    doc.rect(MGLO + 8, y, 3, 100).fill();

    colorFill(C.orange);
    doc.font('Helvetica-Bold').fontSize(8).text('READY TO EXECUTE?', MGLO + 20, y + 14);
    colorFill(C.white);
    doc.font('Helvetica-Bold').fontSize(16).text('Turn this audit into results in 6 weeks.', MGLO + 20, y + 26);
    colorFill('#ffffffaa');
    doc.font('Helvetica').fontSize(9).text(
      `ClickTrends can help ${businessName} execute the full action plan. Book a 20-minute strategy call.`,
      MGLO + 20, y + 48, { width: W - MGLO*2 - 40, lineGap: 2 }
    );
    colorFill(C.orange);
    doc.font('Helvetica-Bold').fontSize(11).text('clicktrends.com.au', MGLO + 20, y + 72);

    // Disclaimer + copyright
    rect(MGLO + 8, doc.page.height - 52, W - MGLO*2 - 16, 1, '#ffffff18');
    colorFill('#ffffff44');
    doc.font('Helvetica').fontSize(7).text(
      content.disclaimer || 'This report is AI-generated and should be reviewed by a senior strategist before implementation.',
      MGLO + 8, doc.page.height - 42, { width: W - MGLO*2 - 16, lineGap: 2 }
    );
    colorFill('#ffffff33');
    doc.font('Helvetica').fontSize(7).text(
      `© ${new Date().getFullYear()} ClickTrends · clicktrends.com.au · All rights reserved.`,
      MGLO + 8, doc.page.height - 28, { width: W - MGLO*2 - 16 }
    );

    doc.end();
  });
}

// ─────────────────────────────────────────────────────────────
// PUBLIC ENTRY POINT
// ─────────────────────────────────────────────────────────────
export async function generatePDFReport(auditId, auditData, pluginResults, synthesis, overallScore) {
  console.log(`[PDFReport] Starting Claude PDF generation for audit ${auditId}`);

  // Step 1 — Claude writes the content
  const content = await generateReportContent(auditData, pluginResults, synthesis, overallScore);
  console.log(`[PDFReport] Content ready — ${(content.pillars||[]).length} pillars, ${Object.values(content.actionPlan90Days||{}).reduce((s,p)=>s+(p.tasks||[]).length,0)} action tasks`);

  // Step 2 — PDFKit renders the PDF
  console.log('[PDFReport] Rendering PDF with PDFKit…');
  const pdfBuffer = await renderPDF(content, auditData, overallScore);
  console.log(`[PDFReport] PDF done — ${Math.round(pdfBuffer.length/1024)}KB`);

  // Step 3 — Save a copy to disk
  const pdfPath = path.join(REPORTS_DIR, `audit-${auditId}.pdf`);
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    console.log(`[PDFReport] PDF saved → ${pdfPath}`);
  } catch (_) {}

  return { pdfBuffer, content };
}
