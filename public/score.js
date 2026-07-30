// ══════════════════════════════════════════════════════════════
// CANONICAL SCORING — one rule, both sides of the wire
// ══════════════════════════════════════════════════════════════
// Every score a student sees or that lands in the database comes from here:
// the question badge and total on the results screen, the saved and emailed
// HTML, the `results.score` and `passed` columns, the HIGH_SCORE_BONUS count,
// and spaced-repetition mastery.
//
// This lives in public/ so the browser can load it with a plain <script> tag
// while the server require()s the same file. That is the point — the rule was
// previously copied into four places (routes/evaluate.js twice, lib/eval-queue.js,
// routes/admin-retry-evals.js) plus the client, and the copies had already
// drifted: the spaced-repetition copy branched on `alac.answer.score != null`
// while the total-score copy branched on `alac` being truthy, so an evaluation
// missing its Answer component was scored one way for the record and another
// way for mastery. Copies drift; a single file cannot.
//
// Rubric (CLAUDE.md): ALAC = Answer 1.5 + LegalBasis 3 + Application 4 +
// Conclusion 1.5 = 10. Conceptual = Accuracy 4 + Completeness 3 + Clarity 3 = 10.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BBScore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ALAC_COMPONENTS = [
    { key: 'answer',      label: 'A — Answer',      max: 1.5 },
    { key: 'legalBasis',  label: 'L — Legal Basis', max: 3.0 },
    { key: 'application', label: 'A — Application', max: 4.0 },
    { key: 'conclusion',  label: 'C — Conclusion',  max: 1.5 },
  ];
  var CONCEPTUAL_COMPONENTS = [
    { key: 'accuracy',     label: 'Accuracy',     max: 4 },
    { key: 'completeness', label: 'Completeness', max: 3 },
    { key: 'clarity',      label: 'Clarity',      max: 3 },
  ];

  function isErrored(ev) {
    return !ev || ev._evalError === true || ev.grade === 'Error';
  }

  // Which rubric an evaluation is scored against. Presence of the container
  // decides — not the presence of any one component inside it — so a partial
  // response is scored against the rubric it was graded on rather than
  // silently falling through to the model's self-reported total.
  function rubricFor(ev) {
    if (!ev) return null;
    if (ev.alac && typeof ev.alac === 'object') return 'alac';
    if (ev.breakdown && typeof ev.breakdown === 'object' &&
        (ev.breakdown.accuracy || ev.breakdown.completeness || ev.breakdown.clarity)) return 'conceptual';
    return null;
  }

  // The scored rows for one evaluation, with each component bounded to its
  // rubric maximum. Nothing downstream clamps, so an over-range component the
  // model occasionally returns (application: 5 against a max of 4) would
  // otherwise push a question past 10/10 and inflate the session total.
  // Returns [] when the evaluation carries no rubric components.
  function componentRows(ev) {
    var rubric = rubricFor(ev);
    if (!rubric) return [];
    var defs = rubric === 'alac' ? ALAC_COMPONENTS : CONCEPTUAL_COMPONENTS;
    var src = rubric === 'alac' ? ev.alac : ev.breakdown;
    var rows = [];
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      var c = src[d.key];
      if (!c || typeof c !== 'object') continue;
      var raw = typeof c.score === 'number' && isFinite(c.score) ? c.score : null;
      rows.push({
        key: d.key,
        label: d.label,
        max: d.max,
        score: raw === null ? null : Math.max(0, Math.min(raw, d.max)),
        rawScore: raw,
        clamped: raw !== null && (raw > d.max || raw < 0),
        feedback: c.feedback || '',
      });
    }
    return rows;
  }

  // The authoritative score for one question, 0–10.
  // Order: rubric components → the model's numericScore only when no rubric
  // components exist at all. Errored evaluations contribute 0.
  function questionScore(ev) {
    if (isErrored(ev)) return 0;
    var rows = componentRows(ev);
    if (rows.length) {
      var sum = 0;
      for (var i = 0; i < rows.length; i++) sum += rows[i].score || 0;
      return round1(sum);
    }
    var n = typeof ev.numericScore === 'number' && isFinite(ev.numericScore) ? ev.numericScore : 0;
    return round1(Math.max(0, Math.min(n, 10)));
  }

  function totalScore(scores) {
    if (!scores || !scores.length) return 0;
    var sum = 0;
    for (var i = 0; i < scores.length; i++) sum += questionScore(scores[i]);
    return round1(sum);
  }

  // Same thresholds as GRADE_SCALE in lib/eval-helpers.js, applied to the
  // recomputed score rather than the model's self-reported numericScore — the
  // two disagree whenever the components do not add up to what the model
  // claimed, and the components are what we display.
  function gradeForScore(n) {
    return n >= 8.5 ? 'Excellent'
         : n >= 7.0 ? 'Good'
         : n >= 5.5 ? 'Satisfactory'
         : n >= 4.0 ? 'Needs Improvement'
         : 'Poor';
  }

  // Grade to show for an evaluation. "Not Answered" is a state, not a band, so
  // it survives; everything else is derived from the recomputed score.
  function gradeFor(ev) {
    if (!ev) return '';
    if (isErrored(ev)) return 'Error';
    if (ev.grade === 'Not Answered') return 'Not Answered';
    return gradeForScore(questionScore(ev));
  }

  // Trailing .0 is noise on a scorecard: 7.5 stays 7.5, 6.0 shows as 6.
  function round1(n) {
    return Math.round((n + Number.EPSILON) * 10) / 10;
  }

  return {
    ALAC_COMPONENTS: ALAC_COMPONENTS,
    CONCEPTUAL_COMPONENTS: CONCEPTUAL_COMPONENTS,
    rubricFor: rubricFor,
    componentRows: componentRows,
    questionScore: questionScore,
    totalScore: totalScore,
    gradeForScore: gradeForScore,
    gradeFor: gradeFor,
    isErrored: isErrored,
  };
});
