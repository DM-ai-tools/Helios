// ============================================================
// backend/services/puppeteerService.js
// PDF generation using Puppeteer + @sparticuz/chromium
//
// @sparticuz/chromium ships a pre-compiled Chromium binary with
// crashpad completely removed — purpose-built for containers.
// On Windows dev, falls back to local Chrome or bundled Chromium.
// ============================================================

import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, '../../reports');

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// ─── Resolve the correct Chromium executable ──────────────────
// Production (Railway/Docker): @sparticuz/chromium extracts its
//   crashpad-free binary to /tmp/chromium and returns the path.
// Windows dev: use local Chrome if available.
async function resolveExecutablePath() {
  // Honour an explicit override (e.g. PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    console.log(`[Puppeteer] Using PUPPETEER_EXECUTABLE_PATH: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // Windows dev: prefer locally installed Chrome
  if (process.platform === 'win32') {
    const localChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (fs.existsSync(localChrome)) {
      console.log(`[Puppeteer] Using local Chrome: ${localChrome}`);
      return localChrome;
    }
  }

  // Container / Linux: @sparticuz/chromium — extracts to /tmp/chromium
  const execPath = await chromium.executablePath();
  console.log(`[Puppeteer] Using @sparticuz/chromium: ${execPath}`);
  return execPath;
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

  const executablePath = await resolveExecutablePath();

  // @sparticuz/chromium.args includes all container-safe flags:
  // --no-sandbox, --disable-setuid-sandbox, --disable-dev-shm-usage, etc.
  // We merge with our own extras.
  const browser = await puppeteer.launch({
    executablePath,
    headless: chromium.headless,
    defaultViewport: chromium.defaultViewport,
    protocolTimeout: 120_000,
    args: [
      ...chromium.args,
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
    const reportUrl = `http://localhost:${port}/report.html?auditId=${auditId}&pdf=true`;
    console.log(`[Puppeteer] Navigating to ${reportUrl}`);

    await page.goto(reportUrl, { waitUntil: 'networkidle0', timeout: 90_000 });
    await new Promise(r => setTimeout(r, 2000));

    // Scroll to trigger intersection observers / lazy content
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
    console.log(`[Puppeteer] PDF saved to ${pdfPath}`);
    return pdfPath;

  } catch (err) {
    console.error('[Puppeteer] Error generating PDF:', err);
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}
