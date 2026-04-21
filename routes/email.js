// Email routes — extracted from server.js, behavior unchanged.
// Currently only /api/email-results. If more email routes are added,
// they belong here alongside this one.
//
// Resend package is imported locally rather than factory-injected —
// it's instantiated per-request from the env var, so there's no
// shared state to inject.

const express = require('express');
const { Resend } = require('resend');

// Usage in server.js:
//   app.use(require('./routes/email')());

module.exports = function createEmailRoutes() {
  const router = express.Router();

  // ── EMAIL RESULTS ────────────────────────────────────────────
  router.post('/api/email-results', async (req, res) => {
    if (!process.env.RESEND_API_KEY) {
      return res.json({ error: 'Email not configured. Add RESEND_API_KEY to Railway environment variables.' });
    }
    const { to, subject, htmlBody } = req.body;
    if (!to || !htmlBody) return res.status(400).json({ error: 'to and htmlBody required' });
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      // Inline the same print-preview CSS used by printMockResults() in public/index.html
      // so the ALAC model answer block (.alac-model-answer / .alac-section / etc.) renders
      // styled in emails the same way it does in print preview. Email clients including
      // Gmail support <style> in <head> for basic class selectors.
      const EMAIL_CSS = `
        body{font-family:Georgia,serif;color:#111;}
        ul{margin:4px 0 8px 0;padding-left:20px;}
        li{margin:2px 0;line-height:1.5;}
        table{width:100%;border-collapse:collapse;margin-bottom:12px;font-size:12px;}
        th{background:#f5efe0;color:#5a3e1b;padding:6px 8px;text-align:left;font-weight:600;border:1px solid #d0b870;}
        td{padding:5px 8px;border:1px solid #e8e0d0;vertical-align:top;}
        tr:nth-child(even) td{background:#faf7f2;}
        .alac-model-answer{border:1px solid #d4c5a0;border-radius:6px;margin:8px 0;background:#fffdf5;}
        .alac-model-header{background:#f5f0e8;padding:8px 12px;font-size:.85rem;font-weight:700;color:#5a3e1b;border-bottom:1px solid #d4c5a0;border-radius:6px 6px 0 0;}
        .alac-section{padding:10px 12px;border-bottom:1px solid #e8e0d0;}
        .alac-section:last-child{border-bottom:none;}
        .alac-section-label{font-size:.78rem;font-weight:700;color:#5a3e1b;text-transform:uppercase;margin-bottom:4px;}
        .alac-section-content{font-size:.88rem;color:#333;line-height:1.6;white-space:pre-line;padding-left:10px;border-left:2px solid #d4c5a0;}
        .plain-model-answer{font-size:.88rem;color:#333;line-height:1.6;white-space:pre-line;}
      `;
      await resend.emails.send({
        from: 'BarBuddy Results <onboarding@resend.dev>',
        to,
        subject: subject || 'BarBuddy Mock Bar Results',
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${EMAIL_CSS}</style></head><body>${htmlBody}</body></html>`,
      });
      res.json({ success: true });
    } catch(err) {
      console.error('[email] Send error:', err.message, err.code);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
