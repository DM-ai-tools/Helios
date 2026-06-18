// ============================================================
// backend/services/puppeteerService.js
// PDF generation — Puppeteer + @sparticuz/chromium
//
// Container runs as root (no USER in Dockerfile), so
// @sparticuz/chromium can extract its binary to /tmp/chromium
// at first launch without any permission issues.
//
// @sparticuz/chromium is dynamically imported (not static) so
// the local Windows dev server starts without it installed.
// ============================================================

import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, '../../reports');

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// ─── Resolve Chromium executable ──────────────────────────────
// Production (Railway/Docker — root): @sparticuz/chromium extracts
//   its crashpad-free binary to /tmp/chromium and returns the path.
// Windows dev: use local Chrome or Edge.
async function resolveChromiumPath() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        console.log(`[Puppeteer] Using local browser: ${p}`);
        return p;
      }
    }
    throw new Error('[Puppeteer] No Chrome/Edge found on Windows. Install Chrome.');
  }

  // Linux/container: dynamic import so it does not crash on Windows
  const { default: chromium } = await import('@sparticuz/chromium');
  const execPath = await chromium.executablePath();
  console.log(`[Puppeteer] Using @sparticuz/chromium: ${execPath}`);
  return execPath;
}

// Helper to get chromium-specific launch args (Linux only)
async function getChromiumLaunchConfig() {
  if (process.platform !== 'win32') {
    const { default: chromium } = await import('@sparticuz/chromium');
    return {
      headless: chromium.headless,
      defaultViewport: chromium.defaultViewport,
      extraArgs: chromium.args,
    };
  }
  return { headless: true, defaultViewport: null, extraArgs: [] };
}

/**
 * Generate a PDF from the report page using Puppeteer.
 * @param {string} auditId
 * @returns {Promise<string>} Path to the generated PDF file
 */
export async function generateReportPDF(auditId) {
  const pdfPath = path.join(REPORTS_DIR, `audit-puppeteer-${auditId}.pdf`);

  if (fs.existsSync(pdfPath)) {
    console.log(`[Puppeteer] Serving cached PDF for audit: ${auditId}`);
    return pdfPath;
  }

  console.log(`[Puppeteer] Starting PDF generation for audit: ${auditId}`);

  const executablePath = await resolveChromiumPath();
  const { headless, defaultViewport, extraArgs } = await getChromiumLaunchConfig();

  const browser = await puppeteer.launch({
    executablePath,
    headless,
    defaultViewport,
    protocolTimeout: 120_000,
    args: [
      ...extraArgs,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--no-crashpad',
    ],
  });

  try {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(90_000);
    page.setDefaultTimeout(90_000);

    const port = process.env.PORT || 3000;
    const reportUrl = `http://127.0.0.1:${port}/report.html?auditId=${auditId}&pdf=true`;
    console.log(`[Puppeteer] Navigating to ${reportUrl}`);

    await page.goto(reportUrl, { waitUntil: 'networkidle0', timeout: 90_000 });
    await new Promise(r => setTimeout(r, 2000));

    // Scroll to trigger intersection observers / lazy-loaded content
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 100;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
      window.scrollTo(0, 0);
    });

    await new Promise(r => setTimeout(r, 1000));

    console.log('[Puppeteer] Generating PDF...');
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0px', bottom: '0px', left: '0px', right: '0px' },
    });

    fs.writeFileSync(pdfPath, pdfBuffer);
    console.log(`[Puppeteer] PDF saved: ${pdfPath}`);
    return pdfPath;

  } catch (err) {
    console.error('[Puppeteer] Error generating PDF:', err);
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}
