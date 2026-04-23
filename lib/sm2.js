// SM-2 spaced repetition algorithm — Anki-style variant with 4 ratings.
//
// Pure function: takes previous state + rating, returns new state.
// No DB, no I/O, no side effects. Fully unit-testable.
//
// Used by routes/flashcard-study.js to update per-user per-card review
// records in the flashcard_reviews table.
//
// Ratings:
//   'again' — forgot; show again same session
//   'hard'  — recalled with difficulty
//   'good'  — recalled correctly (default)
//   'easy'  — recalled easily; extend interval
//
// State shape:
//   { easeFactor, intervalDays, reviewCount, nextReviewAt: ISOString, mastered }
//
// Mastery criterion (used purely to filter out well-learned cards from
// the due queue so students don't see them constantly):
//   intervalDays >= 60  AND  reviewCount >= 5  AND  last rating in ['good','easy']

'use strict';

const EASE_MIN = 1.3;
const EASE_MAX = 3.0;
const MASTERY_INTERVAL_DAYS = 60;
const MASTERY_MIN_REVIEWS = 5;
const VALID_RATINGS = new Set(['again', 'hard', 'good', 'easy']);

function clampEase(ef) {
  if (ef < EASE_MIN) return EASE_MIN;
  if (ef > EASE_MAX) return EASE_MAX;
  return ef;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  return d;
}

/**
 * Compute new review state.
 *
 * @param {object|null} prev  Previous state or null for first review.
 *   { easeFactor: number, intervalDays: number, reviewCount: number }
 * @param {string} rating  'again' | 'hard' | 'good' | 'easy'
 * @param {object} opts
 * @param {Date}   opts.now  Current time (injectable for tests).
 * @returns {object} { easeFactor, intervalDays, reviewCount, nextReviewAt, mastered }
 */
function updateState(prev, rating, { now = new Date() } = {}) {
  if (!VALID_RATINGS.has(rating)) {
    throw new Error(`Invalid rating "${rating}" — must be one of: again, hard, good, easy`);
  }

  let easeFactor, intervalDays, reviewCount;

  if (!prev) {
    // First-ever review of this card
    switch (rating) {
      case 'again': easeFactor = 2.5;  intervalDays = 0; break;
      case 'hard':  easeFactor = 2.35; intervalDays = 1; break;
      case 'good':  easeFactor = 2.5;  intervalDays = 1; break;
      case 'easy':  easeFactor = 2.65; intervalDays = 4; break;
    }
    reviewCount = 1;
  } else {
    const prevEase = Number(prev.easeFactor) || 2.5;
    const prevInterval = Number(prev.intervalDays) || 1;
    const prevCount = Number(prev.reviewCount) || 0;

    switch (rating) {
      case 'again':
        easeFactor = clampEase(prevEase - 0.20);
        intervalDays = 0;
        break;
      case 'hard':
        easeFactor = clampEase(prevEase - 0.15);
        intervalDays = Math.max(1, Math.round(prevInterval * 1.2));
        break;
      case 'good':
        easeFactor = clampEase(prevEase);
        intervalDays = Math.max(1, Math.round(prevInterval * prevEase));
        break;
      case 'easy':
        easeFactor = clampEase(prevEase + 0.15);
        intervalDays = Math.max(1, Math.round(prevInterval * prevEase * 1.3));
        break;
    }
    reviewCount = prevCount + 1;
  }

  easeFactor = clampEase(easeFactor);

  const nextReviewAt = addDays(now, intervalDays).toISOString();

  const mastered =
    intervalDays >= MASTERY_INTERVAL_DAYS &&
    reviewCount >= MASTERY_MIN_REVIEWS &&
    (rating === 'good' || rating === 'easy');

  return {
    easeFactor: Number(easeFactor.toFixed(3)),
    intervalDays,
    reviewCount,
    nextReviewAt,
    mastered,
  };
}

module.exports = {
  updateState,
  EASE_MIN,
  EASE_MAX,
  MASTERY_INTERVAL_DAYS,
  MASTERY_MIN_REVIEWS,
  VALID_RATINGS,
};
