// Admin: retry failed evaluations.
//
// Scans the results table for entries whose `evaluations` array contains
// items flagged `_evalError: true` (or grade === 'Error'). For each such
// result, re-runs the failed evaluations through the EvalQueue using the
// original eval inputs persisted on `result.answers.items`, then writes
// the new scores + recomputed total + pass/fail back to the result row.
//
// Routes mounted here:
//   POST   /api/admin/retry-failed-evaluations          → kick off scan + retry
//   GET    /api/admin/retry-failed-evaluations/status   → poll progress
//   GET    /api/admin/failed-evaluations/preview        → count + sample (no writes)
//
// Pre-existing failures from BEFORE this PR have `answers: {}` and cannot
// be retried — the student's original answer wasn't persisted. The scan
// reports those separately as `noDataForRetry` so an admin can decide
// whether to clear them manually (or accept the loss).

const express = require('express');
const { supabase } = require('../config/supabase');

// Detect whether a single evaluation entry is a system failure (vs. a
// real 0/10 from a non-answer). Matches the runEvalJob error returns:
//   {_evalError:true, grade:'Error', overallFeedback:'Evaluation temporarily unavailable.'}
//   {_evalError:true, grade:'Error', overallFeedback:'Evaluation failed — please retry.'}
function isFailedEval(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (ev._evalError === true) return true;
  if (ev.grade === 'Error') return true;
  return false;
}

// Recompute the result-level total score from the canonical components
// (ALAC sum, breakdown sum, or numericScore as final fallback). Mirrors
// the logic in routes/evaluate.js post-eval handler. Failed evaluations
// contribute 0 here — same convention as the original write path.
function computeTotalFromScores(scores) {
  return scores.reduce((sum, s) => {
    if (!s || s._evalError || s.grade === 'Error') return sum;
    if (s.alac) {
      return sum + (s.alac.answer?.score || 0) + (s.alac.legalBasis?.score || 0)
                 + (s.alac.application?.score || 0) + (s.alac.conclusion?.score || 0);
    }
    if (s.breakdown) {
      return sum + (s.breakdown.accuracy?.score || 0) + (s.breakdown.completeness?.score || 0)
                 + (s.breakdown.clarity?.score || 0);
    }
    return sum + (s.numericScore || 0);
  }, 0);
}

