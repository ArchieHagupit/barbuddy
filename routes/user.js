// User-state routes — extracted from server.js, behavior unchanged.
// Covers per-user progress, password change, and exam-session auto-save.
// /api/user/results lives in server.js (will move with routes/results.js).
// /api/user/tab-settings lives in routes/tab-settings.js (already extracted).

const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase } = require('../config/supabase');

// Usage in server.js:
//   app.use(require('./routes/user')({ requireAuth }));

module.exports = function createUserRoutes({ requireAuth }) {
  const router = express.Router();

  router.get('/api/user/progress', requireAuth, (req, res) => {
    res.json({ progress: req.user.progress || {} });
  });

  router.post('/api/user/progress', requireAuth, async (req, res) => {
    try {
      const { subject, topicId, done } = req.body;
      if (!subject || !topicId) return res.status(400).json({ error: 'subject and topicId required' });
      const { data } = await supabase.from('users').select('progress').eq('id', req.userId).single();
      const progress = data?.progress || {};
      if (!progress[subject]) progress[subject] = {};
      if (done) progress[subject][topicId] = true;
      else delete progress[subject][topicId];
      const { error } = await supabase.from('users').update({ progress }).eq('id', req.userId);
      if (error) throw error;
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Student-owned preferences ─────────────────────────────────
  // Currently just the due-review reminder toggle. Deliberately separate from
  // the admin-controlled access flags (spaced_repetition_enabled,
  // custom_subject_enabled) — a student can silence the reminder but cannot
  // grant themselves access to anything.
  router.patch('/api/user/preferences', requireAuth, async (req, res) => {
    try {
      const { reviewRemindersEnabled } = req.body || {};
      if (typeof reviewRemindersEnabled !== 'boolean') {
        return res.status(400).json({ error: 'reviewRemindersEnabled (boolean) required' });
      }
      const { error } = await supabase
        .from('users')
        .update({ review_reminders_enabled: reviewRemindersEnabled })
        .eq('id', req.userId);
      if (error) {
        // 42703 = undefined_column — the migration in
        // scripts/add-review-reminders-column.sql hasn't been run yet.
        if (error.code === '42703' || /review_reminders_enabled/.test(error.message || '')) {
          console.error('[user/preferences] review_reminders_enabled column missing — run scripts/add-review-reminders-column.sql');
          return res.status(503).json({ error: 'preference_storage_unavailable' });
        }
        throw error;
      }
      res.json({ success: true, reviewRemindersEnabled });
    } catch(e) {
      console.error('[user/preferences]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Exam session auto-save ────────────────────────────────────
  router.post('/api/exam-session/save', requireAuth, async (req, res) => {
    try {
      const { session } = req.body || {};
      if (!session) return res.status(400).json({ error: 'No session data' });
      const savedAt = new Date().toISOString();
      const { error } = await supabase.from('users').update({
        active_exam_session: { ...session, userId: req.userId, lastSavedAt: savedAt }
      }).eq('id', req.userId);
      if (error) throw error;
      res.json({ success: true, savedAt });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/api/exam-session/active', requireAuth, async (req, res) => {
    try {
      const { data } = await supabase.from('users').select('active_exam_session').eq('id', req.userId).single();
      const session = data?.active_exam_session;
      if (!session) return res.json({ session: null });
      const ageMs = Date.now() - new Date(session.lastSavedAt).getTime();
      if (ageMs > 24 * 60 * 60 * 1000) {
        await supabase.from('users').update({ active_exam_session: null }).eq('id', req.userId);
        return res.json({ session: null });
      }
      res.json({ session });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/exam-session/clear', requireAuth, async (req, res) => {
    try {
      const { error } = await supabase.from('users').update({ active_exam_session: null }).eq('id', req.userId);
      if (error) throw error;
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/user/change-password', requireAuth, async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords are required' });
      if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
      const { data: userData } = await supabase.from('users').select('password_hash').eq('id', req.userId).single();
      if (!userData) return res.status(404).json({ error: 'User not found' });
      const valid = await bcrypt.compare(currentPassword, userData.password_hash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
      const newHash = await bcrypt.hash(newPassword, 10);
      const { error } = await supabase.from('users').update({ password_hash: newHash }).eq('id', req.userId);
      if (error) throw error;
      res.json({ success: true, message: 'Password changed successfully' });
    } catch(e) {
      console.error('Change password error:', e.message);
      res.status(500).json({ error: 'Failed to change password' });
    }
  });

  return router;
};
