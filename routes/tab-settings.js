// Tab-settings routes — extracted from server.js, behavior unchanged.
//
// Uses getter/setter factory pattern because server.js reassigns
// TAB_SETTINGS with `=` (not in-place mutation). A plain import would
// freeze the imported reference at the OLD object.
//
// Usage in server.js:
//   app.use(require('./routes/tab-settings')({
//     requireAuth, adminOnly,
//     getTabSettings: () => TAB_SETTINGS,
//     setTabSettings: (v) => { TAB_SETTINGS = v; },
//     DEFAULT_TAB_SETTINGS, deepMerge,
//     saveSetting,
//   }));

const express = require('express');
const { supabase } = require('../config/supabase');

module.exports = function createTabSettingsRoutes({
  requireAuth, adminOnly,
  getTabSettings, setTabSettings,
  DEFAULT_TAB_SETTINGS, deepMerge,
  saveSetting,
}) {
  const router = express.Router();

  router.get('/api/tab-settings', (_req, res) => res.json({ ...getTabSettings() }));

  router.post('/api/admin/tab-settings', adminOnly, async (req, res) => {
    try {
      const incoming = req.body;
      if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Invalid settings object' });
      const merged = deepMerge(JSON.parse(JSON.stringify(DEFAULT_TAB_SETTINGS)), incoming);
      setTabSettings(merged);
      await saveSetting('tab_settings', merged);
      res.json({ success: true, settings: merged });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/api/user/tab-settings', requireAuth, (req, res) => {
    const userTS = req.user.tabSettings || null;
    // Start from global settings, then apply personal restrictions (AND logic — global disabled always wins)
    const merged = JSON.parse(JSON.stringify(getTabSettings()));
    if (userTS) {
      for (const subj of Object.keys(merged.subjects || {})) {
        for (const mode of Object.keys(merged.subjects[subj] || {})) {
          const personalVal = userTS.subjects?.[subj]?.[mode];
          if (personalVal === false) merged.subjects[subj][mode] = false;
        }
      }
      if (userTS.overview === false) merged.overview = false;
      if (userTS.spaced_repetition === false) merged.spaced_repetition = false;
    }
    res.json(merged);
  });

  router.get('/api/admin/users/:userId/tab-settings', adminOnly, async (req, res) => {
    try {
      const { data, error } = await supabase.from('users').select('tab_settings').eq('id', req.params.userId).single();
      if (error || !data) return res.status(404).json({ error: 'User not found' });
      res.json({ tabSettings: data.tab_settings || null });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/api/admin/users/:userId/tab-settings', adminOnly, async (req, res) => {
    try {
      const { error } = await supabase.from('users').update({ tab_settings: req.body.tabSettings || null }).eq('id', req.params.userId);
      if (error) throw error;
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/admin/users/:userId/tab-settings', adminOnly, async (req, res) => {
    try {
      const { error } = await supabase.from('users').update({ tab_settings: null }).eq('id', req.params.userId);
      if (error) throw error;
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
