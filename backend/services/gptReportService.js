import { OpenAI } from 'openai';
import { getAuditById, getAuditPlugins } from '../db/queries.js';
import puppeteer from 'puppeteer';
import { marked } from 'marked';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, '../../reports');

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

const openai = new OpenAI({
  apiKey: process.env.OPEN_AI_APIKEY || process.env.OPENAI_API_KEY,
});

/**
 * Renders the GPT-generated markdown into a beautiful, premium HTML template for the PDF.
 */
function renderHtmlTemplate(auditData, combinedHtml) {
  const dateStr = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>ClickTrends AI Audit Report</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        
        :root {
          --primary: #f97316;
          --bg: #faf9f6;
          --text: #374151;
          --heading: #1a1a2e;
        }

        body {
          font-family: 'Inter', sans-serif;
          background: #ffffff;
          color: var(--text);
          margin: 0;
          padding: 0;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        
        .page {
          page-break-after: always;
          padding: 40px;
          position: relative;
          min-height: 1040px; /* Approximate A4 height */
        }
        
        /* Cover Page */
        .cover {
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          height: 100vh;
          text-align: center;
          background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
          border: 8px solid var(--primary);
        }
        
        .cover h1 {
          font-size: 3rem;
          font-weight: 900;
          color: var(--heading);
          margin-bottom: 1rem;
          line-height: 1.1;
          letter-spacing: -0.02em;
        }
        
        .cover p.subtitle {
          font-size: 1.25rem;
          color: #64748b;
          margin-bottom: 3rem;
        }
        
        .cover .meta {
          display: flex;
          gap: 24px;
          background: white;
          padding: 16px 32px;
          border-radius: 99px;
          box-shadow: 0 4px 20px rgba(0,0,0,0.05);
          font-size: 0.875rem;
          font-weight: 600;
          color: var(--heading);
        }

        /* Standard Header */
        .pdf-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding-bottom: 16px;
          border-bottom: 2px solid #f1f5f9;
          margin-bottom: 32px;
        }

        .pdf-header .logo {
          font-weight: 800;
          color: var(--heading);
          font-size: 1.125rem;
          letter-spacing: -0.01em;
        }

        .pdf-header .logo span {
          color: var(--primary);
        }
        
        /* HELIOS Branding */
        .helios-branding {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .helios-branding svg {
          color: var(--primary);
          width: 16px; height: 16px;
        }
        .helios-text {
          display: flex;
          flex-direction: column;
          line-height: 1.1;
        }
        .helios-title {
          display: flex; align-items: center; gap: 4px; font-weight: 900; color: var(--primary); font-size: 0.85rem; letter-spacing: 0.05em;
        }
        .helios-sub {
          font-size: 0.65rem; color: #6b7280; font-weight: 500; margin-top: 2px;
        }

        /* Content Markdown Styling */
        h1 { font-size: 2rem; font-weight: 800; color: var(--heading); margin-bottom: 1.5rem; letter-spacing: -0.02em; }
        h2 { font-size: 1.5rem; font-weight: 700; color: var(--heading); margin-top: 2rem; margin-bottom: 1rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 0.5rem; }
        h3 { font-size: 1.25rem; font-weight: 600; color: var(--heading); margin-top: 1.5rem; margin-bottom: 0.75rem; }
        
        p { margin-bottom: 1rem; font-size: 0.95rem; line-height: 1.6; }
        ul, ol { margin-bottom: 1rem; padding-left: 1.5rem; font-size: 0.95rem; }
        li { margin-bottom: 0.5rem; }
        
        strong { color: var(--heading); font-weight: 700; }
        
        /* Tables */
        table {
          width: 100%;
          border-collapse: separate;
          border-spacing: 0;
          margin: 1.5rem 0;
          border-radius: 12px;
          overflow: hidden;
          border: 1px solid #e2e8f0;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05);
        }
        th, td {
          padding: 12px 16px;
          text-align: left;
          border-bottom: 1px solid #e2e8f0;
          font-size: 0.875rem;
        }
        th {
          background-color: #f8fafc;
          font-weight: 600;
          color: var(--heading);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          font-size: 0.75rem;
        }
        tr:last-child td { border-bottom: none; }
        tr:nth-child(even) td { background-color: #f8fafc; }

        /* Cards */
        .card {
          background: #ffffff;
          border: 1px solid #e2e8f0;
          border-radius: 12px;
          padding: 24px;
          margin-bottom: 24px;
          box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
          page-break-inside: avoid;
        }

        /* Bar Charts */
        .chart-container {
          margin: 16px 0;
          page-break-inside: avoid;
        }
        .chart-label {
          font-size: 0.875rem;
          font-weight: 600;
          margin-bottom: 8px;
          color: var(--heading);
          display: flex;
          justify-content: space-between;
        }
        .bar-chart {
          width: 100%;
          background-color: #f1f5f9;
          border-radius: 99px;
          height: 12px;
          overflow: hidden;
        }
        .bar-fill {
          height: 100%;
          background: linear-gradient(90deg, #f97316, #ea580c);
          border-radius: 99px;
        }

        /* Footer */
        .pdf-footer {
          position: absolute;
          bottom: 20px;
          left: 40px;
          right: 40px;
          display: flex;
          justify-content: space-between;
          font-size: 0.75rem;
          color: #94a3b8;
          border-top: 1px solid #f1f5f9;
          padding-top: 16px;
        }
        
        .plugin-section {
          page-break-before: always;
        }
      </style>
    </head>
    <body>
      <!-- Cover Page -->
      <div class="page cover">
        <div class="helios-branding" style="position: absolute; top: 40px; right: 40px;">
          <div class="helios-text" style="text-align: right; align-items: flex-end;">
            <div class="helios-title">
              HELIOS
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
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
            </div>
            <div class="helios-sub">by <strong style="color: #111827;">Click Trends</strong></div>
          </div>
        </div>

        <div style="font-size: 1.5rem; font-weight: 800; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 2rem;">
          Comprehensive Analysis
        </div>
        <h1>Marketing &amp; Growth Audit</h1>
        <p class="subtitle">Prepared for <strong>${auditData.url}</strong></p>
        
        <div class="meta">
          <span>🌐 ${auditData.url}</span>
          <span>📅 ${dateStr}</span>
          <span>🏭 ${auditData.industry}</span>
        </div>
      </div>
      
      <!-- Content Pages -->
      <div class="page" style="page-break-after: auto; min-height: auto;">
        <div class="pdf-header">
          <div class="logo">Click<span>Trends</span> AI Audit</div>
          <div class="helios-branding">
            <div class="helios-text" style="align-items: flex-end;">
              <div class="helios-title">
                HELIOS
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
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
              </div>
              <div class="helios-sub">by <strong style="color: #111827;">Click Trends</strong></div>
            </div>
          </div>
        </div>
        
        ${combinedHtml}
        
      </div>
    </body>
    </html>
  `;
}

/**
 * Fetch raw Claude dataset, process EACH plugin with GPT-4o sequentially, and render PDF.
 */
export async function generateGptReportPdf(auditId) {
  const pdfPath = path.join(REPORTS_DIR, `audit_${auditId}_gpt.pdf`);
  
  if (fs.existsSync(pdfPath)) {
    console.log(`[GPT Report] Returning cached PDF for ${auditId}`);
    return pdfPath;
  }

  console.log(`[GPT Report] Fetching dataset for audit: ${auditId}`);
  const audit = await getAuditById(auditId);
  const plugins = await getAuditPlugins(auditId);

  if (!audit || !plugins || plugins.length === 0) {
    throw new Error('Audit data not found or incomplete');
  }

  console.log(`[GPT Report] Generating report sequentially for ${plugins.length} plugins...`);

  const model = process.env.OPENAI_MODEL || 'gpt-4o';
  let combinedMarkdown = '';

  // 1. Executive Summary
  console.log(`[GPT Report] Generating Executive Summary...`);
  const execPrompt = `
You are a senior consulting report writer.
Create a highly professional Executive Summary for a digital marketing audit.
Website: ${audit.url}
Industry: ${audit.industry}
Overall Score: ${audit.overall_score}/100

Plugins ran: ${plugins.map(p => p.name).join(', ')}

Provide a concise, hard-hitting executive summary using Markdown. Do not use emojis. Use a <div class="card"> wrapper for the main summary.
`;

  const execPromise = openai.chat.completions.create({
    model,
    messages: [ { role: 'user', content: execPrompt } ]
  }).then(res => res.choices[0].message.content + '\n\n').catch(err => {
    console.error('[GPT Report] Failed on Executive Summary', err);
    return '';
  });

  // 2. Generate Plugins in Parallel
  const pluginPromises = plugins.map((p, i) => {
    console.log(`[GPT Report] Triggering section for plugin ${i+1}/${plugins.length}: ${p.name}...`);
    
    const pluginPrompt = `
You are a senior consulting report writer.
Your task is to parse the raw JSON data from the "${p.name}" audit plugin and transform it into a highly visual, clean, and comprehensive section of a PDF report.

CRITICAL INSTRUCTIONS:
1. DO NOT OUTPUT RAW JSON. Read the JSON, extract the vital parts, and write professional consulting text.
2. KEEP ALL SUB-SECTIONS. Ensure that every sub-section or key category present in the JSON is mentioned and detailed in your output.
3. LENGTH & DEPTH: Aim for comprehensive detail without fluff. Condense only the non-vital text so the section is around 5 pages maximum. The text must be easy to understand.
4. Format the output visually using Markdown and HTML.
5. Use Markdown tables extensively to organize lists, findings, or data arrays.
6. Wrap major insights or sections in <div class="card">...</div>.
7. If there are scores or metrics, use this exact HTML syntax for a bar chart:
   <div class="chart-container">
     <div class="chart-label"><span>Metric Name</span><span>Score/100</span></div>
     <div class="bar-chart"><div class="bar-fill" style="width: Score%;"></div></div>
   </div>
8. Use clear H1, H2, H3 headings. The main title of this section should be an H1.
9. Remove ALL emojis. Maintain a highly professional, consultant-grade tone.

RAW DATA FOR "${p.name}":
Score: ${p.score}
Summary: ${p.summary}
Raw Output Data (JSON/Text):
${p.claude_output}
`;

    return openai.chat.completions.create({
      model,
      messages: [ { role: 'user', content: pluginPrompt } ]
    }).then(res => {
      return `\n\n<div class="plugin-section"></div>\n\n` + res.choices[0].message.content + '\n\n';
    }).catch(err => {
      console.error(`[GPT Report] Failed on plugin ${p.name}`, err);
      return `\n\n<div class="plugin-section"></div>\n\n# ${p.name}\nFailed to generate formatted section.\n\n`;
    });
  });

  console.log(`[GPT Report] Waiting for all sections to generate in parallel...`);
  const [execContent, ...pluginContents] = await Promise.all([execPromise, ...pluginPromises]);
  
  combinedMarkdown = execContent + pluginContents.join('');

  console.log(`[GPT Report] Finished parallel generation. Rendering HTML...`);

  // Parse markdown
  const htmlContent = marked.parse(combinedMarkdown);
  const finalHtml = renderHtmlTemplate(audit, htmlContent);

  console.log(`[GPT Report] Launching Puppeteer to generate PDF...`);

  // Build launch options — works on both Windows dev and Linux/Docker (Railway).
  // On Linux the bundled Chromium is used automatically (no executablePath needed).
  // On Windows we prefer local Chrome if installed; otherwise fall back to bundled Chromium.
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',    // prevents /dev/shm exhaustion in containers
      '--disable-gpu',
      '--disable-extensions',
      '--no-zygote',                // required in single-process container envs
      '--disable-crash-reporter',   // silences chrome_crashpad_handler errors
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  };

  if (process.platform === 'win32') {
    const localChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (fs.existsSync(localChrome)) {
      launchOptions.executablePath = localChrome;
    }
  }

  // Launch Puppeteer
  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();
    // Use setContent and wait for network idle so Tailwind CDN loads
    await page.setContent(finalHtml, { waitUntil: 'networkidle0' });
    
    // Add extra wait for Tailwind to process
    await new Promise(r => setTimeout(r, 1000));
    
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' } // Margins handled by CSS
    });
    
    console.log(`[GPT Report] Successfully generated professional PDF at ${pdfPath}`);
  } finally {
    await browser.close();
  }

  return pdfPath;
}
