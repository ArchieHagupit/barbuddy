// Admin-misc routes — grab-bag for 3 small routes that don't cluster
// with any existing extracted router. Named "admin-misc" to mirror
// routes/misc.js (which similarly groups unrelated small routes like
// health/status/catchall).
//
// Contents:
//   - GET  /api/xp/summary         — user XP/level progress (requireAuth)
//   - GET  /api/admin/improve-items — aggregated student improvement
//                                     items across all results (adminOnly)
//   - POST /api/admin/generate     — manually trigger pre-generation of
//                                     lesson/quiz content (adminOnly)
//
// Not the last word on grouping — if we later extract a cohesive
// /api/xp/* group, xp/summary can migrate there.

const express = require('express');
const { supabase } = require('../config/supabase');
const { LEVEL_THRESHOLDS, getTitleFromLevel, getXPForNextLevel } = require('../lib/xp');
const { countAllTopics } = require('../lib/syllabus-tree');

// Usage in server.js:
//   app.use(require('./routes/admin-misc')({
//     requireAuth, adminOnly,
//     KB, GEN, triggerPreGeneration,
//   }));

module.exports = function createAdminMiscRoutes({
  requireAuth, adminOnly,
  KB, GEN, triggerPreGeneration,
}) {
  const router = express.Router();

  // ── XP Summary ───────────────────────────────────────────────
  router.get('/api/xp/summary', requireAuth, async (req, res) => {
    try {
      const { data: user } = await supabase
        .from('users')
        .select('xp, level')
        .eq('id', req.userId)
        .single();

      const xp    = user?.xp    || 0;
      const level = user?.level || 1;
      const title = getTitleFromLevel(level);
      const nextLevelXP  = getXPForNextLevel(level);
      const curLevelXP   = LEVEL_THRESHOLDS[level - 1] || 0;
      const rangeXP      = (nextLevelXP || curLevelXP + 1) - curLevelXP;
      const progressPercent = nextLevelXP ? Math.floor(((xp - curLevelXP) / rangeXP) * 100) : 100;
      const xpToNextLevel   = nextLevelXP ? nextLevelXP - xp : 0;

      const { data: recent } = await supabase
        .from('xp_transactions')
        .select('id, xp_earned, action, description, created_at')
        .eq('user_id', req.userId)
        .order('created_at', { ascending: false })
        .limit(20);

      res.json({ xp, level, title, xpToNextLevel, progressPercent, recentTransactions: recent || [] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Admin: aggregated Improve items across all results ──────────
  router.get('/api/admin/improve-items', adminOnly, async (req, res) => {
    try {
      const limit    = Math.min(parseInt(req.query.limit)  || 20, 100);
      const offset   = parseInt(req.query.offset) || 0;
      const subject  = req.query.subject  || '';
      const dateFrom = req.query.dateFrom || '';
      const dateTo   = req.query.dateTo   || '';

      // Build filtered query for total count
      let countQ = supabase.from('results').select('id', { count: 'exact', head: true })
        .not('questions', 'is', null);
      if (subject && subject !== 'all') countQ = countQ.eq('subject', subject);
      if (dateFrom) countQ = countQ.gte('finished_at', dateFrom);
      if (dateTo)   countQ = countQ.lte('finished_at', dateTo + 'T23:59:59.999Z');
      const { count: totalResults } = await countQ;

      // Build filtered data query
      let dataQ = supabase.from('results')
        .select('id, user_id, subject, finished_at, questions, users(id, name, email)')
        .not('questions', 'is', null)
        .order('finished_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (subject && subject !== 'all') dataQ = dataQ.eq('subject', subject);
      if (dateFrom) dataQ = dataQ.gte('finished_at', dateFrom);
      if (dateTo)   dataQ = dataQ.lte('finished_at', dateTo + 'T23:59:59.999Z');

      const { data, error } = await dataQ;
      if (error) throw error;
      const items = [];
      for (const row of data || []) {
        const studentName = row.users?.name || row.user_id || 'Unknown';
        const subj        = row.subject     || '';
        const date        = row.finished_at || '';
        for (const q of row.questions || []) {
          const improves = Array.isArray(q.improvements) ? q.improvements : [];
          const missed   = Array.isArray(q.keyMissed)    ? q.keyMissed    : [];
          if (improves.length || missed.length) {
            items.push({
              resultId:    row.id,
              studentName,
              subject: subj,
              question:    q.q || '',
              improvements: improves,
              keyMissed:    missed,
              date,
            });
          }
        }
      }
      res.json({ items, total: totalResults || 0, offset, limit });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── ADMIN: Manually trigger generation ─────────────────────
  router.post('/api/admin/generate', adminOnly, (req, res) => {
    if (!KB.syllabus) return res.status(400).json({ error:'No syllabus' });
    if (GEN.running) return res.json({ message:'Already running', done:GEN.done, total:GEN.total });
    triggerPreGeneration();
    const topicsArr = (KB.syllabus.topics || []).flatMap(s => s.topics || []);
    res.json({ message:'Started', total:countAllTopics(topicsArr) });
  });

  return router;
};
