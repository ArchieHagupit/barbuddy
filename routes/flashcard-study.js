// Flashcard student routes — Session 3a.
//
// User-facing endpoints for the spaced-repetition flashcard review flow.
// Separated from routes/flashcards.js (which is admin-only authoring) so
// the student and admin surfaces can evolve independently.
//
// All routes require session authentication. Every query is scoped by
// user_id = req.userId for per-user isolation.
//
// Endpoints:
//   GET  /api/flashcards/due/:subject            — due queue + new card intro
//   GET  /api/flashcards/topic/:subject/:nodeId  — all cards for one topic (free browse)
//   POST /api/flashcards/review                  — submit rating, update SM-2
//   GET  /api/flashcards/stats/:subject          — subject-scoped stats
//   GET  /api/flashcards/stats-all               — cross-subject aggregate
//
// Usage in server.js:
//   app.use(require('./routes/flashcard-study')({ requireAuth }));

'use strict';

const express = require('express');
const { supabase } = require('../config/supabase');
const sm2 = require('../lib/sm2');

const DAILY_NEW_CARD_LIMIT = 20;
const VALID_SUBJECTS = ['civil','criminal','political','labor','commercial','taxation','remedial','ethics'];

module.exports = function createFlashcardStudyRoutes({ requireAuth }) {
  const router = express.Router();

  // Helper: count how many cards the user has reviewed for the first time today.
  // A "new card intro" is detected via the flashcard_reviews row's review_count
  // going from 0 (no row) → 1, which we approximate by counting rows created
  // today where review_count = 1.
  async function countNewCardsToday(userId, subject) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const { data, error } = await supabase
      .from('flashcard_reviews')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('review_count', 1)
      .gte('last_reviewed_at', startOfDay.toISOString());
    if (error) return 0;
    return data?.length || 0;
  }

  // ── Route 1: Due cards + new card intro queue ────────────────
  router.get('/api/flashcards/due/:subject', requireAuth, async (req, res) => {
    try {
      const subject = req.params.subject;
      if (!VALID_SUBJECTS.includes(subject)) {
        return res.status(400).json({ error: 'Invalid subject' });
      }

      const nowIso = new Date().toISOString();

      // Step A: get due reviews (existing cards where next_review_at <= now AND not mastered)
      const { data: dueReviews, error: revErr } = await supabase
        .from('flashcard_reviews')
        .select('*')
        .eq('user_id', req.userId)
        .eq('mastered', false)
        .lte('next_review_at', nowIso)
        .order('next_review_at', { ascending: true })
        .limit(200);
      if (revErr) {
        console.error('[fc-study/due] review query:', revErr.message);
        return res.status(500).json({ error: 'Failed to load due reviews' });
      }

      const dueCardIds = (dueReviews || []).map(r => r.flashcard_id);
      let dueCards = [];
      if (dueCardIds.length) {
        const { data: cardRows, error: cErr } = await supabase
          .from('flashcards')
          .select('*')
          .in('id', dueCardIds)
          .eq('enabled', true)
          .eq('subject', subject);
        if (cErr) {
          console.error('[fc-study/due] cards query:', cErr.message);
          return res.status(500).json({ error: 'Failed to load due cards' });
        }
        // Preserve due-order by joining back against dueReviews
        const cardById = new Map((cardRows || []).map(c => [c.id, c]));
        dueCards = (dueReviews || [])
          .filter(r => cardById.has(r.flashcard_id))
          .map(r => {
            const c = cardById.get(r.flashcard_id);
            return {
              ...c,
              _reviewState: {
                reviewId: r.id,
                easeFactor: r.ease_factor,
                intervalDays: r.interval_days,
                reviewCount: r.review_count,
                nextReviewAt: r.next_review_at,
                lastRating: r.last_rating,
                mastered: r.mastered,
              },
            };
          });
      }

      // Step B: get new cards (enabled cards for this subject that have NO review row yet)
      // Compute remaining new-card budget for today
      const introducedToday = await countNewCardsToday(req.userId, subject);
      const newBudget = Math.max(0, DAILY_NEW_CARD_LIMIT - introducedToday);

      let newCards = [];
      if (newBudget > 0) {
        // Get all enabled card ids for subject
        const { data: allCards, error: aErr } = await supabase
          .from('flashcards')
          .select('*')
          .eq('subject', subject)
          .eq('enabled', true)
          .order('generated_at', { ascending: true })
          .limit(500);
        if (aErr) {
          console.error('[fc-study/due] all-cards query:', aErr.message);
          return res.status(500).json({ error: 'Failed to load cards' });
        }

        // Find which ones have NO review row for this user
        const allIds = (allCards || []).map(c => c.id);
        if (allIds.length) {
          const { data: existingReviews } = await supabase
            .from('flashcard_reviews')
            .select('flashcard_id')
            .eq('user_id', req.userId)
            .in('flashcard_id', allIds);
          const reviewedSet = new Set((existingReviews || []).map(r => r.flashcard_id));
          const unseen = (allCards || []).filter(c => !reviewedSet.has(c.id));
          newCards = unseen.slice(0, newBudget).map(c => ({ ...c, _reviewState: null }));
        }
      }

      res.json({
        subject,
        due: dueCards,
        newCards,
        stats: {
          dueCount: dueCards.length,
          newCardsAvailable: newCards.length,
          newCardsIntroducedToday: introducedToday,
          newCardsDailyLimit: DAILY_NEW_CARD_LIMIT,
        },
      });
    } catch(e) {
      console.error('[fc-study/due] fatal:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Route 2: Topic free-browse (no SM-2, just the cards) ─────
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

      // Attach each card's review state for this user (so the UI can show mastery)
      const cardIds = (cards || []).map(c => c.id);
      let reviewMap = new Map();
      if (cardIds.length) {
        const { data: reviews } = await supabase
          .from('flashcard_reviews')
          .select('*')
          .eq('user_id', req.userId)
          .in('flashcard_id', cardIds);
        for (const r of (reviews || [])) reviewMap.set(r.flashcard_id, r);
      }
      const out = (cards || []).map(c => {
        const r = reviewMap.get(c.id);
        return {
          ...c,
          _reviewState: r ? {
            reviewId: r.id,
            easeFactor: r.ease_factor,
            intervalDays: r.interval_days,
            reviewCount: r.review_count,
            nextReviewAt: r.next_review_at,
            lastRating: r.last_rating,
            mastered: r.mastered,
          } : null,
        };
      });
      res.json({ cards: out, count: out.length });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Route 3: Submit rating, update SM-2 state ────────────────
  // Body: { flashcardId, rating: 'again'|'hard'|'good'|'easy' }
  router.post('/api/flashcards/review', requireAuth, async (req, res) => {
    try {
      const { flashcardId, rating } = req.body || {};
      if (!flashcardId || typeof flashcardId !== 'string') {
        return res.status(400).json({ error: 'flashcardId required' });
      }
      if (!sm2.VALID_RATINGS.has(rating)) {
        return res.status(400).json({ error: `rating must be one of: ${[...sm2.VALID_RATINGS].join(', ')}` });
      }

      // Verify card exists and is enabled
      const { data: card, error: cardErr } = await supabase
        .from('flashcards')
        .select('id, subject, enabled')
        .eq('id', flashcardId)
        .maybeSingle();
      if (cardErr) return res.status(500).json({ error: cardErr.message });
      if (!card) return res.status(404).json({ error: 'Card not found' });
      if (!card.enabled) return res.status(400).json({ error: 'Card is not enabled' });

      // Fetch previous review state (if any)
      const { data: prevReview } = await supabase
        .from('flashcard_reviews')
        .select('*')
        .eq('user_id', req.userId)
        .eq('flashcard_id', flashcardId)
        .maybeSingle();

      const prevState = prevReview ? {
        easeFactor: Number(prevReview.ease_factor) || 2.5,
        intervalDays: Number(prevReview.interval_days) || 0,
        reviewCount: Number(prevReview.review_count) || 0,
      } : null;

      const newState = sm2.updateState(prevState, rating);
      const nowIso = new Date().toISOString();

      const rowData = {
        user_id: req.userId,
        flashcard_id: flashcardId,
        last_rating: rating,
        last_reviewed_at: nowIso,
        next_review_at: newState.nextReviewAt,
        review_count: newState.reviewCount,
        ease_factor: newState.easeFactor,
        interval_days: newState.intervalDays,
        mastered: newState.mastered,
      };

      let savedReview;
      if (prevReview) {
        const { data, error } = await supabase
          .from('flashcard_reviews')
          .update(rowData)
          .eq('id', prevReview.id)
          .select()
          .single();
        if (error) return res.status(500).json({ error: error.message });
        savedReview = data;
      } else {
        const insertRow = {
          id: 'fcr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          ...rowData,
        };
        const { data, error } = await supabase
          .from('flashcard_reviews')
          .insert(insertRow)
          .select()
          .single();
        if (error) return res.status(500).json({ error: error.message });
        savedReview = data;
      }

      res.json({
        ok: true,
        review: {
          reviewId: savedReview.id,
          flashcardId,
          rating,
          ...newState,
        },
      });
    } catch(e) {
      console.error('[fc-study/review] fatal:', e);
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

      // Total enabled cards in subject
      const { data: allCards, error: cErr } = await supabase
        .from('flashcards')
        .select('id')
        .eq('subject', subject)
        .eq('enabled', true);
      if (cErr) return res.status(500).json({ error: cErr.message });
      const totalCards = (allCards || []).length;
      const cardIds = (allCards || []).map(c => c.id);

      // Review state for this user over those cards
      let reviewed = 0, mastered = 0, dueNow = 0, upcomingThisWeek = 0;
      if (cardIds.length) {
        const nowIso = new Date().toISOString();
        const weekLater = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data: reviews } = await supabase
          .from('flashcard_reviews')
          .select('mastered, next_review_at, review_count')
          .eq('user_id', req.userId)
          .in('flashcard_id', cardIds);
        reviewed = (reviews || []).length;
        mastered = (reviews || []).filter(r => r.mastered).length;
        dueNow = (reviews || []).filter(r => !r.mastered && r.next_review_at && r.next_review_at <= nowIso).length;
        upcomingThisWeek = (reviews || []).filter(r =>
          !r.mastered && r.next_review_at && r.next_review_at > nowIso && r.next_review_at <= weekLater
        ).length;
      }
      const newAvailable = totalCards - reviewed;

      res.json({
        subject,
        totalCards,
        reviewed,
        mastered,
        dueNow,
        upcomingThisWeek,
        newAvailable,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 5: Cross-subject aggregate ─────────────────────────
  router.get('/api/flashcards/stats-all', requireAuth, async (req, res) => {
    try {
      const nowIso = new Date().toISOString();

      // One combined query: all enabled cards + this user's review rows for them
      const { data: allCards, error: cErr } = await supabase
        .from('flashcards')
        .select('id, subject')
        .eq('enabled', true);
      if (cErr) return res.status(500).json({ error: cErr.message });

      const bySubject = {};
      for (const subj of VALID_SUBJECTS) {
        bySubject[subj] = { totalCards: 0, dueNow: 0, newAvailable: 0, mastered: 0 };
      }
      const cardSubjectMap = new Map();
      for (const c of (allCards || [])) {
        cardSubjectMap.set(c.id, c.subject);
        if (bySubject[c.subject]) bySubject[c.subject].totalCards++;
      }

      const cardIds = (allCards || []).map(c => c.id);
      let totalDue = 0, totalMastered = 0;
      if (cardIds.length) {
        const { data: reviews } = await supabase
          .from('flashcard_reviews')
          .select('flashcard_id, mastered, next_review_at')
          .eq('user_id', req.userId)
          .in('flashcard_id', cardIds);
        const reviewedSet = new Set();
        for (const r of (reviews || [])) {
          reviewedSet.add(r.flashcard_id);
          const subj = cardSubjectMap.get(r.flashcard_id);
          if (!subj || !bySubject[subj]) continue;
          if (r.mastered) {
            bySubject[subj].mastered++;
            totalMastered++;
          } else if (r.next_review_at && r.next_review_at <= nowIso) {
            bySubject[subj].dueNow++;
            totalDue++;
          }
        }
        // newAvailable = totalCards - (reviewed cards for this user in this subject)
        for (const subj of VALID_SUBJECTS) {
          let reviewedInSubj = 0;
          for (const r of (reviews || [])) {
            if (cardSubjectMap.get(r.flashcard_id) === subj) reviewedInSubj++;
          }
          bySubject[subj].newAvailable = Math.max(0, bySubject[subj].totalCards - reviewedInSubj);
        }
      } else {
        for (const subj of VALID_SUBJECTS) bySubject[subj].newAvailable = bySubject[subj].totalCards;
      }

      res.json({
        totalDue,
        totalMastered,
        bySubject,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
