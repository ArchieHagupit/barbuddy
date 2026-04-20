// Results routes — extracted from server.js, behavior unchanged.
// Covers: user save, user fetch-own, user update-own, admin list/by-user/delete.
//
// Not in this file:
//   /api/xp/summary        — XP concern (stays in server.js)
//   /api/admin/improve-items — admin analytics (stays in server.js)
//   /api/email-results     — email concern, separate location (stays in server.js)
//
// awardXP is declared in server.js and passed via factory by reference.
// _mapResult imported directly from lib/mappers.

const express = require('express');
const { supabase } = require('../config/supabase');
const { _mapResult } = require('../lib/mappers');

// Usage in server.js:
//   app.use(require('./routes/results')({ requireAuth, adminOnly, awardXP }));

module.exports = function createResultsRoutes({ requireAuth, adminOnly, awardXP }) {
  const router = express.Router();

  router.post('/api/results/save', requireAuth, async (req, res) => {
    try {
      const { score, total, subject, questions, timeTakenMs, sessionType } = req.body || {};
      const questionCount = questions?.length || total || 0;
      if (score === undefined || !questionCount) return res.status(400).json({ error: 'score and total required' });
      // Normalise subject: strip display names, keep the subject key (e.g. "commercial" not "Mock Bar")
      const VALID_SUBJ_KEYS = ['civil','criminal','political','labor','commercial','taxation','remedial','ethics','custom'];
      const subjectKey = VALID_SUBJ_KEYS.includes(subject) ? subject : (subject || 'mixed');
      const id = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const maxPossible = questionCount * 10;
      const { error } = await supabase.from('results').insert([{
        id, user_id: req.userId, subject: subjectKey,
        score, total_questions: questionCount, passed: maxPossible > 0 && score / maxPossible >= 0.7,
        finished_at: new Date().toISOString(),
        questions: questions || [], answers: {}, evaluations: [], sources: [],
      }]);
      if (error) throw error;
      // Increment mock_bar_count on user
      const { data: uData } = await supabase.from('users').select('mock_bar_count').eq('id', req.userId).single();
      await supabase.from('users').update({ mock_bar_count: (uData?.mock_bar_count || 0) + 1 }).eq('id', req.userId);

      // ── Award XP ────────────────────────────────────────────────
      // mock_bar and speed_drill XP are deferred until evaluations complete
      // (awarded in /api/evaluate-batch completion handler after all evals succeed)
      let xpResult = null;
      try {
        const type = sessionType || 'mock_bar';
        if (type === 'review_session') {
          xpResult = await awardXP(
            req.userId,
            'COMPLETE_REVIEW_SESSION',
            'Completed Spaced Repetition Review Session',
            0
          );
        }
      } catch(xpErr) { console.error('[XP] results/save error:', xpErr); }

      res.json({ ok: true, id, xpResult });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/api/admin/results', adminOnly, async (req, res) => {
    try {
      const limit  = Math.min(parseInt(req.query.limit)  || 20, 500);
      const offset = parseInt(req.query.offset) || 0;
      const { data, count, error } = await supabase.from('results')
        .select('*, users(id, name, email)', { count: 'exact' })
        .order('finished_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      res.json({ results: (data || []).map(_mapResult), total: count || 0, offset, limit });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/api/admin/results/:userId', adminOnly, async (req, res) => {
    try {
      const { data } = await supabase.from('results')
        .select('*, users(id, name, email)')
        .eq('user_id', req.params.userId)
        .order('finished_at', { ascending: false });
      res.json((data || []).map(_mapResult));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── User: fetch own results for progress dashboard ───────────────
  router.get('/api/user/results', requireAuth, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('results')
        .select('id, score, total_questions, subject, finished_at, passed')
        .eq('user_id', req.userId)
        .order('finished_at', { ascending: true });
      if (error) throw error;
      res.json(data || []);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/admin/results/:resultId', adminOnly, async (req, res) => {
    try {
      const { error } = await supabase.from('results').delete().eq('id', req.params.resultId);
      if (error) throw error;
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // Update an existing result record after a retry evaluation
  router.patch('/api/results/:resultId', requireAuth, async (req, res) => {
    try {
      const { resultId } = req.params;
      const { score, questions, passed } = req.body || {};
      if (score === undefined) return res.status(400).json({ error: 'score required' });
      // Verify the record belongs to this user before updating
      const { data: existing, error: fetchErr } = await supabase
        .from('results').select('id, user_id').eq('id', resultId).single();
      if (fetchErr || !existing) return res.status(404).json({ error: 'Result not found' });
      if (existing.user_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
      const total = questions?.length || 0;
      const maxPossible = total * 10;
      const { error } = await supabase.from('results').update({
        score: parseFloat(score.toFixed ? score.toFixed(2) : score),
        passed: passed ?? (maxPossible > 0 && score / maxPossible >= 0.7),
        questions: questions || [],
        last_updated_at: new Date().toISOString(),
      }).eq('id', resultId);
      if (error) throw error;
      res.json({ ok: true });
    } catch(e) {
      console.error('[results/patch] Error:', e.message, e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
