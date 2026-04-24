// Flashcard student routes — Session 4: completion tracking.
//
// Replaces the SM-2 spaced repetition model with a simple
// per-user per-card "done" boolean. Progress is the ratio of
// done cards to total enabled cards for a subject.
//
// All routes require session authentication. Every query is
// scoped by user_id = req.userId for per-user isolation.
//
// Endpoints:
//   GET  /api/flashcards/bundle                  — comprehensive app-boot bundle
//   GET  /api/flashcards/topic/:subject/:nodeId  — all cards for one topic (incl. done flag)
//   POST /api/flashcards/mark-done               — toggle done flag for a card
//   GET  /api/flashcards/stats/:subject          — subject-scoped stats (done/total)
//   GET  /api/flashcards/stats-all               — cross-subject aggregate for dashboard
//   GET  /api/flashcards/topic-counts/:subject   — nodeId → count (unchanged from Session 3c)
//
// Usage in server.js:
//   app.use(require('./routes/flashcard-study')({ requireAuth }));

'use strict';

const express = require('express');
const { supabase } = require('../config/supabase');

const VALID_SUBJECTS = ['civil','criminal','political','labor','commercial','taxation','remedial','ethics'];

// Paginated select helper — Supabase defaults to a 1000-row cap per
// request unless .range() is used. For queries that can legitimately
// return more rows (e.g., all enabled cards across 8 subjects), this
// wrapper fetches in chunks of 1000 until the result set is exhausted.
async function fetchAllPaginated(queryBuilder, { pageSize = 1000, maxPages = 50 } = {}) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await queryBuilder.range(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break; // short page = end of results
  }
  return all;
}

