// ============================================================
// backend/server.js — Express entry point
// ============================================================

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import auditRouter from './routes/audit.js';
import statusRouter from './routes/status.js';
import initialAuditRouter from './routes/initialAudit.js';
import redisClient from './services/redisClient.js';
import { generateReportPDF } from './services/puppeteerService.js';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve frontend static files
app.use(express.static(resolve(__dirname, '../frontend')));

// ─── Routes ───────────────────────────────────────────────────
app.use('/api/audit', initialAuditRouter);   // initial quick audit (pre-score)
app.use('/api/audit', auditRouter);
app.use('/api/audit', statusRouter);

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

// Catch-all: serve frontend index
app.get('*', (req, res) => {
  res.sendFile(resolve(__dirname, '../frontend/index.html'));
});

// ─── Start Server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║   ClickTrends AI Audit Server             ║
║   http://localhost:${PORT}                   ║
║                                           ║
║   Env check:                              ║
║   ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '✓ set' : '✗ missing'}             ║
║   DATABASE_URL:      ${process.env.DATABASE_URL ? '✓ set' : '✗ missing'}             ║
║   RESEND_API_KEY:    ${process.env.RESEND_API_KEY ? '✓ set' : '✗ missing (email mock)'}  ║
╚═══════════════════════════════════════════╝
  `);
});

export default app;
