// Auth routes — extracted from server.js, behavior unchanged.
//
// Covers: register, login (with daily XP), logout, me, forgot-password.
//
// All 5 routes are critical-path — if auth breaks, every user is locked
// out of the app. Handler bodies are byte-for-byte identical to the
// originals; the only mechanical changes are the require-imports at the
// top and the factory wrapper.
//
// RESET_REQUESTS: read + mutate closure (forgot-password does .find()
// and .unshift() on the shared array; reassignment only happens at boot
// in server.js, never from this module).

const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase } = require('../config/supabase');
const { SETTINGS, saveSetting } = require('../lib/db-settings');
const { createSession, deleteSession } = require('../lib/db-sessions');
const { mapUser } = require('../lib/mappers');
const { authLimiter } = require('../middleware/rate-limiters');

// Usage in server.js:
//   app.use(require('./routes/auth')({
//     requireAuth, ADMIN_EMAIL, awardXP,
//     getResetRequests: () => RESET_REQUESTS,
//   }));

module.exports = function createAuthRoutes({
  requireAuth, ADMIN_EMAIL, awardXP, getResetRequests,
}) {
  const router = express.Router();

  router.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
      if (!SETTINGS.registrationOpen) return res.status(403).json({ error: 'Registration is currently closed' });
      const { name, email, password, school } = req.body || {};
      if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });
      const emailLower = email.toLowerCase().trim();
      const { data: existing } = await supabase.from('users').select('id').eq('email', emailLower).single();
      if (existing) return res.status(409).json({ error: 'Email already registered' });
      const { count } = await supabase.from('users').select('*', { count: 'exact', head: true });
      const isFirstUser  = (count || 0) === 0;
      const isAdminEmail = ADMIN_EMAIL && emailLower === ADMIN_EMAIL.toLowerCase();
      const isPrivileged = isFirstUser || !!isAdminEmail;
      const id = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const passwordHash = await bcrypt.hash(password, 10);
      const now = new Date().toISOString();
      const { error: insertErr } = await supabase.from('users').insert([{
        id, name: name.trim(), email: emailLower, password_hash: passwordHash,
        is_admin: isPrivileged, is_active: true,
        status: 'active',
        privacy_consent: true, consent_date: now,
        registered_at: now, joined_at: now,
        progress: {}, tab_settings: {},
        school: school || null,
      }]);
      if (insertErr) throw insertErr;

      const token = await createSession(id);
      return res.json({ token, user: { id, name: name.trim(), email: emailLower,
        role: isPrivileged ? 'admin' : 'student', isAdmin: isPrivileged } });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
      const { data: user } = await supabase.from('users').select('*').eq('email', email.toLowerCase().trim()).single();
      if (!user) return res.status(401).json({ error: 'Invalid email or password' });
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
      if (!user.is_active) return res.status(403).json({ error: 'Account is disabled' });
      if (user.status === 'rejected' || user.status === 'disabled') {
        return res.status(403).json({ error: 'account_disabled', message: 'Your account has been disabled. Please contact the admin.' });
      }
      const token = await createSession(user.id);
      // Daily login XP (once per calendar day)
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }); // YYYY-MM-DD in PHT
      if (user.last_login_xp_date !== today) {
        await supabase.from('users').update({ last_login_xp_date: today }).eq('id', user.id);
        awardXP(user.id, 'DAILY_LOGIN', 'Daily login bonus').catch(() => {});
      }
      const u = mapUser(user);
      res.json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.role, isAdmin: u.isAdmin, spacedRepEnabled: u.spacedRepEnabled, customSubjectEnabled: u.customSubjectEnabled } });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/auth/logout', requireAuth, async (req, res) => {
    try {
      await deleteSession(req.headers['x-session-token']);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/api/auth/me', requireAuth, (req, res) => {
    const u = req.user;
    res.json({ id: u.id, name: u.name, email: u.email, role: u.role, isAdmin: u.isAdmin || false, spacedRepEnabled: u.spacedRepEnabled !== false, customSubjectEnabled: u.customSubjectEnabled !== false });
  });

  // ── Password reset routes ─────────────────────────────────────
  router.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
    try {
      const { email } = req.body || {};
      if (!email) return res.status(400).json({ error: 'Email required' });
      const { data: user } = await supabase.from('users').select('id,name,email').eq('email', email.toLowerCase().trim()).single();
      if (user) {
        const resetRequests = getResetRequests();
        const existing = resetRequests.find(r => r.email === user.email && r.status === 'pending');
        if (!existing) {
          resetRequests.unshift({ id: 'reset_' + Date.now(), userId: user.id, name: user.name, email: user.email, requestedAt: new Date().toISOString(), status: 'pending' });
          saveSetting('reset_requests', resetRequests).catch(() => {});
        }
      }
      res.json({ success: true }); // always success — don't reveal if email exists
    } catch(e) { res.json({ success: true }); }
  });

  return router;
};
