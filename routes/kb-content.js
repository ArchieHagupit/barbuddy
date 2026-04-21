// KB + content routes — extracted from server.js, behavior unchanged.
//
// Five cohesive routes covering KB state readout, content cache lookup,
// SSE generation progress stream, and thin AI-passthrough content gen.
//
// State patterns:
//   - CONTENT: read-only closure (getCONTENT). The 3 content read-routes
//     only read it; reassignment lives in admin-kb router's setter and at
//     boot. Same pattern as RESET_REQUESTS cross-router sharing.
//   - GEN: pass-by-reference. The SSE route calls GEN.clients.add(res) /
//     GEN.clients.delete(res); broadcast() in server.js iterates the SAME
//     Set. Because GEN is passed by reference, the Set identity is
//     preserved across modules.
//   - KB: pass-by-reference (same as elsewhere).
//
// sseSend is factory-injected rather than imported because it stays in
// server.js (broadcast() uses it there). We don't want two copies of
// the same 1-line helper.

const express = require('express');
const { supabase } = require('../config/supabase');

// Usage in server.js:
//   app.use(require('./routes/kb-content')({
//     KB, GEN, VALID_SUBJECTS, API_KEY,
//     getCONTENT: () => CONTENT,
//     sseSend, callClaude,
//   }));

module.exports = function createKbContentRoutes({
  KB, GEN, VALID_SUBJECTS, API_KEY,
  getCONTENT, sseSend, callClaude,
}) {
  const router = express.Router();

  // ── KB state summary (counts, past bar list, syllabus flag) ──
  router.get('/api/kb', async (_req, res) => {
    const CONTENT = getCONTENT();
    const n = Object.values(CONTENT).reduce((a,s) => a+Object.keys(s).length, 0);
    const pastBarSummary = KB.pastBar.map(p => ({
      id: p.id, name: p.name, subject: p.subject,
      year: p.year || 'Unknown',
      qCount: p.questions?.length || p.qCount || 0,
      source: p.source || 'upload',
      uploadedAt: p.uploadedAt,
      enabled: p.enabled !== false,
    }));
    const totalQuestions = pastBarSummary.reduce((a,p) => a + p.qCount, 0);

    // Also get total count from normalized questions table
    let totalQuestionsDB = null;
    let subjectQuestionCounts = {};
    try {
      const { count } = await supabase
        .from('questions').select('*', { count: 'exact', head: true });
      totalQuestionsDB = count;
      // Per-subject counts
      for (const subj of VALID_SUBJECTS) {
        const { count: sc } = await supabase
          .from('questions').select('*', { count: 'exact', head: true }).eq('subject', subj);
        if (sc) subjectQuestionCounts[subj] = sc;
      }
    } catch(_) { /* non-fatal — table may not exist yet */ }

    res.json({
      hasSyllabus:    !!(KB.syllabus?.subjects),
      syllabusTopics: [],  // legacy field (new format uses /api/syllabus/:subject)
      references:     KB.references.map(r => ({ id:r.id, name:r.name, subject:r.subject, type:r.type, size:r.size, uploadedAt:r.uploadedAt })),
      pastBar:        pastBarSummary,
      totalQuestions,
      totalQuestionsDB,
      subjectQuestionCounts,
      contentTopics:  n,
      genState:       { running:GEN.running, done:GEN.done, total:GEN.total, current:GEN.current, finishedAt:GEN.finishedAt },
      customRefs:     KB.references.filter(r => r.subject === 'custom').length,
      customPastBar:  KB.pastBar.filter(p => p.subject === 'custom').length,
      customQuestions:KB.pastBar.filter(p => p.subject === 'custom').reduce((a,p) => a + (p.questions?.length||p.qCount||0), 0),
    });
  });

  // ── GET pre-generated content for one topic ─────────────────
  router.get('/api/content/:subject/:topic', (req, res) => {
    const CONTENT = getCONTENT();
    const data = CONTENT[req.params.subject]?.[decodeURIComponent(req.params.topic)];
    if (data) return res.json({ found:true, ...data });
    res.json({ found:false });
  });

  // ── GET full content dump (browser caches on load) ──────────
  router.get('/api/content', (req, res) => {
    const CONTENT = getCONTENT();
    const { subject } = req.query;
    if (subject && VALID_SUBJECTS.includes(subject) && CONTENT[subject]) {
      return res.json({ [subject]: CONTENT[subject] });
    }
    res.json(CONTENT);
  });

  // ── SSE: live generation progress ──────────────────────────
  router.get('/api/gen/progress', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    GEN.clients.add(res);
    sseSend(res, { done:GEN.done, total:GEN.total, current:GEN.current, running:GEN.running, finished:!!GEN.finishedAt&&!GEN.running });

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch(e) {} }, 30000);

    // Max 5 minutes — prevents Railway connection pool exhaustion
    const maxDuration = setTimeout(() => {
      GEN.clients.delete(res);
      clearInterval(heartbeat);
      try { res.end(); } catch(e) {}
    }, 300000);

    req.on('close', () => {
      GEN.clients.delete(res);
      clearInterval(heartbeat);
      clearTimeout(maxDuration);
    });
  });

  // ── Thin AI passthrough (on-demand content generation) ──────
  router.post('/api/generate-content', async (req, res) => {
    if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });
    const { messages, max_tokens = 4096 } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
    try {
      const text = await callClaude(messages, max_tokens);
      res.json({ content: text });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
