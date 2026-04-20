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
      await resend.emails.send({
        from: 'BarBuddy Results <onboarding@resend.dev>',
        to,
        subject: subject || 'BarBuddy Mock Bar Results',
        html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>${htmlBody}</body></html>`,
      });
      res.json({ success: true });
    } catch(err) {
      console.error('[email] Send error:', err.message, err.code);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
