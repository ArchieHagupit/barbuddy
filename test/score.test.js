// Tests for public/score.js — the canonical scoring rule.
//
// This module exists because the rule had been copied into five places and the
// copies drifted, scoring the same answer differently for the stored record
// and for spaced-repetition mastery. These assertions are what stops that
// happening again: every branch of the score order, the component cap, and the
// grade thresholds are pinned here.
//
// Run with: npm test
// No test dependency — node:test ships with Node.

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/score.js');

// Shorthands for building evaluations the way the model returns them.
const alac = (a, l, ap, c) => ({
  alac: {
    answer:      a  == null ? undefined : { score: a,  feedback: '' },
    legalBasis:  l  == null ? undefined : { score: l,  feedback: '' },
    application: ap == null ? undefined : { score: ap, feedback: '' },
    conclusion:  c  == null ? undefined : { score: c,  feedback: '' },
  },
});
const breakdown = (acc, comp, cl) => ({
  breakdown: {
    accuracy:     acc  == null ? undefined : { score: acc,  feedback: '' },
    completeness: comp == null ? undefined : { score: comp, feedback: '' },
    clarity:      cl   == null ? undefined : { score: cl,   feedback: '' },
  },
});

test('score order: ALAC components win over the model\'s own total', () => {
  const ev = { ...alac(1.5, 2, 3, 1), numericScore: 9, score: '9/10', grade: 'Excellent' };
  assert.equal(S.questionScore(ev), 7.5);
});

test('score order: conceptual breakdown wins over the model\'s own total', () => {
  // The bug this pins: the client used to skip breakdown entirely and take
  // numericScore, so an inflated total drove the badge and pass/fail.
  const ev = { ...breakdown(2.5, 2, 1.5), numericScore: 9, grade: 'Excellent' };
  assert.equal(S.questionScore(ev), 6);
});

test('score order: numericScore only when no rubric components exist', () => {
  assert.equal(S.questionScore({ numericScore: 7.5 }), 7.5);
});

test('rubric is chosen by the container, not by any one component', () => {
  // An ALAC evaluation missing its Answer component is still ALAC. The
  // spaced-repetition copy used to branch on alac.answer.score != null and
  // fall through to numericScore here, disagreeing with the stored record.
  const ev = { ...alac(null, 3, 4, 1.5), numericScore: 9 };
  assert.equal(S.rubricFor(ev), 'alac');
  assert.equal(S.questionScore(ev), 8.5);
});

test('components are capped at their rubric maximum', () => {
  // Application maxes at 4; a model that returns 5 must not push the question
  // past 10/10 or inflate the session total.
  const ev = alac(1.5, 3, 5, 1.5);
  assert.equal(S.questionScore(ev), 10);
  const row = S.componentRows(ev).find(r => r.key === 'application');
  assert.equal(row.score, 4);
  assert.equal(row.rawScore, 5);
  assert.equal(row.clamped, true);
});

test('negative components are floored at zero', () => {
  assert.equal(S.questionScore(alac(-2, 3, 4, 1.5)), 8.5);
});

test('numericScore is bounded to 0-10', () => {
  assert.equal(S.questionScore({ numericScore: 99 }), 10);
  assert.equal(S.questionScore({ numericScore: -5 }), 0);
});

test('errored evaluations contribute zero', () => {
  assert.equal(S.questionScore({ _evalError: true, numericScore: 8 }), 0);
  assert.equal(S.questionScore({ grade: 'Error', ...alac(1.5, 3, 4, 1.5) }), 0);
});

test('componentRows returns only the rubric components, in rubric order', () => {
  const rows = S.componentRows(alac(1.5, 2, 3, 1));
  assert.deepEqual(rows.map(r => r.key), ['answer', 'legalBasis', 'application', 'conclusion']);
  assert.deepEqual(rows.map(r => r.max), [1.5, 3, 4, 1.5]);
});

test('componentRows ignores non-rubric keys the model sometimes adds', () => {
  const ev = { breakdown: {
    accuracy: { score: 4 }, completeness: { score: 3 }, clarity: { score: 3 },
    definition: { score: 2 },            // not part of the rubric
    overallFeedback: 'a string, not a component',
  } };
  assert.deepEqual(S.componentRows(ev).map(r => r.key), ['accuracy', 'completeness', 'clarity']);
  assert.equal(S.questionScore(ev), 10);
});

test('the rows always add up to the printed total', () => {
  for (const ev of [alac(1.5, 2, 3, 1), alac(1.5, 3, 5, 1.5), breakdown(2.5, 2, 1.5)]) {
    const sum = S.componentRows(ev).reduce((a, r) => a + (r.score || 0), 0);
    assert.equal(Math.round(sum * 10) / 10, S.questionScore(ev));
  }
});

test('totalScore sums questions and skips errored ones', () => {
  const scores = [alac(1.5, 2, 3, 1), breakdown(2.5, 2, 1.5), { _evalError: true, numericScore: 9 }];
  assert.equal(S.totalScore(scores), 13.5);
  assert.equal(S.totalScore([]), 0);
  assert.equal(S.totalScore(null), 0);
});

test('grade thresholds match GRADE_SCALE in lib/eval-helpers.js', () => {
  assert.equal(S.gradeForScore(10),  'Excellent');
  assert.equal(S.gradeForScore(8.5), 'Excellent');
  assert.equal(S.gradeForScore(8.4), 'Good');
  assert.equal(S.gradeForScore(7.0), 'Good');
  assert.equal(S.gradeForScore(6.9), 'Satisfactory');
  assert.equal(S.gradeForScore(5.5), 'Satisfactory');
  assert.equal(S.gradeForScore(5.4), 'Needs Improvement');
  assert.equal(S.gradeForScore(4.0), 'Needs Improvement');
  assert.equal(S.gradeForScore(3.9), 'Poor');
  assert.equal(S.gradeForScore(0),   'Poor');
});

test('grade comes from the recomputed score, not the model\'s grade string', () => {
  const ev = { ...breakdown(2.5, 2, 1.5), numericScore: 9, grade: 'Excellent' };
  assert.equal(S.gradeFor(ev), 'Satisfactory'); // 6/10
});

test('Not Answered and Error survive as states', () => {
  assert.equal(S.gradeFor({ grade: 'Not Answered' }), 'Not Answered');
  assert.equal(S.gradeFor({ grade: 'Error' }), 'Error');
  assert.equal(S.gradeFor({ _evalError: true }), 'Error');
});

test('half-point component scores do not accumulate float error', () => {
  // 1.5 + 2.5 + 3.5 + 1.5 in floating point is 8.999999999999998 unrounded.
  assert.equal(S.questionScore(alac(1.5, 2.5, 3.5, 1.5)), 9);
});

test('handles junk input without throwing', () => {
  for (const junk of [null, undefined, {}, { alac: null }, { alac: {} }, { breakdown: {} },
                      { alac: { answer: 'not an object' } }, { numericScore: 'x' }]) {
    assert.equal(typeof S.questionScore(junk), 'number');
    assert.ok(Array.isArray(S.componentRows(junk)));
  }
});

test('an empty rubric container falls through to numericScore', () => {
  // alac:{} carries no components, so there is nothing to sum.
  assert.equal(S.questionScore({ alac: {}, numericScore: 6 }), 6);
});
