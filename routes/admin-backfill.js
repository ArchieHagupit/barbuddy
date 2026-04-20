// Admin cache-backfill routes — extracted from server.js, behavior unchanged.
//
// Three pairs of status-poll + trigger routes for pre-generating cached
// AI-generated content:
//   - ALAC + alternatives (original model-answer decomposition)
//   - Conceptual model answers (simplified rubric for non-situational Qs)
//   - Alternative-answer ALACs (decomposition for each multi-answer variant)
//
// All three state objects (backfillState, conceptualBackfillState,
// altAlacBackfillState) are module-scoped here — they're exclusively
// read/written by these 6 routes, so no reason to expose them outside.
//
// The three AI helpers (extractAlternativeAnswers, generateALACModelAnswer,
// generateConceptualModelAnswer) stay in server.js as hoisted function
// declarations and come in via factory. Same pattern as generateMockBar,
// awardXP, summarizeLargeDoc, etc. in prior extractions.

const express = require('express');
const { supabase } = require('../config/supabase');

// Usage in server.js:
//   app.use(require('./routes/admin-backfill')({
//     adminOnly,
//     extractAlternativeAnswers,
//     generateALACModelAnswer,
//     generateConceptualModelAnswer,
//   }));

module.exports = function createAdminBackfillRoutes({
  adminOnly,
  extractAlternativeAnswers,
  generateALACModelAnswer,
  generateConceptualModelAnswer,
}) {
  const router = express.Router();

  // ── Admin: Pre-generate ALAC + alternatives cache for all questions ────────────
  // Processes questions missing either cache column, sequentially with a 1s delay.
  // Client polls GET /api/admin/backfill-alac-cache/status for live progress.
  const backfillState = { running: false, done: 0, total: 0, errors: 0, complete: false };

  router.get('/api/admin/backfill-alac-cache/status', adminOnly, (_req, res) => {
    res.json({ ...backfillState });
  });

  router.post('/api/admin/backfill-alac-cache', adminOnly, async (_req, res) => {
    if (backfillState.running) return res.json({ started: false, message: 'Backfill already in progress' });

    // Fetch all questions missing at least one cache column
    const { data, error } = await supabase
      .from('questions')
      .select('id, question_text, context, model_answer, subject, alternative_answers, model_answer_alac, alternative_answer_1, alternative_answer_2, alternative_answer_3, alternative_answer_4, alternative_answer_5, alternative_alac_1, alternative_alac_2, alternative_alac_3, alternative_alac_4, alternative_alac_5')
      .or('alternative_answer_1.is.null,model_answer_alac.is.null');
    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.json({ started: false, message: 'All questions already cached' });

    Object.assign(backfillState, { running: true, done: 0, total: data.length, errors: 0, complete: false });
    res.json({ started: true, total: data.length });

    // Process sequentially in background — do NOT await
    (async () => {
      for (const q of data) {
        try {
          const cacheUpdate = {};

          // Alternatives — write to both JSONB and individual columns
          if (!q.alternative_answer_1) {
            const parsedAlts = extractAlternativeAnswers(q.model_answer);
            cacheUpdate.alternative_answers = parsedAlts;
            parsedAlts.forEach((alt, i) => { if (i < 5) cacheUpdate[`alternative_answer_${i + 1}`] = alt; });
          }

          // ALAC — only for questions without existing alternatives (single-answer questions)
          const alts = q.alternative_answers || cacheUpdate.alternative_answers || [];
          const hasManyAlts = Array.isArray(alts) && alts.length > 1;
          if (!q.model_answer_alac && !hasManyAlts && q.model_answer) {
            const alacResult = await generateALACModelAnswer(q.question_text, q.context, q.model_answer, q.subject);
            if (alacResult) cacheUpdate.model_answer_alac = alacResult.components;
          }

          if (Object.keys(cacheUpdate).length > 0) {
            const { error: ue } = await supabase.from('questions').update(cacheUpdate).eq('id', q.id);
            if (ue) { console.warn(`[backfill] update failed for ${q.id}:`, ue.message); backfillState.errors++; }
          }
        } catch (e) {
          console.warn(`[backfill] error on ${q.id}:`, e.message);
          backfillState.errors++;
        }
        backfillState.done++;
        await new Promise(r => setTimeout(r, 1000)); // 1s delay between questions
      }
      backfillState.running  = false;
      backfillState.complete = true;
      console.log(`[backfill] complete — ${backfillState.done} processed, ${backfillState.errors} errors`);
    })();
  });

  // ── Admin: Pre-generate conceptual model answer cache ─────────────────────────
  const conceptualBackfillState = { running: false, done: 0, total: 0, errors: 0, complete: false };

  router.get('/api/admin/backfill-conceptual-cache/status', adminOnly, (_req, res) => {
    res.json({ ...conceptualBackfillState });
  });

  router.post('/api/admin/backfill-conceptual-cache', adminOnly, async (_req, res) => {
    if (conceptualBackfillState.running) return res.json({ started: false, message: 'Conceptual backfill already in progress' });

    const { data, error } = await supabase
      .from('questions')
      .select('id, question_text, model_answer, type')
      .is('model_answer_conceptual', null)
      .not('model_answer', 'is', null);
    if (error) return res.status(500).json({ error: error.message });

    // Filter to conceptual questions only (non-situational)
    const conceptualQs = (data || []).filter(q => {
      const t = (q.type || '').toLowerCase();
      return t !== 'situational' && t !== 'essay' && t !== 'alac';
    });
    if (conceptualQs.length === 0) return res.json({ started: false, message: 'All conceptual questions already cached' });

    Object.assign(conceptualBackfillState, { running: true, done: 0, total: conceptualQs.length, errors: 0, complete: false });
    res.json({ started: true, total: conceptualQs.length });

    (async () => {
      for (const q of conceptualQs) {
        try {
          const result = await generateConceptualModelAnswer(q.question_text, q.model_answer);
          if (result) {
            const { error: ue } = await supabase.from('questions').update({ model_answer_conceptual: result }).eq('id', q.id);
            if (ue) { console.warn(`[conceptual-backfill] update failed for ${q.id}:`, ue.message); conceptualBackfillState.errors++; }
          }
        } catch (e) {
          console.warn(`[conceptual-backfill] error on ${q.id}:`, e.message);
          conceptualBackfillState.errors++;
        }
        conceptualBackfillState.done++;
        await new Promise(r => setTimeout(r, 1500)); // 1.5s delay between questions
      }
      conceptualBackfillState.running  = false;
      conceptualBackfillState.complete = true;
      console.log(`[conceptual-backfill] complete — ${conceptualBackfillState.done} processed, ${conceptualBackfillState.errors} errors`);
    })();
  });

  // ── Admin: Pre-generate alternative ALAC cache ──────────────────────────────
  const altAlacBackfillState = { running: false, done: 0, total: 0, errors: 0, complete: false };

  router.get('/api/admin/backfill-alternative-alac/status', adminOnly, (_req, res) => {
    res.json({ ...altAlacBackfillState });
  });

  router.post('/api/admin/backfill-alternative-alac', adminOnly, async (_req, res) => {
    if (altAlacBackfillState.running) return res.json({ started: false, message: 'Backfill already in progress' });

    // Fetch questions where any alternative_answer_N exists but its ALAC is null
    const { data, error } = await supabase
      .from('questions')
      .select('id, question_text, context, subject, alternative_answer_1, alternative_alac_1, alternative_answer_2, alternative_alac_2, alternative_answer_3, alternative_alac_3, alternative_answer_4, alternative_alac_4, alternative_answer_5, alternative_alac_5')
      .or([
        'and(alternative_answer_1.not.is.null,alternative_alac_1.is.null)',
        'and(alternative_answer_2.not.is.null,alternative_alac_2.is.null)',
        'and(alternative_answer_3.not.is.null,alternative_alac_3.is.null)',
        'and(alternative_answer_4.not.is.null,alternative_alac_4.is.null)',
        'and(alternative_answer_5.not.is.null,alternative_alac_5.is.null)',
      ].join(','));
    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.json({ started: false, message: 'All alternative ALACs already cached' });

    // Count total pairs needing generation
    let totalPairs = 0;
    for (const q of data) {
      for (let i = 1; i <= 5; i++) {
        const altText = q[`alternative_answer_${i}`];
        if (altText && altText.trim().length >= 20 && !q[`alternative_alac_${i}`]) totalPairs++;
      }
    }
    if (totalPairs === 0) return res.json({ started: false, message: 'All alternative ALACs already cached' });

    Object.assign(altAlacBackfillState, { running: true, done: 0, total: totalPairs, errors: 0, complete: false });
    res.json({ started: true, total: totalPairs });

    (async () => {
      for (const q of data) {
        const cacheUpdate = {};
        for (let i = 1; i <= 5; i++) {
          const altText = q[`alternative_answer_${i}`];
          if (!altText || altText.trim().length < 20 || q[`alternative_alac_${i}`]) continue;
          try {
            console.log(`[alt-alac-backfill] Generating ALAC for Q ${q.id} Alt ${i}... (${altAlacBackfillState.done + 1}/${totalPairs})`);
            const alacResult = await generateALACModelAnswer(q.question_text, q.context || '', altText, q.subject);
            if (alacResult) {
              cacheUpdate[`alternative_alac_${i}`] = alacResult.components || alacResult;
            } else {
              console.warn(`[alt-alac-backfill] Alt ${i} generation returned null for Q ${q.id}`);
              altAlacBackfillState.errors++;
            }
          } catch (e) {
            console.warn(`[alt-alac-backfill] Alt ${i} error on Q ${q.id}:`, e.message);
            altAlacBackfillState.errors++;
          }
          altAlacBackfillState.done++;
          await new Promise(r => setTimeout(r, 1500));
        }
        if (Object.keys(cacheUpdate).length > 0) {
          const { error: ue } = await supabase.from('questions').update(cacheUpdate).eq('id', q.id);
          if (ue) { console.warn(`[alt-alac-backfill] DB write failed for ${q.id}:`, ue.message); altAlacBackfillState.errors++; }
        }
      }
      altAlacBackfillState.running  = false;
      altAlacBackfillState.complete = true;
      console.log(`[alt-alac-backfill] complete — ${altAlacBackfillState.done}/${totalPairs} pairs processed, ${altAlacBackfillState.errors} errors`);
    })();
  });

  return router;
};
