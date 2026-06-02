// ============================================================
// backend/services/puppeteerService.js
// PDF generation — Puppeteer + @sparticuz/chromium
//
// The Chromium binary is pre-extracted during Docker build into
// /app/chromium-binary (set as CHROMIUM_BINARY_PATH env var).
// No runtime extraction needed — no /tmp permission issues.
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

// ─── Resolve the Chromium executable path ─────────────────────
// Priority:
//  1. CHROMIUM_BINARY_PATH  — pre-extracted binary set in Dockerfile
//  2. PUPPETEER_EXECUTABLE_PATH — explicit override (e.g. /usr/bin/chromium)
//  3. Local Chrome on Windows dev
//  4. chromium.executablePath() — runtime extraction into /tmp (fallback)
async function resolveChromiumPath() {
  // 1. Pre-extracted binary (set by Dockerfile during build — most reliable)
  if (process.env.CHROMIUM_BINARY_PATH && fs.existsSync(process.env.CHROMIUM_BINARY_PATH)) {
    console.log(`[Puppeteer] Using pre-extracted binary: ${process.env.CHROMIUM_BINARY_PATH}`);
    return process.env.CHROMIUM_BINARY_PATH;
  }

  // 2. Explicit path override
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    console.log(`[Puppeteer] Using PUPPETEER_EXECUTABLE_PATH: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // 3. Windows dev: local Chrome
  if (process.platform === 'win32') {
    const localChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (fs.existsSync(localChrome)) {
      console.log(`[Puppeteer] Using local Chrome: ${localChrome}`);
      return localChrome;
    }
  }

  // 4. Fallback: runtime extraction (may fail in restricted containers)
  console.log('[Puppeteer] Falling back to runtime chromium extraction...');
  return await chromium.executablePath();
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
