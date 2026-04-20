// Spaced repetition routes — extracted from server.js, behavior unchanged.
// User-facing endpoints: fetch due reviews + stats.
// Admin endpoint /api/admin/users/:userId/spaced-repetition stays in server.js
// (it belongs with admin user-management, extracted later).

const express = require('express');
const { supabase } = require('../config/supabase');

// Usage in server.js:
//   app.use(require('./routes/spaced-rep')({ requireAuth }));

module.exports = function createSpacedRepRoutes({ requireAuth }) {
  const router = express.Router();

  // ── Spaced repetition: due reviews ────────────────────────────
  router.get('/api/spaced-repetition/due', requireAuth, async (req, res) => {
    try {
      // Step 1: Get due spaced repetition records (no JOIN — no FK relationship)
      const { data: dueRecords, error: srError } = await supabase
        .from('spaced_repetition')
        .select('*')
        .eq('user_id', req.userId)
        .eq('mastered', false)
        .not('next_review_at', 'is', null)
        .lte('next_review_at', new Date().toISOString())
        .order('next_review_at', { ascending: true });
      if (srError) {
        console.error('[spaced-rep/due] SR query error:', srError.message);
        return res.json({ due: [], total: 0 });
      }
      if (!dueRecords || dueRecords.length === 0) return res.json([]);

      // Step 2: Fetch question details for each due record
      const questionIds = dueRecords.map(r => r.question_id).filter(Boolean);
      const { data: questions, error: qError } = await supabase
        .from('questions')
        .select('id, question_text, context, model_answer, key_points, subject, source, year, type, max_score, alternative_answers, model_answer_alac, model_answer_conceptual, alternative_answer_1, alternative_answer_2, alternative_answer_3, alternative_answer_4, alternative_answer_5, alternative_alac_1, alternative_alac_2, alternative_alac_3, alternative_alac_4, alternative_alac_5')
        .in('id', questionIds);
      if (qError) console.error('[spaced-rep/due] Questions query error:', qError.message);
      const qMap = {};
      for (const q of (questions || [])) qMap[q.id] = q;

      // Step 3: Merge and return
      const items = dueRecords.map(row => {
        const q = qMap[row.question_id] || {};
        const daysOverdue = row.next_review_at
          ? Math.max(0, Math.floor((Date.now() - new Date(row.next_review_at)) / 86400000))
          : 0;
        return {
          srId: row.id, questionId: row.question_id, subject: row.subject,
          lastScore: row.last_score, lastAttemptedAt: row.last_attempted_at,
          nextReviewAt: row.next_review_at, reviewCount: row.review_count, daysOverdue,
          question: {
            id: q.id, q: q.question_text || '', context: q.context || null,
            modelAnswer: q.model_answer || '', keyPoints: q.key_points || [],
            subject: row.subject, source: q.source || '', year: q.year || '',
            type: q.type || 'essay', max: q.max_score || 10,
            _cachedAlternatives: q.alternative_answers || null,
            _cachedAlac: q.model_answer_alac || null,
            _cachedConceptual: q.model_answer_conceptual || null, isReal: true,
            alternativeAnswer1: q.alternative_answer_1 || null,
            alternativeAnswer2: q.alternative_answer_2 || null,
            alternativeAnswer3: q.alternative_answer_3 || null,
            alternativeAnswer4: q.alternative_answer_4 || null,
            alternativeAnswer5: q.alternative_answer_5 || null,
            alternativeAlac1: q.alternative_alac_1 || null,
            alternativeAlac2: q.alternative_alac_2 || null,
            alternativeAlac3: q.alternative_alac_3 || null,
            alternativeAlac4: q.alternative_alac_4 || null,
            alternativeAlac5: q.alternative_alac_5 || null,
          },
        };
      });
      res.json(items);
    } catch(e) {
      console.error('[spaced-rep/due]', e);
      res.json({ due: [], total: 0 });
    }
  });

  // ── Spaced repetition: stats ──────────────────────────────────
  router.get('/api/spaced-repetition/stats', requireAuth, async (req, res) => {
    try {
      const now      = new Date().toISOString();
      const weekLater = new Date(Date.now() + 7 * 86400000).toISOString();
      const { data, error } = await supabase
        .from('spaced_repetition')
        .select('mastered, next_review_at')
        .eq('user_id', req.userId);
      if (error) throw error;
      const rows = data || [];
      const total            = rows.length;
      const mastered         = rows.filter(r => r.mastered).length;
      const dueNow           = rows.filter(r => !r.mastered && r.next_review_at && r.next_review_at <= now).length;
      const upcomingThisWeek = rows.filter(r => !r.mastered && r.next_review_at && r.next_review_at > now && r.next_review_at <= weekLater).length;
      res.json({ total, mastered, dueNow, upcomingThisWeek });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
