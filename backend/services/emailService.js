// ============================================================
// backend/services/emailService.js
// Send audit report via email (Resend / Nodemailer)
// ============================================================

/**
 * Send the completed audit report to the user.
 * Uses Resend if RESEND_API_KEY is set, otherwise logs to console.
 *
 * @param {Object} params
 * @param {string} params.to - Recipient email
 * @param {string} params.businessName - Business name
 * @param {string} params.reportUrl - Link to HTML report
 * @param {string} params.docxUrl - Link to DOCX download
 * @param {number} params.overallScore - Overall audit score
 * @param {string} params.executiveSummary - Brief summary text
 */
export async function sendAuditReport({ to, businessName, reportUrl, docxUrl, overallScore, executiveSummary }) {
  const subject = `Your ClickTrends AI Audit is ready · ${overallScore}/100`;

  const htmlBody = buildEmailHTML({ businessName, reportUrl, docxUrl, overallScore, executiveSummary });

  if (process.env.RESEND_API_KEY) {
    return sendViaResend({ to, subject, htmlBody });
  }

  if (process.env.SMTP_HOST) {
    return sendViaNodmailer({ to, subject, htmlBody });
  }

  // Fallback: log email content
  console.log(`[Email] Would send audit report to: ${to}`);
  console.log(`[Email] Subject: ${subject}`);
  console.log(`[Email] Report URL: ${reportUrl}`);
  return { success: true, mock: true };
}

// ─── Resend Provider ──────────────────────────────────────────
async function sendViaResend({ to, subject, htmlBody }) {
  const { Resend } = await import('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const { data, error } = await resend.emails.send({
    from: process.env.FROM_EMAIL || 'audit@clicktrends.com.au',
    to,
    subject,
    html: htmlBody,
  });

  if (error) throw new Error(`Resend error: ${error.message}`);
  console.log(`[Email] ✓ Sent via Resend to ${to}. ID: ${data?.id}`);
  return { success: true, provider: 'resend', id: data?.id };
}

// ─── Nodemailer Provider ──────────────────────────────────────
async function sendViaNodmailer({ to, subject, htmlBody }) {
  const nodemailer = await import('nodemailer');

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const info = await transporter.sendMail({
    from: process.env.FROM_EMAIL || '"ClickTrends AI Audit" <audit@clicktrends.com.au>',
    to,
    subject,
    html: htmlBody,
  });

  console.log(`[Email] ✓ Sent via Nodemailer to ${to}. Message ID: ${info.messageId}`);
  return { success: true, provider: 'nodemailer', id: info.messageId };
}

// ─── Email Template ───────────────────────────────────────────
function buildEmailHTML({ businessName, reportUrl, docxUrl, overallScore, executiveSummary }) {
  const scoreColor = overallScore >= 80 ? '#22c55e' : overallScore >= 60 ? '#f59e0b' : '#ef4444';
  const scoreLabel = overallScore >= 80 ? 'Strong foundation' : overallScore >= 60 ? 'Solid foundation, several quick wins identified' : 'Key issues found — action needed';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your AI Audit is Ready</title>
</head>
<body style="margin:0;padding:0;background:#faf9f6;font-family:'Inter',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f6;padding:40px 0;">
  <tr>
    <td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#1a1a2e;padding:24px 32px;">
            <span style="color:white;font-weight:700;font-size:1.1rem;">Click<span style="color:#f97316;">Trends</span> AI Audit</span>
          </td>
        </tr>

        <!-- Score Hero -->
        <tr>
          <td style="padding:40px 32px;text-align:center;background:#fff7ed;">
            <div style="font-size:4rem;font-weight:800;color:${scoreColor};line-height:1;">${overallScore}<span style="font-size:1.5rem;color:#9ca3af;font-weight:400;">/100</span></div>
            <div style="color:#6b7280;margin-top:8px;font-size:0.9rem;">${scoreLabel}</div>
            <div style="margin-top:4px;color:#6b7280;font-size:0.875rem;">
              <strong style="color:#1a1a2e;">${businessName || 'Your website'}</strong>
            </div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <h2 style="font-size:1.2rem;color:#1a1a2e;margin:0 0 12px;">Your AI audit is ready</h2>
            <p style="color:#4b5563;line-height:1.6;margin:0 0 20px;">
              ${executiveSummary?.slice(0, 400) || 'Your full AI audit report is now ready. Click below to view your results and download your action plan.'}
            </p>

            <!-- CTA -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding:8px 0;">
                  <a href="${reportUrl}" style="display:inline-block;background:#f97316;color:white;padding:14px 32px;border-radius:8px;font-weight:600;text-decoration:none;font-size:0.95rem;">
                    View your full audit →
                  </a>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding:8px 0;">
                  <a href="${docxUrl}" style="display:inline-block;color:#6b7280;padding:8px 16px;font-size:0.875rem;text-decoration:underline;">
                    Download .docx report
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:20px 32px;text-align:center;">
            <p style="color:#9ca3af;font-size:0.75rem;margin:0;">
              Generated by <strong style="color:#f97316;">Click Trends AI Audit</strong> · clicktrends.com.au<br>
              This link expires in 7 days.
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}