module.exports = function createFlashcardStudyRoutes({ requireAuth }) {
  const router = express.Router();

  // ── Route 1: App-boot bundle ────────────────────────────────
  // Returns everything the student UI needs for instant rendering of
  // Flashcards tabs, topic trees, Overview widget, and sidebar badge:
  //   - topicCountsBySubject: { subj: { nodeId: count } }
  //   - totalBySubject:        { subj: number }
  //   - doneCardIds:           string[] — cards THIS user has marked done
  //   - doneCountBySubject:    { subj: number }
  // Called once on login; cached client-side. Invalidated after mark-done.
  router.get('/api/flashcards/bundle', requireAuth, async (req, res) => {
    try {
      // Load ALL enabled cards across all bar subjects.
      // Uses paginated fetch because cross-subject totals can exceed
      // Supabase's default 1000-row cap (this was the root cause of
      // Session 4's "missing cards" bug).
      let allCards = [];
      try {
        allCards = await fetchAllPaginated(
          supabase
            .from('flashcards')
            .select('id, subject, node_id')
            .eq('enabled', true)
            .in('subject', VALID_SUBJECTS)
        );
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }

      // Build counts
      const topicCountsBySubject = {};
      const totalBySubject = {};
      const cardSubjMap = {};
      for (const subj of VALID_SUBJECTS) {
        topicCountsBySubject[subj] = {};
        totalBySubject[subj] = 0;
      }
      for (const c of (allCards || [])) {
        if (!topicCountsBySubject[c.subject]) continue;
        topicCountsBySubject[c.subject][c.node_id] =
          (topicCountsBySubject[c.subject][c.node_id] || 0) + 1;
        totalBySubject[c.subject]++;
        cardSubjMap[c.id] = c.subject;
      }

      // Fetch user's done rows
      let doneCardIds = [];
      const doneCountBySubject = {};
      for (const subj of VALID_SUBJECTS) doneCountBySubject[subj] = 0;

      let doneRows = [];
      try {
        doneRows = await fetchAllPaginated(
          supabase
            .from('flashcard_reviews')
            .select('flashcard_id')
            .eq('user_id', req.userId)
            .eq('done', true)
        );
      } catch(e) {
        console.error('[fc-bundle] done-rows query:', e.message);
        // Non-fatal — proceed with empty done set
      }
      for (const r of doneRows) {
        doneCardIds.push(r.flashcard_id);
        const subj = cardSubjMap[r.flashcard_id];
        if (subj && doneCountBySubject[subj] != null) {
          doneCountBySubject[subj]++;
        }
      }

      res.json({
        topicCountsBySubject,
        totalBySubject,
        doneCardIds,
        doneCountBySubject,
      });
    } catch(e) {
      console.error('[fc-bundle] fatal:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Route 2: Topic cards ─────────────────────────────────────
  // Returns all enabled cards for one topic, with per-card `done` flag.
  router.get('/api/flashcards/topic/:subject/:nodeId', requireAuth, async (req, res) => {
    try {
      const { subject, nodeId } = req.params;
      if (!VALID_SUBJECTS.includes(subject)) {
        return res.status(400).json({ error: 'Invalid subject' });
      }
      const { data: cards, error } = await supabase
        .from('flashcards')
        .select('*')
        .eq('subject', subject)
        .eq('node_id', nodeId)
        .eq('enabled', true)
        .order('generated_at', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });

      const cardIds = (cards || []).map(c => c.id);
      let doneSet = new Set();
      if (cardIds.length) {
        const { data: reviews } = await supabase
          .from('flashcard_reviews')
          .select('flashcard_id, done')
          .eq('user_id', req.userId)
          .in('flashcard_id', cardIds);
        for (const r of (reviews || [])) {
          if (r.done) doneSet.add(r.flashcard_id);
        }
      }
      const out = (cards || []).map(c => ({ ...c, done: doneSet.has(c.id) }));
      res.json({ cards: out, count: out.length });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Route 3: Mark as done / unmark ───────────────────────────
  // Body: { flashcardId, done: boolean }
  // Upserts a row in flashcard_reviews. If no row exists, creates one.
  router.post('/api/flashcards/mark-done', requireAuth, async (req, res) => {
    try {
      const { flashcardId, done } = req.body || {};
      if (!flashcardId || typeof flashcardId !== 'string') {
        return res.status(400).json({ error: 'flashcardId required' });
      }
      if (typeof done !== 'boolean') {
        return res.status(400).json({ error: 'done must be a boolean' });
      }

      // Verify card exists + enabled
      const { data: card, error: cardErr } = await supabase
        .from('flashcards')
        .select('id, enabled')
        .eq('id', flashcardId)
        .maybeSingle();
      if (cardErr) return res.status(500).json({ error: cardErr.message });
      if (!card) return res.status(404).json({ error: 'Card not found' });
      if (!card.enabled) return res.status(400).json({ error: 'Card is not enabled' });

      // Upsert: look up existing row, UPDATE if present, INSERT otherwise
      const { data: existing } = await supabase
        .from('flashcard_reviews')
        .select('id')
        .eq('user_id', req.userId)
        .eq('flashcard_id', flashcardId)
        .maybeSingle();

      const nowIso = new Date().toISOString();

      if (existing) {
        const { error: upErr } = await supabase
          .from('flashcard_reviews')
          .update({ done, last_reviewed_at: nowIso })
          .eq('id', existing.id);
        if (upErr) return res.status(500).json({ error: upErr.message });
      } else {
        const insertRow = {
          id: 'fcr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          user_id: req.userId,
          flashcard_id: flashcardId,
          done,
          last_reviewed_at: nowIso,
          review_count: 1,
          // SM-2 columns left at their DB defaults (ignored by new UI but
          // preserved so we don't break anything reading the table).
        };
        const { error: insErr } = await supabase
          .from('flashcard_reviews')
          .insert(insertRow);
        if (insErr) return res.status(500).json({ error: insErr.message });
      }

      res.json({ ok: true, flashcardId, done });
    } catch(e) {
      console.error('[fc-mark-done] fatal:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Route 4: Subject stats ───────────────────────────────────
  router.get('/api/flashcards/stats/:subject', requireAuth, async (req, res) => {
    try {
      const subject = req.params.subject;
      if (!VALID_SUBJECTS.includes(subject)) {
        return res.status(400).json({ error: 'Invalid subject' });
      }
      const { data: allCards, error: cErr } = await supabase
        .from('flashcards')
        .select('id')
        .eq('subject', subject)
        .eq('enabled', true);
      if (cErr) return res.status(500).json({ error: cErr.message });
      const totalCards = (allCards || []).length;
      const cardIds = (allCards || []).map(c => c.id);

      let doneCount = 0;
      if (cardIds.length) {
        const { data: doneRows } = await supabase
          .from('flashcard_reviews')
          .select('flashcard_id', { count: 'exact', head: false })
          .eq('user_id', req.userId)
          .eq('done', true)
          .in('flashcard_id', cardIds);
        doneCount = (doneRows || []).length;
      }
      const remaining = Math.max(0, totalCards - doneCount);
      const pct = totalCards > 0 ? Math.round((doneCount / totalCards) * 100) : 0;

      res.json({
        subject,
        totalCards,
        doneCount,
        remaining,
        completionPct: pct,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 5: Cross-subject aggregate ─────────────────────────
  router.get('/api/flashcards/stats-all', requireAuth, async (req, res) => {
    try {
      let allCards = [];
      try {
        allCards = await fetchAllPaginated(
          supabase
            .from('flashcards')
            .select('id, subject')
            .eq('enabled', true)
        );
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }

      const bySubject = {};
      const cardSubjMap = {};
      for (const subj of VALID_SUBJECTS) {
        bySubject[subj] = { totalCards: 0, doneCount: 0, remaining: 0, completionPct: 0 };
      }
      for (const c of (allCards || [])) {
        cardSubjMap[c.id] = c.subject;
        if (bySubject[c.subject]) bySubject[c.subject].totalCards++;
      }

      const cardIds = (allCards || []).map(c => c.id);
      let totalDone = 0, totalCards = 0;
      for (const subj of VALID_SUBJECTS) totalCards += bySubject[subj].totalCards;

      if (cardIds.length) {
        let doneRows = [];
        try {
          // Supabase caps `.in()` array length around 1000 — chunk the cardIds
          for (let i = 0; i < cardIds.length; i += 500) {
            const chunk = cardIds.slice(i, i + 500);
            const partial = await fetchAllPaginated(
              supabase
                .from('flashcard_reviews')
                .select('flashcard_id')
                .eq('user_id', req.userId)
                .eq('done', true)
                .in('flashcard_id', chunk)
            );
            doneRows.push(...partial);
          }
        } catch(_) { /* non-fatal */ }
        for (const r of doneRows) {
          const subj = cardSubjMap[r.flashcard_id];
          if (subj && bySubject[subj]) {
            bySubject[subj].doneCount++;
            totalDone++;
          }
        }
      }
      for (const subj of VALID_SUBJECTS) {
        const t = bySubject[subj].totalCards;
        bySubject[subj].remaining = Math.max(0, t - bySubject[subj].doneCount);
        bySubject[subj].completionPct = t > 0
          ? Math.round((bySubject[subj].doneCount / t) * 100)
          : 0;
      }

      res.json({
        totalCards,
        totalDone,
        totalRemaining: Math.max(0, totalCards - totalDone),
        overallPct: totalCards > 0 ? Math.round((totalDone / totalCards) * 100) : 0,
        bySubject,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 6: Per-topic counts (unchanged from Session 3c) ────
  router.get('/api/flashcards/topic-counts/:subject', requireAuth, async (req, res) => {
    try {
      const subject = req.params.subject;
      if (!VALID_SUBJECTS.includes(subject)) {
        return res.status(400).json({ error: 'Invalid subject' });
      }
      const { data, error } = await supabase
        .from('flashcards')
        .select('node_id')
        .eq('subject', subject)
        .eq('enabled', true);
      if (error) return res.status(500).json({ error: error.message });
      const counts = {};
      for (const row of (data || [])) {
        counts[row.node_id] = (counts[row.node_id] || 0) + 1;
      }
      res.json({ subject, counts });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