module.exports = function createAdminRetryEvalsRoutes({ adminOnly, enqueueEval }) {
  const router = express.Router();

  // Module-scoped progress state — single concurrent run at a time.
  const retryState = {
    running: false,
    complete: false,
    scannedResults: 0,
    totalResults: 0,
    retriedQuestions: 0,
    succeeded: 0,
    stillFailing: 0,
    noDataForRetry: 0,
    updatedResults: 0,
    errors: [],
    startedAt: null,
    finishedAt: null,
  };

  // ── Preview: how many results have failed evaluations? ─────────────
  // Read-only. Returns count + the first few candidates so an admin can
  // sanity-check the scope before running a destructive update.
  router.get('/api/admin/failed-evaluations/preview', adminOnly, async (req, res) => {
    const daysBack = Math.max(1, Math.min(365, parseInt(req.query.daysBack) || 90));
    const sinceISO = new Date(Date.now() - daysBack * 86400000).toISOString();
    try {
      const { data, error } = await supabase
        .from('results')
        .select('id, user_id, subject, finished_at, evaluations, answers')
        .gte('finished_at', sinceISO)
        .order('finished_at', { ascending: false })
        .limit(1000);
      if (error) return res.status(500).json({ error: error.message });

      const candidates = [];
      let withData = 0;
      let withoutData = 0;
      for (const r of (data || [])) {
        if (!Array.isArray(r.evaluations)) continue;
        const failedIdxs = r.evaluations.map((e, i) => isFailedEval(e) ? i : -1).filter(i => i >= 0);
        if (!failedIdxs.length) continue;
        const hasItems = Array.isArray(r.answers?.items) && r.answers.items.length > 0;
        if (hasItems) withData++; else withoutData++;
        if (candidates.length < 25) {
          candidates.push({
            id: r.id, userId: r.user_id, subject: r.subject,
            finishedAt: r.finished_at, failedCount: failedIdxs.length,
            failedIdxs, hasRetryData: hasItems,
          });
        }
      }
      res.json({
        daysBack, scanned: data?.length || 0,
        resultsWithFailures: withData + withoutData,
        retryable: withData, notRetryable: withoutData,
        sample: candidates,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Status poll for in-progress retry ──────────────────────────────
  router.get('/api/admin/retry-failed-evaluations/status', adminOnly, (_req, res) => {
    res.json({ ...retryState, errors: retryState.errors.slice(-20) });
  });

  // ── Kick off retry of failed evaluations ───────────────────────────
  // Body: { daysBack?: number=90, resultId?: string, dryRun?: bool=false }
  router.post('/api/admin/retry-failed-evaluations', adminOnly, async (req, res) => {
    if (retryState.running) {
      return res.json({ started: false, message: 'Retry job already in progress' });
    }
    const daysBack = Math.max(1, Math.min(365, parseInt(req.body?.daysBack) || 90));
    const onlyResultId = (req.body?.resultId || '').trim() || null;
    const dryRun = req.body?.dryRun === true;
    const sinceISO = new Date(Date.now() - daysBack * 86400000).toISOString();

    // Reset state for this run
    Object.assign(retryState, {
      running: true, complete: false,
      scannedResults: 0, totalResults: 0,
      retriedQuestions: 0, succeeded: 0, stillFailing: 0, noDataForRetry: 0,
      updatedResults: 0, errors: [],
      startedAt: new Date().toISOString(), finishedAt: null,
    });

    // Fetch candidate results (filtered by time window, optionally pinned to one ID)
    let query = supabase
      .from('results')
      .select('id, user_id, subject, finished_at, evaluations, answers, total_questions')
      .gte('finished_at', sinceISO)
      .order('finished_at', { ascending: false })
      .limit(5000);
    if (onlyResultId) query = supabase.from('results').select('id, user_id, subject, finished_at, evaluations, answers, total_questions').eq('id', onlyResultId);
    const { data: candidates, error: qErr } = await query;
    if (qErr) {
      retryState.running = false;
      retryState.complete = true;
      retryState.finishedAt = new Date().toISOString();
      retryState.errors.push(`query failed: ${qErr.message}`);
      return res.status(500).json({ error: qErr.message });
    }

    // Filter to results that actually have failed evaluations
    const targets = (candidates || []).filter(r => {
      if (!Array.isArray(r.evaluations)) return false;
      return r.evaluations.some(isFailedEval);
    });
    retryState.totalResults = targets.length;

    res.json({ started: true, totalResults: targets.length, daysBack, dryRun });

    // Process sequentially in background — concurrency is already handled
    // by the EvalQueue, so we don't need to parallelize here. Spacing out
    // result-level work also keeps the queue from being monopolised by
    // this admin job during peak hours.
    (async () => {
      for (const r of targets) {
        retryState.scannedResults++;
        try {
          const items = Array.isArray(r.answers?.items) ? r.answers.items : null;
          if (!items) {
            // Pre-existing result from before answers were persisted — can't retry.
            const failedCount = r.evaluations.filter(isFailedEval).length;
            retryState.noDataForRetry += failedCount;
            continue;
          }

          const failedIdxs = r.evaluations
            .map((e, i) => isFailedEval(e) ? i : -1)
            .filter(i => i >= 0 && i < items.length);

          if (!failedIdxs.length) continue;

          if (dryRun) {
            retryState.retriedQuestions += failedIdxs.length;
            continue;
          }

          // Re-run only the failed indexes via the existing EvalQueue.
          // submissionId here is admin-job-scoped — it's never polled by a client.
          const submissionId = `admin_retry_${r.id}_${Date.now()}`;
          const userId = r.user_id;

          const newScores = await Promise.all(failedIdxs.map(idx =>
            enqueueEval(submissionId, userId, items[idx], idx).catch(e => {
              retryState.errors.push(`Q${idx} of result ${r.id}: ${e.message}`);
              return { _evalError: true, grade: 'Error', overallFeedback: 'Retry threw: ' + e.message, numericScore: 0, score: '0/10', keyMissed: [] };
            })
          ));

          // Build the updated evaluations array — splice retry results back into the original slots
          const updatedEvals = r.evaluations.slice();
          for (let k = 0; k < failedIdxs.length; k++) {
            const idx = failedIdxs[k];
            const ns = newScores[k];
            updatedEvals[idx] = ns;
            retryState.retriedQuestions++;
            if (ns && !isFailedEval(ns)) retryState.succeeded++; else retryState.stillFailing++;
          }

          // Recompute total + pass/fail using the same logic as evaluate-batch.
          const totalQuestions = r.total_questions || updatedEvals.length;
          const computedTotal = computeTotalFromScores(updatedEvals);
          const passed = totalQuestions > 0 && computedTotal / (totalQuestions * 10) >= 0.7;

          const { error: uErr } = await supabase.from('results').update({
            evaluations: updatedEvals,
            score: parseFloat(computedTotal.toFixed(2)),
            passed,
            last_updated_at: new Date().toISOString(),
          }).eq('id', r.id);
          if (uErr) {
            retryState.errors.push(`update ${r.id}: ${uErr.message}`);
          } else {
            retryState.updatedResults++;
          }
        } catch (e) {
          retryState.errors.push(`result ${r.id}: ${e.message}`);
        }
        // Small pacing delay so this admin job doesn't starve live student evals.
        await new Promise(rs => setTimeout(rs, 250));
      }
      retryState.running = false;
      retryState.complete = true;
      retryState.finishedAt = new Date().toISOString();
      console.log(`[retry-evals] complete — scanned:${retryState.scannedResults} retried:${retryState.retriedQuestions} ok:${retryState.succeeded} stillFailing:${retryState.stillFailing} noData:${retryState.noDataForRetry} updated:${retryState.updatedResults} errors:${retryState.errors.length}`);
    })();
  });

  return router;
};
