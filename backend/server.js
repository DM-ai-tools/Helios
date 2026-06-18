// ============================================================
// backend/server.js — Express entry point
// ============================================================

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// ─── Global error guards ───────────────────────────────────────
// Prevent unhandled promise rejections / uncaught exceptions from
// killing the server process and resetting all active SSE connections.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled Promise Rejection:', reason?.message || reason);
  console.error('[Server] Promise:', promise);
  // Do NOT process.exit() — keep the server alive
});

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught Exception:', err.message);
  console.error(err.stack);
  // Do NOT exit — log and continue
});

import auditRouter from './routes/audit.js';
import statusRouter from './routes/status.js';
import initialAuditRouter from './routes/initialAudit.js';
import implementationRouter from './routes/implementation.js';
import integrationsRouter from './routes/integrations.js';
import deploymentRouter from './routes/deployment.js';
import { initDatabase } from './db/dbInit.js';
import redisClient from './services/redisClient.js';
import { deploymentWorker } from './services/deploymentWorker.js'; // Start background worker
import { pageWorker } from './services/pageWorker.js'; // Start landing page generation background worker
import { generateReportPDF } from './services/puppeteerService.js';
import fs from 'fs';
import cookieParser from 'cookie-parser';
import authRouter from './routes/auth.js';
import { requireAuthAPI, requireAuthHTML } from './middleware/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Healthcheck ──────────────────────────────────────────────
app.get('/health', (req, res) => res.status(200).send('OK'));

// ─── Public Routes & Assets ───────────────────────────────────
app.get('/login.html', (req, res) => res.sendFile(resolve(__dirname, '../frontend/login.html')));
app.get('/register.html', (req, res) => res.sendFile(resolve(__dirname, '../frontend/register.html')));

// Serve assets so login/register can look nice
app.use('/css', express.static(resolve(__dirname, '../frontend/css')));
app.use('/js', express.static(resolve(__dirname, '../frontend/js')));
app.use('/logos', express.static(resolve(__dirname, '../frontend/logos')));

app.use('/api/auth', authRouter);

// ─── Protected Frontend HTML ──────────────────────────────────
app.use(requireAuthHTML);
app.use(express.static(resolve(__dirname, '../frontend')));

// ─── Protected API Routes ─────────────────────────────────────
app.use('/api/audit', requireAuthAPI, initialAuditRouter);   // initial quick audit (pre-score)
app.use('/api/audit', requireAuthAPI, auditRouter);
app.use('/api/audit', requireAuthAPI, statusRouter);
app.use('/api/implementation', requireAuthAPI, implementationRouter);  // implementation approval workflow
app.use('/api/integrations', requireAuthAPI, integrationsRouter);
app.use('/api/deployment', requireAuthAPI, deploymentRouter);

// Integrations Settings Page
app.get('/settings/integrations', requireAuthHTML, (req, res) => {
  res.sendFile(resolve(__dirname, '../frontend/integrations.html'));
});

// Deployment History Page
app.get('/implementation/history', (req, res) => {
  res.sendFile(resolve(__dirname, '../frontend/history.html'));
});

// Serve cached HTML reports
app.get('/reports/:auditId', async (req, res) => {
  const { auditId } = req.params;
  
  try {
    const dataStr = await redisClient.get(`report:${auditId}`);
    if (!dataStr) {
      return res.status(404).send('Report not found or not yet generated (or it has expired).');
    }
    const cache = JSON.parse(dataStr);
    res.setHeader('Content-Type', 'text/html');
    res.send(cache.html);
  } catch (err) {
    console.error(`[Server] Error fetching HTML report for ${auditId}:`, err);
    res.status(500).send('Internal Server Error');
  }
});

// Download DOCX reports (legacy)
app.get('/reports/:auditId/download.docx', async (req, res) => {
  const { auditId } = req.params;
  
  try {
    const dataStr = await redisClient.get(`report:${auditId}`);
    if (!dataStr) {
      return res.status(404).send('DOCX not found or expired.');
    }
    const cache = JSON.parse(dataStr);
    
    if (!cache.docxBase64) {
      return res.status(404).send('DOCX data missing in cache.');
    }

    const docxBuffer = Buffer.from(cache.docxBase64, 'base64');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="clicktrends-audit-${auditId}.docx"`);
    res.send(docxBuffer);
  } catch (err) {
    console.error(`[Server] Error fetching DOCX report for ${auditId}:`, err);
    res.status(500).send('Internal Server Error');
  }
});

// ─── PDF Download Route ─────────────────────────────────────────
app.get('/api/audits/:auditId/download-pdf', async (req, res) => {
  const { auditId } = req.params;
  try {
    // We use OpenAI GPT to synthesize and beautifully format the raw Claude data sequentially
    const { generateGptReportPdf } = await import('./services/gptReportService.js');
    const pdfPath = await generateGptReportPdf(auditId);
    
    // Serve the generated PDF
    const fileStream = fs.createReadStream(pdfPath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=audit_${auditId}.pdf`);
    fileStream.pipe(res);
  } catch (err) {
    console.error(`[PDFRoute] Error generating PDF for ${auditId}:`, err);
    res.status(500).json({ error: 'Failed to generate PDF report' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    env: {
      hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
      hasDbUrl: !!process.env.DATABASE_URL,
      hasEmailKey: !!(process.env.RESEND_API_KEY || process.env.SMTP_HOST),
    },
  });
});

// Email Sequence Campaign Builder — /audit/:auditId/email-sequence/implementation
// Must be registered BEFORE the generic implementation route and catch-all
app.get('/audit/:auditId/email-sequence/implementation', (req, res) => {
  res.sendFile(resolve(__dirname, '../frontend/email-sequence-builder.html'));
});

// Implementation dashboard — /audit/:auditId/plugin/:pluginId/implementation
app.get('/audit/:auditId/plugin/:pluginId/implementation', (req, res) => {
  res.sendFile(resolve(__dirname, '../frontend/implementation.html'));
});

// Catch-all: serve frontend index
app.get('*', (req, res) => {
  res.sendFile(resolve(__dirname, '../frontend/index.html'));
});

// ─── Initialize DB and Start Server ───────────────────────────
(async () => {
  await initDatabase();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════╗
║   ClickTrends AI Audit Server             ║
║   http://0.0.0.0:${PORT}                     ║
║                                           ║
║   Env check:                              ║
║   ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '✓ set' : '✗ missing'}             ║
║   DATABASE_URL:      ${process.env.DATABASE_URL ? '✓ set' : '✗ missing'}             ║
║   RESEND_API_KEY:    ${process.env.RESEND_API_KEY ? '✓ set' : '✗ missing (email mock)'}  ║
╚═══════════════════════════════════════════╝
    `);
  });
})();

export default app;
// Manual restart trigger 2
