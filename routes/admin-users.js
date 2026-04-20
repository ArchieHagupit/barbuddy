// Admin user-management routes — extracted from server.js, behavior unchanged.
//
// Covers: password-reset request triage (list/resolve/dismiss) and user CRUD
// (list/search, update active+admin flags, role toggle with self-demotion
// guard, per-user spaced-rep + custom-subject flags, user delete).
//
// RESET_REQUESTS is let-declared in server.js and reassigned at boot —
// we receive a getResetRequests closure so the router always sees the
// current array. Admin routes only read/mutate elements in place
// (no reassignment), so no setter needed.

const express = require('express');
const bcrypt = require('bcryptjs');
const { supabase } = require('../config/supabase');
const { saveSetting } = require('../lib/db-settings');
const { mapUser } = require('../lib/mappers');

// Usage in server.js:
//   app.use(require('./routes/admin-users')({
//     adminOnly,
//     getResetRequests: () => RESET_REQUESTS,
//   }));

module.exports = function createAdminUsersRoutes({ adminOnly, getResetRequests }) {
  const router = express.Router();

  // ── Password reset requests ────────────────────────────────
  router.get('/api/admin/reset-requests', adminOnly, (_req, res) => {
    const sorted = [...getResetRequests()].sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
    res.json(sorted);
  });

  router.post('/api/admin/reset-password', adminOnly, async (req, res) => {
    try {
      const { userId, newPassword, requestId } = req.body || {};
      if (!userId || !newPassword) return res.status(400).json({ error: 'userId and newPassword required' });
      const { data: user } = await supabase.from('users').select('id').eq('id', userId).single();
      if (!user) return res.status(404).json({ error: 'User not found' });
      const passwordHash = await bcrypt.hash(newPassword, 10);
      await supabase.from('users').update({ password_hash: passwordHash }).eq('id', userId);
      if (requestId) {
        const resetRequests = getResetRequests();
        const r = resetRequests.find(r => r.id === requestId);
        if (r) { r.status = 'resolved'; r.resolvedAt = new Date().toISOString(); }
        saveSetting('reset_requests', resetRequests).catch(() => {});
      }
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/admin/reset-requests/:id', adminOnly, async (req, res) => {
    const resetRequests = getResetRequests();
    const item = resetRequests.find(r => r.id === req.params.id);
    if (item) { item.status = 'dismissed'; saveSetting('reset_requests', resetRequests).catch(() => {}); }
    res.json({ ok: true });
  });

  // ── User management ────────────────────────────────────────
  router.get('/api/admin/users', adminOnly, async (req, res) => {
    try {
      const { search, limit = 5 } = req.query;
      let query = supabase.from('users').select('*').order('joined_at', { ascending: false });
      if (search && search.trim()) {
        const s = search.trim().replace(/%/g, '');
        query = query.or(`name.ilike.%${s}%,email.ilike.%${s}%`);
        query = query.limit(20);
      } else {
        query = query.limit(parseInt(limit) || 5);
      }
      const { data } = await query;
      res.json((data || []).map(u => {
        const m = mapUser(u);
        return { id: m.id, name: m.name, email: m.email, role: m.role, isAdmin: m.isAdmin,
                 active: m.active, status: m.status, createdAt: m.createdAt, registeredAt: m.registeredAt,
                 school: m.school, stats: m.stats, tabSettings: m.tabSettings || null,
                 spacedRepEnabled: m.spacedRepEnabled, customSubjectEnabled: m.customSubjectEnabled, level: m.level, xp: m.xp };
      }));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/api/admin/users/:userId', adminOnly, async (req, res) => {
    try {
      const { active, isAdmin } = req.body || {};
      const updates = {};
      if (active  !== undefined) updates.is_active = !!active;
      if (isAdmin !== undefined) updates.is_admin  = !!isAdmin;
      const { error } = await supabase.from('users').update(updates).eq('id', req.params.userId);
      if (error) throw error;
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/api/admin/users/:userId/role', adminOnly, async (req, res) => {
    try {
      const { isAdmin } = req.body || {};
      if (req.params.userId === req.userId && !isAdmin)
        return res.status(400).json({ error: 'Cannot remove your own admin access' });
      const { error } = await supabase.from('users').update({ is_admin: !!isAdmin }).eq('id', req.params.userId);
      if (error) throw error;
      res.json({ success: true, userId: req.params.userId, isAdmin: !!isAdmin });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/api/admin/users/:userId/spaced-repetition', adminOnly, async (req, res) => {
    try {
      const { enabled } = req.body;
      const { userId } = req.params;
      const { error } = await supabase.from('users').update({ spaced_repetition_enabled: !!enabled }).eq('id', userId);
      if (error) return res.status(500).json({ error: error.message });
      res.json({ ok: true, userId, enabled: !!enabled });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/api/admin/users/:userId/custom-subject', adminOnly, async (req, res) => {
    try {
      const { enabled } = req.body;
      const { userId } = req.params;
      const { error } = await supabase.from('users').update({ custom_subject_enabled: !!enabled }).eq('id', userId);
      if (error) return res.status(500).json({ error: error.message });
      res.json({ ok: true, userId, enabled: !!enabled });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/admin/users/:userId', adminOnly, async (req, res) => {
    try {
      await supabase.from('sessions').delete().eq('user_id', req.params.userId);
      const { error } = await supabase.from('users').delete().eq('id', req.params.userId);
      if (error) throw error;
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
