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
//   GET  /api/flashcards/subject/:subject        — ALL cards for one subject in ONE request
//   GET  /api/flashcards/topic/:subject/:nodeId  — all cards for one topic (incl. done flag)
//   POST /api/flashcards/mark-done               — toggle done flag for a card
//   POST /api/flashcards/highlights              — replace a card's highlights
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

// Only the columns the study viewer actually renders. Selecting these
// instead of '*' keeps subject-wide payloads (1000+ cards) small enough
// to parse instantly on mobile.
const CARD_FIELDS = 'id, subject, node_id, node_path, card_type, front, back, source_snippet';

// Look up which of `cardIds` this user has marked done. Chunked because
// Supabase caps `.in()` array length around 1000.
async function fetchDoneSet(userId, cardIds) {
  const doneSet = new Set();
  for (let i = 0; i < cardIds.length; i += 500) {
    const chunk = cardIds.slice(i, i + 500);
    const { data, error } = await supabase
      .from('flashcard_reviews')
      .select('flashcard_id')
      .eq('user_id', userId)
      .eq('done', true)
      .in('flashcard_id', chunk);
    if (error) throw error;
    for (const r of (data || [])) doneSet.add(r.flashcard_id);
  }
  return doneSet;
}

// Tri-state: null = not yet probed, true/false = known. Set to false the
// first time Postgres reports the column missing, so a deploy that lands
// before scripts/add-flashcard-highlights-column.sql is run degrades to
// "no highlights" instead of failing every session fetch.
//
// The "missing" verdict expires. Without that it was a one-way latch: any
// request served between the deploy and the migration would pin the flag for
// the life of the process, so running the SQL appeared to do nothing until
// someone redeployed — and on more than one instance, until all of them did.
// Re-probing costs one failed query every few minutes at worst.
const HIGHLIGHTS_RECHECK_MS = 5 * 60 * 1000;
let _highlightsColumn = null;
let _highlightsMissingAt = 0;

function _highlightsMaybeAvailable() {
  if (_highlightsColumn === false && Date.now() - _highlightsMissingAt > HIGHLIGHTS_RECHECK_MS) {
    _highlightsColumn = null; // due for another look
  }
  return _highlightsColumn !== false;
}

function _markHighlightsMissing() {
  if (_highlightsColumn !== false) {
    console.warn('[fc-highlights] column missing — run scripts/add-flashcard-highlights-column.sql');
  }
  _highlightsColumn = false;
  _highlightsMissingAt = Date.now();
}

