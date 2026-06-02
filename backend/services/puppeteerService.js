import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, '../../reports');

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

/**
 * Generate a PDF from the report page using Puppeteer
 * @param {string} auditId - The audit ID to generate for
 * @param {number} port - The local server port
 * @returns {Promise<string>} - Returns the file path of the generated PDF
 */
export async function generateReportPDF(auditId, port) {
  const pdfPath = path.join(REPORTS_DIR, `audit-puppeteer-${auditId}.pdf`);

  // If already exists, return the cached path
  if (fs.existsSync(pdfPath)) {
    console.log(`[Puppeteer] Serving cached PDF for audit: ${auditId}`);
    return pdfPath;
  }

  console.log(`[Puppeteer] Starting PDF generation for audit: ${auditId}`);
  
  // Launch Puppeteer headless — works on both local Windows (via bundled Chromium)
  // and Linux containers (Railway). --no-sandbox is required in container environments.
  const isLinux = process.platform !== 'win32';

  const launchOptions = {
    headless: true,
    ...(isLinux && { userDataDir: '/tmp/puppeteer-user-data' }),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',       // use /tmp instead of /dev/shm
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-popup-blocking',
      '--no-zygote',                   // no zygote forking in containers
      '--single-process',              // runs renderer in same process — stops crashpad subprocess
      '--disable-crash-reporter',      // disable crash reporting
      '--crash-dumps-dir=/tmp',        // give crashpad a writable DB path (fixes the error directly)
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  };

  // On Windows dev, prefer local Chrome if available; fall back to Puppeteer's Chromium
  if (process.platform === 'win32') {
    const localChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    if (fs.existsSync(localChrome)) {
      launchOptions.executablePath = localChrome;
      delete launchOptions.userDataDir;
    }
  }

  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();
    
    // Increase timeout in case report rendering takes time
    page.setDefaultNavigationTimeout(60000);
    
    const port = process.env.PORT || 3000;
    const reportUrl = `http://localhost:${port}/report.html?auditId=${auditId}&pdf=true`;
    console.log(`[Puppeteer] Navigating to ${reportUrl}`);

    // Wait until network is mostly idle to ensure charts/animations render
    await page.goto(reportUrl, { waitUntil: 'networkidle0' });

    // Wait an extra 2 seconds for any JS animations to settle
    await new Promise(r => setTimeout(r, 2000));

    // Force scrolling to bottom to ensure lazy-loaded items or intersection observers trigger
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
      // Scroll back to top
      window.scrollTo(0, 0);
    });
    
    // Wait for a brief moment after scrolling
    await new Promise(r => setTimeout(r, 1000));

    console.log('[Puppeteer] Generating PDF buffer...');
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '0px',
        bottom: '0px',
        left: '0px',
        right: '0px'
      }
    });

    console.log(`[Puppeteer] Saving PDF to ${pdfPath}`);
    fs.writeFileSync(pdfPath, pdfBuffer);

    return pdfPath;
  } catch (err) {
    console.error('[Puppeteer] Error generating PDF:', err);
    throw err;
  } finally {
    await browser.close();
  }
}
