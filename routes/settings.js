// App-settings routes — extracted from server.js, behavior unchanged.

const express = require('express');
const { SETTINGS, saveSetting } = require('../lib/db-settings');

// Usage in server.js:
//   app.use(require('./routes/settings')({ adminOnly }));

module.exports = function createSettingsRoutes({ adminOnly }) {
  const router = express.Router();

  router.get('/api/settings', (_req, res) => res.json(SETTINGS));

  router.post('/api/admin/settings', adminOnly, async (req, res) => {
    const { registrationOpen, mockBarPublic } = req.body || {};
    if (registrationOpen !== undefined) SETTINGS.registrationOpen = !!registrationOpen;
    if (mockBarPublic     !== undefined) SETTINGS.mockBarPublic    = !!mockBarPublic;
    await Promise.all([
      saveSetting('registration_open', SETTINGS.registrationOpen),
      saveSetting('mock_bar_public',   SETTINGS.mockBarPublic),
    ]);
    res.json(SETTINGS);
  });

  router.patch('/api/admin/settings', adminOnly, async (req, res) => {
    const { key, value } = req.body || {};
    if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });
    if (key === 'bar_exam_date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return res.status(400).json({ error: 'Invalid date format (YYYY-MM-DD)' });
      SETTINGS.barExamDate = value;
      await saveSetting('bar_exam_date', value);
      return res.json({ ok: true, barExamDate: value });
    }
    res.status(400).json({ error: `Unknown setting key: ${key}` });
  });

  return router;
};
