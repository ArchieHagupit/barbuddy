// Eval status/stats routes — extracted from server.js, behavior unchanged.
//
// Covers: eval progress polling, SSE queue-status streaming, completed
// results fetch, and admin queue health metrics.
//
// This file is commit 3 of 4 in the eval subsystem extraction. The big
// POST routes (/api/evaluate and /api/evaluate-batch) will move here in
// commit 4, producing one unified eval router.
//
// All state (evalProgress, evalResults, xpResults, EvalQueue) comes in
// via factory from the eval-queue destructure in server.js — these Maps
// and the EvalQueue object are shared between this router and the two
// main eval routes that still live in server.js. Same object references,
// so the data is coherent.

const express = require('express');

// Usage in server.js:
//   app.use(require('./routes/evaluate')({
//     requireAuth, adminOnly,
//     evalProgress, evalResults, xpResults, EvalQueue,
//   }));

module.exports = function createEvaluateRoutes({
  requireAuth, adminOnly,
  evalProgress, evalResults, xpResults, EvalQueue,
}) {
  const router = express.Router();

  // ── EVAL PROGRESS polling (enhanced with queue info) ──────────
  router.get('/api/eval-progress/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const progress = evalProgress.get(id) || { total: 0, done: 0, complete: false };
    const thisQueued  = EvalQueue.queue.filter(j => j.submissionId === id).length;
    const otherQueued = EvalQueue.queue.length - thisQueued;
    const estimatedWaitSec = thisQueued > 0
      ? Math.ceil((thisQueued * EvalQueue.avgEvalTimeMs) / (EvalQueue.maxConcurrent * 1000))
      : 0;
    res.json({
      ...progress,
      queuePosition:    Math.max(0, otherQueued),
      estimatedWaitSec,
      semaphoreActive:  EvalQueue.activeCount,
    });
  });

  // ── EVAL QUEUE STATUS — SSE for real-time queue position ───────
  router.get('/api/eval-queue-status/:submissionId', requireAuth, (req, res) => {
    const { submissionId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    function sendUpdate() {
      const prog = evalProgress.get(submissionId);
      if (!prog) {
        res.write(`data: ${JSON.stringify({ error: 'submission not found' })}\n\n`);
        return true; // done — close stream
      }
      const thisQueued  = EvalQueue.queue.filter(j => j.submissionId === submissionId).length;
      const otherQueued = EvalQueue.queue.length - thisQueued;
      const estimatedSecondsRemaining = thisQueued > 0
        ? Math.ceil((thisQueued * EvalQueue.avgEvalTimeMs) / (EvalQueue.maxConcurrent * 1000))
        : 0;
      res.write(`data: ${JSON.stringify({
        position: otherQueued,
        done: prog.done,
        total: prog.total,
        estimatedSecondsRemaining,
        semaphoreActive: EvalQueue.activeCount,
        complete: prog.complete,
      })}\n\n`);
      return prog.complete;
    }

    if (sendUpdate()) { res.end(); return; }
    const interval = setInterval(() => {
      if (sendUpdate()) { clearInterval(interval); res.end(); }
    }, 2000);
    req.on('close', () => clearInterval(interval));
  });

  // ── FETCH COMPLETED RESULTS — called by client once polling sees complete:true ─
  router.get('/api/eval-results/:submissionId', requireAuth, (req, res) => {
    const { submissionId } = req.params;
    const prog = evalProgress.get(submissionId);
    if (!prog) return res.status(404).json({ error: 'Submission not found or expired' });
    // Guard against the brief window where complete=true but evalResults isn't stored yet
    if (!prog.complete || !evalResults.has(submissionId)) {
      return res.status(202).json({ complete: false, waiting: true, done: prog.done, total: prog.total });
    }
    res.json({ complete: true, scores: evalResults.get(submissionId), xpData: xpResults.get(submissionId) || null });
  });

  // ── Admin: Evaluation queue health ──────────────────────────
  router.get('/api/admin/queue-stats', adminOnly, (_req, res) => {
    const globalQueueDepth  = EvalQueue.queue.length;
    const activeSubmissions = new Set(EvalQueue.queue.map(j => j.submissionId)).size;
    const avgMs = EvalQueue.avgEvalTimeMs;
    const estimatedClearTimeSec = globalQueueDepth > 0
      ? Math.ceil((globalQueueDepth * avgMs) / (EvalQueue.maxConcurrent * 1000))
      : 0;
    res.json({
      semaphoreMax:          EvalQueue.maxConcurrent,
      semaphoreActive:       EvalQueue.activeCount,
      globalQueueDepth,
      activeSubmissions,
      estimatedClearTimeSec,
      avgEvalTimeMs:         Math.round(avgMs),
      totalProcessed:        EvalQueue.totalProcessed,
      perUserActive:         Object.fromEntries(EvalQueue.perUserActive),
    });
  });

  return router;
};