// done + highlights for `cardIds` in one pass. Used by the two session
// endpoints only — deliberately NOT by the boot bundle, which covers every
// card the student owns and has no reason to carry highlight payloads.
async function fetchReviewState(userId, cardIds) {
  const doneSet = new Set();
  const highlightsByCard = {};
  const wantHighlights = _highlightsMaybeAvailable();
  const cols = wantHighlights ? 'flashcard_id, done, highlights' : 'flashcard_id, done';

  for (let i = 0; i < cardIds.length; i += 500) {
    const chunk = cardIds.slice(i, i + 500);
    const { data, error } = await supabase
      .from('flashcard_reviews')
      .select(cols)
      .eq('user_id', userId)
      .in('flashcard_id', chunk);

    if (error) {
      // 42703 = undefined_column. Remember it and retry this chunk bare.
      if (wantHighlights && (error.code === '42703' || /highlights/i.test(error.message || ''))) {
        _markHighlightsMissing();
        return fetchReviewState(userId, cardIds);
      }
      throw error;
    }

    if (wantHighlights) _highlightsColumn = true;
    for (const r of (data || [])) {
      if (r.done) doneSet.add(r.flashcard_id);
      if (Array.isArray(r.highlights) && r.highlights.length) {
        highlightsByCard[r.flashcard_id] = r.highlights;
      }
    }
  }
  return { doneSet, highlightsByCard };
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
  //   - doneCountByDate:       { 'YYYY-MM-DD' (Manila): number } — study activity
  //                            behind the Overview streak and daily pace
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
      const cardNodeMap = {};
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
        cardNodeMap[c.id] = c.node_id;
      }

      // Fetch user's done rows
      let doneCardIds = [];
      const doneCountBySubject = {};
      // Per-topic done tallies drive the green completion state in the
      // Flashcards "Browse by Topic" tree (parents roll up client-side).
      const doneTopicCountsBySubject = {};
      for (const subj of VALID_SUBJECTS) {
        doneCountBySubject[subj] = 0;
        doneTopicCountsBySubject[subj] = {};
      }

      // Manila calendar day → how many done cards were last touched that day.
      // Drives the Overview streak and "cards done today". It is an
      // approximation on purpose: last_reviewed_at holds the LAST touch, so a
      // card marked on Monday and re-toggled on Friday only counts for Friday.
      // A day still registers as long as one of its cards was not re-touched
      // later, which is the normal case — a student does not usually revisit
      // every card from a past session.
      const doneCountByDate = {};

      let doneRows = [];
      try {
        doneRows = await fetchAllPaginated(
          supabase
            .from('flashcard_reviews')
            .select('flashcard_id, last_reviewed_at')
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
          const nodeId = cardNodeMap[r.flashcard_id];
          if (nodeId) {
            doneTopicCountsBySubject[subj][nodeId] =
              (doneTopicCountsBySubject[subj][nodeId] || 0) + 1;
          }
        }
        if (r.last_reviewed_at) {
          // en-CA gives YYYY-MM-DD; the timeZone option does the UTC→Manila
          // shift so a 1am Manila session lands on the right calendar day.
          const day = new Date(r.last_reviewed_at)
            .toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
          doneCountByDate[day] = (doneCountByDate[day] || 0) + 1;
        }
      }

      res.json({
        topicCountsBySubject,
        totalBySubject,
        doneCardIds,
        doneCountBySubject,
        doneTopicCountsBySubject,
        doneCountByDate,
      });
    } catch(e) {
      console.error('[fc-bundle] fatal:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Route 1b: Subject-wide cards (one request) ───────────────
  // Every enabled card for a subject, in syllabus order, with each
  // card's `done` flag. Replaces the old client-side pattern of firing
  // one /topic request per topic (40+ round trips for a big subject)
  // when the student hits "Start Study Session".
  router.get('/api/flashcards/subject/:subject', requireAuth, async (req, res) => {
    try {
      const { subject } = req.params;
      if (!VALID_SUBJECTS.includes(subject)) {
        return res.status(400).json({ error: 'Invalid subject' });
      }

      const cards = await fetchAllPaginated(
        supabase
          .from('flashcards')
          .select(CARD_FIELDS)
          .eq('subject', subject)
          .eq('enabled', true)
          .order('node_id', { ascending: true })
          .order('generated_at', { ascending: true })
      );

      const cardIds = cards.map(c => c.id);
      let doneSet = new Set();
      let highlightsByCard = {};
      if (cardIds.length) {
        try {
          ({ doneSet, highlightsByCard } = await fetchReviewState(req.userId, cardIds));
        } catch(e) {
          console.error('[fc-subject] review-state lookup:', e.message);
          // Non-fatal — cards still render, just without done marks or highlights.
        }
      }

      const out = cards.map(c => ({
        ...c,
        done: doneSet.has(c.id),
        highlights: highlightsByCard[c.id] || [],
      }));
      res.json({ subject, cards: out, count: out.length });
    } catch(e) {
      console.error('[fc-subject] fatal:', e);
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
        .select(CARD_FIELDS)
        .eq('subject', subject)
        .eq('node_id', nodeId)
        .eq('enabled', true)
        .order('generated_at', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });

      const cardIds = (cards || []).map(c => c.id);
      let doneSet = new Set();
      let highlightsByCard = {};
      if (cardIds.length) {
        try {
          ({ doneSet, highlightsByCard } = await fetchReviewState(req.userId, cardIds));
        } catch(e) {
          console.error('[fc-topic] review-state lookup:', e.message);
        }
      }
      const out = (cards || []).map(c => ({
        ...c,
        done: doneSet.has(c.id),
        highlights: highlightsByCard[c.id] || [],
      }));
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

      // Card validity check and existing-review lookup are independent —
      // run them concurrently so the round trip the client waits on is one
      // query deep instead of two.
      const [cardRes, existingRes] = await Promise.all([
        supabase
          .from('flashcards')
          .select('id, enabled')
          .eq('id', flashcardId)
          .maybeSingle(),
        supabase
          .from('flashcard_reviews')
          .select('id')
          .eq('user_id', req.userId)
          .eq('flashcard_id', flashcardId)
          .maybeSingle(),
      ]);

      const { data: card, error: cardErr } = cardRes;
      if (cardErr) return res.status(500).json({ error: cardErr.message });
      if (!card) return res.status(404).json({ error: 'Card not found' });
      if (!card.enabled) return res.status(400).json({ error: 'Card is not enabled' });

      const existing = existingRes.data;

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

  // ── Route 3b: Save highlights for a card ─────────────────────
  // Body: { flashcardId, highlights: [{face,start,end}] }
  //
  // The client always sends the complete set for the card, so removing a
  // highlight is just a save with it absent — there is no delete route and
  // no partial-update ordering to get wrong.
  router.post('/api/flashcards/highlights', requireAuth, async (req, res) => {
    try {
      if (!_highlightsMaybeAvailable()) {
        return res.status(503).json({ error: 'highlights_unavailable' });
      }
      const { flashcardId, highlights } = req.body || {};
      if (!flashcardId || typeof flashcardId !== 'string') {
        return res.status(400).json({ error: 'flashcardId required' });
      }
      if (!Array.isArray(highlights)) {
        return res.status(400).json({ error: 'highlights must be an array' });
      }
      // Normalise before storing: this is the only gate between a client and
      // a JSONB column, so drop anything malformed rather than persisting it.
      // Capped at 200 ranges per card — far above real use, low enough that a
      // runaway client cannot bloat the row.
      const PENS = ['yellow', 'green', 'blue', 'pink'];
      const clean = [];
      for (const hRaw of highlights.slice(0, 200)) {
        if (!hRaw || typeof hRaw !== 'object') continue;
        const face = hRaw.face === 'front' ? 'front' : hRaw.face === 'back' ? 'back' : null;
        const start = Number(hRaw.start);
        const end = Number(hRaw.end);
        if (!face) continue;
        if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
        if (start < 0 || end <= start) continue;
        // Unknown or absent colour falls back to yellow rather than being
        // rejected, so rows written before pens existed keep working.
        const color = PENS.includes(hRaw.color) ? hRaw.color : 'yellow';
        clean.push({ face, start, end, color });
      }

      const { data: card, error: cardErr } = await supabase
        .from('flashcards')
        .select('id')
        .eq('id', flashcardId)
        .maybeSingle();
      if (cardErr) return res.status(500).json({ error: cardErr.message });
      if (!card) return res.status(404).json({ error: 'Card not found' });

      const { data: existing, error: exErr } = await supabase
        .from('flashcard_reviews')
        .select('id')
        .eq('user_id', req.userId)
        .eq('flashcard_id', flashcardId)
        .maybeSingle();
      if (exErr) return res.status(500).json({ error: exErr.message });

      const nowIso = new Date().toISOString();
      let writeErr;
      if (existing) {
        ({ error: writeErr } = await supabase
          .from('flashcard_reviews')
          .update({ highlights: clean, updated_at: nowIso })
          .eq('id', existing.id));
      } else {
        // Highlighting a card the student has not marked done yet is normal,
        // so this creates the row with done:false rather than requiring one.
        ({ error: writeErr } = await supabase
          .from('flashcard_reviews')
          .insert({
            id: 'fcr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            user_id: req.userId,
            flashcard_id: flashcardId,
            done: false,
            highlights: clean,
            review_count: 0,
          }));
      }
      if (writeErr) {
        if (writeErr.code === '42703' || /highlights/i.test(writeErr.message || '')) {
          _markHighlightsMissing();
          return res.status(503).json({ error: 'highlights_unavailable' });
        }
        return res.status(500).json({ error: writeErr.message });
      }

      res.json({ ok: true, flashcardId, highlights: clean });
    } catch(e) {
      console.error('[fc-highlights] fatal:', e);
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
