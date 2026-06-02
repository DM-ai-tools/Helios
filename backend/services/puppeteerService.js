import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, '../../reports');

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// ─── Container-safe Puppeteer launch options ──────────────────
// On Railway (Linux), we use the apt-installed system Chromium via
// PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium. On Windows dev we
// prefer local Chrome; fall back to Puppeteer's bundled Chromium.
function buildLaunchOptions(userDataDir) {
  const isLinux = process.platform !== 'win32';

  const opts = {
    headless: true,
    // protocolTimeout covers cold-start delays on Railway
    protocolTimeout: 120_000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',        // use /tmp instead of /dev/shm
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-popup-blocking',
      '--disable-crash-reporter',       // disable crashpad crash reporting
      '--disable-breakpad',             // disable breakpad crash handler
      '--no-crashpad',                  // explicitly disable crashpad on Chrome 127+
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  };

  // Use system Chromium if PUPPETEER_EXECUTABLE_PATH is set (set in Dockerfile)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    console.log(`[Puppeteer] Using system Chromium: ${opts.executablePath}`);
  } else if (process.platform === 'win32') {
    // Windows dev: prefer local Chrome if installed
    const localChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (fs.existsSync(localChrome)) {
      opts.executablePath = localChrome;
      console.log(`[Puppeteer] Using local Chrome: ${opts.executablePath}`);
    }
  }

  // Provide a writable userDataDir in containers (avoids Chrome profile write errors)
  if (isLinux && userDataDir) {
    opts.userDataDir = userDataDir;
  }

  return opts;
}

/**
 * Generate a PDF from the report page using Puppeteer
 * @param {string} auditId - The audit ID to generate for
 * @returns {Promise<string>} - Returns the file path of the generated PDF
 */
export async function generateReportPDF(auditId) {
  const pdfPath = path.join(REPORTS_DIR, `audit-puppeteer-${auditId}.pdf`);

  // If already exists, return the cached path
  if (fs.existsSync(pdfPath)) {
    console.log(`[Puppeteer] Serving cached PDF for audit: ${auditId}`);
    return pdfPath;
  }

  console.log(`[Puppeteer] Starting PDF generation for audit: ${auditId}`);

  const launchOptions = buildLaunchOptions('/tmp/puppeteer-user-data');
  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();

    // Generous timeouts for Railway cold starts
    page.setDefaultNavigationTimeout(90_000);
    page.setDefaultTimeout(90_000);

    const port = process.env.PORT || 3000;
    const reportUrl = `http://localhost:${port}/report.html?auditId=${auditId}&pdf=true`;
    console.log(`[Puppeteer] Navigating to ${reportUrl}`);

    // Wait until network is mostly idle so charts/animations render
    await page.goto(reportUrl, { waitUntil: 'networkidle0', timeout: 90_000 });

    // Extra time for JS animations and intersection observers
    await new Promise(r => setTimeout(r, 2000));

    // Scroll to bottom to trigger lazy-loaded content / intersection observers
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 100;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
      window.scrollTo(0, 0);
    });

    await new Promise(r => setTimeout(r, 1000));

    console.log('[Puppeteer] Generating PDF buffer...');
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0px', bottom: '0px', left: '0px', right: '0px' },
    });

    console.log(`[Puppeteer] Saving PDF to ${pdfPath}`);
    fs.writeFileSync(pdfPath, pdfBuffer);

    return pdfPath;
  } catch (err) {
    console.error('[Puppeteer] Error generating PDF:', err);
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}
