// Eval routes — unified router covering all 6 eval endpoints.
//
// Small routes (progress polling, SSE queue-status, results fetch, queue-stats)
// extracted in commit 3. Main routes (/api/evaluate single-question,
// /api/evaluate-batch async batch) added here in commit 4.
//
// Main routes use:
//   - callClaudeJSON (Sonnet-first-then-Haiku fallback chain) for single eval,
//     NOT callClaudeHaikuJSON which is Haiku-only (used by the queue in
//     lib/eval-queue.js).
//   - enqueueEval (from lib/eval-queue) for batch; routes only push onto the
//     queue and track progress via the shared Maps.
//
// State (evalProgress/evalResults/xpResults/EvalQueue/enqueueEval) arrives
// via factory from the eval-queue destructure in server.js. Same object
// references are shared with the queue internals — so data is coherent
// between enqueue, run, and post-process phases.

const express = require('express');
const { supabase } = require('../config/supabase');
const { evalLimiter } = require('../middleware/rate-limiters');
const { XP_VALUES } = require('../lib/xp');
const {
  detectQuestionType, isCopyPastedFacts, getAlternatives, GRADE_SCALE,
} = require('../lib/eval-helpers');

// Usage in server.js:
//   app.use(require('./routes/evaluate')({
//     requireAuth, adminOnly,
//     evalProgress, evalResults, xpResults, EvalQueue, enqueueEval,
//     API_KEY, KB, awardXP,
//     callClaudeJSON, generateALACModelAnswer, generateConceptualModelAnswer,
//   }));

module.exports = function createEvaluateRoutes({
  requireAuth, adminOnly,
  evalProgress, evalResults, xpResults, EvalQueue, enqueueEval,
  API_KEY, KB, awardXP,
  callClaudeJSON, generateALACModelAnswer, generateConceptualModelAnswer,
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

  // ══════════════════════════════════════════════════════════════
  // ── /api/evaluate — single-question synchronous evaluation ────
  // ══════════════════════════════════════════════════════════════
  // The body below must be byte-identical to server.js. The ALAC + conceptual
  // prompt templates contain scoring rubric enforcement text that has been
  // tuned over many iterations; even small drift affects scoring.
  router.post('/api/evaluate', evalLimiter, async (req, res) => {
    if (!API_KEY) return res.status(500).json({ error:'API key not set' });
    const { question, answer, modelAnswer, keyPoints, subject, context, forceType, questionId } = req.body;
    const refCtx = KB.references.filter(r=>r.subject===subject).slice(0,1).map(r=>r.summary||'').join('');
    const qtype = forceType || detectQuestionType(question, context, modelAnswer);
    const isSituational = qtype === 'situational' || qtype === 'essay' || qtype === 'alac';
    console.log(`[evaluate] type=${qtype} q="${(question||'').slice(0,60)}"`);

    // ── Cache lookup (ALAC + conceptual + alternative columns) ──────
    let _cachedAlac            = null;
    let _cachedConceptual      = null;
    let _needsAlacCache        = false;
    let _needsConceptualCache  = false;
    let _qCache                = null;
    if (questionId) {
      const { data: qCache } = await supabase
        .from('questions')
        .select('model_answer_alac, model_answer_conceptual, alternative_answer_1, alternative_answer_2, alternative_answer_3, alternative_answer_4, alternative_answer_5, alternative_alac_1, alternative_alac_2, alternative_alac_3, alternative_alac_4, alternative_alac_5')
        .eq('id', questionId)
        .single();
      _qCache             = qCache || null;
      _cachedAlac         = qCache?.model_answer_alac        || null;
      _cachedConceptual   = qCache?.model_answer_conceptual  || null;
    }

    // ── Alternative answer detection ──────────────────────────
    // getAlternatives returns [{index, text, alac}] — only alts with cached ALAC
    const alternatives = isSituational ? getAlternatives(_qCache || {}) : [];
    const altCount       = alternatives.length;
    const isSingleAlt    = altCount === 1;
    const isMultiAlt     = altCount >= 2;
    const hasAlternatives = altCount > 0;

    // Build reference answer section for prompt
    let maSection = '';
    if (isSituational) {
      if (isMultiAlt) {
        maSection = `SUGGESTED ANSWER HAS ${altCount} VALID ALTERNATIVES — evaluate the student against whichever they most closely answered. Return "matchedAlternative" as the number of the best-matching alternative. A student who correctly answers any valid alternative deserves full credit.\n\n` +
          alternatives.map(a => `ALTERNATIVE ${a.index}:\n${a.text}`).join('\n\n');
      } else if (isSingleAlt) {
        maSection = alternatives[0].text ? `Reference Answer:\n${alternatives[0].text}` : '';
      } else {
        maSection = modelAnswer ? `Reference Answer: ${modelAnswer}` : '';
      }
    } else {
      // Conceptual — always use model answer only, never alternatives
      maSection = modelAnswer ? `Reference Answer: ${modelAnswer}` : '';
    }

    let prompt, maxTok;
    const copyPasteDetected = isSituational && isCopyPastedFacts(answer, context);
    if (copyPasteDetected) console.log(`[eval] Copy-paste detected q="${(question||'').slice(0,60)}"`);

    if (isSituational) {
      // ── ALAC evaluation (situational / essay) ─────────────────
      maxTok = 3000;
      prompt = `You are a Philippine Bar Exam examiner. Evaluate this student answer using the ALAC method (Answer, Legal Basis, Application, Conclusion) which is the standard format required in the Philippine Bar Exam.
Keep overallFeedback under 200 words. Keep each ALAC component feedback under 50 words. Be concise and direct.
CRITICAL JSON OUTPUT RULES: Use single quotes inside all string values (never double quotes inside strings). No newlines inside string values. No trailing commas. Keep all feedback values on a single line.

Question: ${question}
${maSection}
${(keyPoints||[]).length?`Key Points to Check: ${keyPoints.join(', ')}`:''}
${refCtx?`\nLegal Reference Context:\n${refCtx}`:''}

Student Answer: ${answer}

════════════════════════════════════════
MODEL ANSWER BOUNDARY — READ THIS FIRST
════════════════════════════════════════
Your ONLY benchmark is the Reference/Alternative Answer shown above. Nothing else.

BEFORE scoring ANY component:
Step 1 — Read the Reference/Alternative Answer above.
Step 2 — List what it contains:
  - What laws/doctrines does it cite?
  - What factual analysis does it make?
  - What conclusion does it reach?
Step 3 — Compare student answer ONLY against that list.
Step 4 — Do NOT penalize for anything outside that list.

ABSOLUTELY FORBIDDEN:
- Citing cases not in the Reference/Alternative Answer
- Requiring doctrines not in the Reference/Alternative Answer
- Adding requirements from your own legal knowledge
- Importing ANY concept not in the Reference/Alternative Answer
- Saying 'student should have discussed X' when X is absent from the Reference Answer

SELF-CHECK — Before finalizing each score ask:
'Can I point to the exact part of the Reference/Alternative Answer that requires this?'
If NO → remove the deduction. Increase the score.
If YES → deduction is valid.

${copyPasteDetected ? 'COPY-PASTE WARNING: Answer appears copied from facts. Score strictly.\n' : ''}

════════════════════════════════════════
FEEDBACK TONE — STRICTLY FOLLOW
════════════════════════════════════════

You are a supportive bar exam mentor, not a harsh critic. Your feedback must:
- Acknowledge what the student did correctly first
- Frame gaps as opportunities for growth
- Use encouraging language throughout
- Sound like a mentor who wants the student to pass
- Be specific about what would make the answer better

FORBIDDEN PHRASES — never use these:
- 'the reference answer says...'
- 'the model answer requires...'
- 'student failed to...'
- 'student merely...'
- 'student completely missed...'
- 'answer is inadequate...'
- 'missing critical...'
- 'completely wrong...'
- 'no understanding of...'
- 'student should have known...'

REQUIRED PHRASES — use these patterns instead:
- 'A stronger answer would also...'
- 'To earn full marks, consider adding...'
- 'You correctly identified... — well done!'
- 'Building on your answer, you could also...'
- 'A good answer for this question would...'
- 'To complete your analysis, address...'
- 'You are on the right track — strengthen this by...'
- 'Great start — to maximize your score...'
- 'Your answer shows understanding of X — adding Y would make it complete.'

FOR COMPONENT FEEDBACK (under 50 words each):
- Start with what student got right (even briefly)
- Then frame what is missing as what would make it better
- End positively or with specific actionable advice

FOR OVERALL FEEDBACK (under 200 words):
- Open with genuine acknowledgment of what student demonstrated
- Middle: specific areas to strengthen
- Close: encouraging note about improvement

FOR keyMissed[] and improvements[]:
- Frame as 'Consider discussing...' not 'Student missed...'
- Frame as 'A good answer would include...' not 'Failed to include...'

Score each ALAC component (total = 10 points):

A — ANSWER (Max 1.5 pts) — DECISION TREE:
Step 1: Did student answer the question? NO → 0/1.5. STOP.
Step 2: Does student position match Reference Answer OR any Alternative Answer?
  YES → 1.5/1.5. STOP.
  PARTIAL/UNCLEAR → 0.5/1.5. STOP.
  NO (contradicts all) → 1.0/1.5. STOP.

L — LEGAL BASIS (Max 3.0 pts):
Award based ONLY on what the Reference/Alternative Answer requires.

  3.0/3.0 — FULL CREDIT. Award if ANY is true:
  • Student correctly named the doctrine/principle from the Reference Answer
  • Student correctly stated the substance of the governing rule even without naming it
  • Student cited the specific article or statute from the Reference Answer

  2.0/3.0 — GOOD CREDIT. Award if:
  • Student identified the correct general area of law, substance mostly correct but imprecise
  • Student named the right doctrine but framed it slightly incorrectly

  1.0/3.0 — PARTIAL CREDIT. Award if:
  • Student mentioned the general subject area without specific rule or doctrine
  • Student attempted a legal basis but only tangentially related

  0/3.0 — NO CREDIT. Award only if:
  • Student provided NO legal basis whatsoever
  • Student cited a completely wrong and inapplicable law
  • Student invented a non-existent doctrine

CRITICAL: Do NOT require section numbers, G.R. numbers, case names, or doctrines absent from the Reference Answer. The substance of the legal rule matters, not memorization of numbers.

A — APPLICATION (Max 4.0 pts) — HIGHEST WEIGHT:
4.0 — Student application mirrors the Reference/Alternative Answer application. Same facts analyzed, same legal connection, same conclusion reached.
3.0-3.5 — Covers key application points from Reference Answer, minor gaps
2.0-2.5 — Partial application, misses significant elements present in Reference Answer
1.0-1.5 — Superficial attempt compared to Reference Answer
0 — No application. Only restates law without connecting to facts.

BOUNDARY: Only deduct for missing analysis that is PRESENT in the Reference Answer. Do NOT deduct for missing analysis ABSENT from the Reference Answer.
SIMILARITY CHECK: If student application covers the same key points as Reference Answer application → minimum 3.5/4. Do NOT reduce for not discussing concepts absent from Reference Answer.

C — CONCLUSION (Max 1.5 pts):
1.5 — Clear closing statement present
1.0 — Brief conclusion present
0.5 — Implied conclusion only
0 — No conclusion at all
NEVER deduct for lacking legal foundation — that belongs in L and A components.

${GRADE_SCALE}

In your JSON response, all string values must use single quotes for any internal quotation. Example: use 'the court held' not "the court held". Keep each feedback field to one line.

════════════════════════════════════════
WRITING & MECHANICS FEEDBACK (NON-SCORING)
════════════════════════════════════════

In addition to scoring, identify spelling errors, grammar issues, and general writing observations. This is SEPARATE from the ALAC score — do not deduct ALAC points for mechanics issues. The purpose is to help the student improve their writing for actual bar exam answers.

Populate writingFeedback:
- spelling[]: specific misspellings, format "'wrong' should be 'correct'" — empty array if none
- grammar[]: specific grammar issues (subject-verb agreement, tense, punctuation) — empty array if none
- overall: one encouraging sentence summarizing writing quality

Keep each spelling/grammar entry under 25 words. Keep overall under 30 words.
If writing is clean, say so positively in overall and leave arrays empty.

Respond ONLY with valid JSON (no markdown):
{
  "score": "X/10", "numericScore": 7, "grade": "Excellent|Good|Satisfactory|Needs Improvement|Poor",
  "matchedAlternative": 1,
  "alac": {
    "answer":      { "score": 1.2, "max": 1.5, "feedback": "...", "studentDid": "..." },
    "legalBasis":  { "score": 2.5, "max": 3.0, "feedback": "...", "studentDid": "..." },
    "application": { "score": 2.8, "max": 4.0, "feedback": "...", "studentDid": "..." },
    "conclusion":  { "score": 1.2, "max": 1.5, "feedback": "...", "studentDid": "..." }
  },
  "overallFeedback": "Open with what student did well. Then 1-2 areas to strengthen. Close with encouraging note. Under 200 words.",
  "strengths": ["..."],
  "improvements": ["Consider discussing...", "A stronger answer would also include...", "To earn full marks, address..."],
  "keyMissed": ["A complete answer would address...", "Consider also discussing...", "Strengthening this area: ..."],
  "writingFeedback": {
    "spelling": ["'recieved' should be 'received'"],
    "grammar": ["Subject-verb agreement: 'the parties is' should be 'the parties are'"],
    "overall": "Clear, well-constructed response with minor mechanics issues noted above."
  },
  "format": "essay"
}`;
    } else {
      // ── Conceptual evaluation ─────────────────────────────────
      maxTok = 2500;
      prompt = `You are a Philippine Bar Exam examiner. Evaluate this conceptual/theoretical answer.
Keep overallFeedback under 100 words and each component feedback under 50 words. Be concise and direct.
CRITICAL JSON OUTPUT RULES: Use single quotes inside all string values (never double quotes inside strings). No newlines inside string values. No trailing commas. Keep all feedback values on a single line.

Question: ${question}
${maSection}
${(keyPoints||[]).length?`Key Points: ${keyPoints.join(', ')}`:''}
Student Answer: ${answer}

════════════════════════════════════════
FEEDBACK TONE — STRICTLY FOLLOW
════════════════════════════════════════

You are a supportive bar exam mentor, not a harsh critic. Your feedback must:
- Acknowledge what the student did correctly first
- Frame gaps as opportunities for growth
- Use encouraging language throughout
- Sound like a mentor who wants the student to pass
- Be specific about what would make the answer better

FORBIDDEN PHRASES — never use these:
- 'the reference answer says...'
- 'the model answer requires...'
- 'student failed to...'
- 'student merely...'
- 'student completely missed...'
- 'answer is inadequate...'
- 'missing critical...'
- 'completely wrong...'
- 'no understanding of...'
- 'student should have known...'

REQUIRED PHRASES — use these patterns instead:
- 'A stronger answer would also...'
- 'To earn full marks, consider adding...'
- 'You correctly identified... — well done!'
- 'Building on your answer, you could also...'
- 'A good answer for this question would...'
- 'To complete your analysis, address...'
- 'You are on the right track — strengthen this by...'
- 'Great start — to maximize your score...'
- 'Your answer shows understanding of X — adding Y would make it complete.'

FOR COMPONENT FEEDBACK (under 50 words each):
- Start with what student got right (even briefly)
- Then frame what is missing as what would make it better
- End positively or with specific actionable advice

FOR OVERALL FEEDBACK (under 100 words):
- Open with genuine acknowledgment of what student demonstrated
- Middle: specific areas to strengthen
- Close: encouraging note about improvement

FOR keyMissed[] and improvements[]:
- Frame as 'Consider discussing...' not 'Student missed...'
- Frame as 'A good answer would include...' not 'Failed to include...'

Score out of 10 using these components:
  Accuracy     (4 pts): Is the answer legally correct and on-point?
  Completeness (3 pts): Are all essential elements or points included?
  Clarity      (3 pts): Is it stated clearly and precisely in legal language?

${GRADE_SCALE}

In your JSON response, all string values must use single quotes for any internal quotation. Example: use 'the court held' not "the court held". Keep each feedback field to one line.
IMPORTANT: overallFeedback, keyMissed, strengths, improvements MUST be top-level fields — do NOT nest them inside breakdown.

════════════════════════════════════════
WRITING & MECHANICS FEEDBACK (NON-SCORING)
════════════════════════════════════════

In addition to scoring, identify spelling errors, grammar issues, and general writing observations. This is SEPARATE from scoring — do not deduct component points for mechanics issues.

Populate writingFeedback:
- spelling[]: specific misspellings, format "'wrong' should be 'correct'" — empty array if none
- grammar[]: specific grammar issues — empty array if none
- overall: one encouraging sentence summarizing writing quality

Keep each entry under 25 words. Keep overall under 30 words.

Respond ONLY with valid JSON (no markdown):
{
  "score": "X/10", "numericScore": 0, "grade": "Excellent|Good|Satisfactory|Needs Improvement|Poor",
  "matchedAlternative": 1,
  "breakdown": {
    "accuracy":     { "score": 0.0, "max": 4, "feedback": "under 50 words — start with what student got right" },
    "completeness": { "score": 0.0, "max": 3, "feedback": "under 50 words — start with what student got right" },
    "clarity":      { "score": 0.0, "max": 3, "feedback": "under 50 words — start with what student got right" }
  },
  "overallFeedback": "Open with what student did well. Then 1-2 areas to strengthen. Close with encouraging note. Under 100 words.",
  "keyMissed": ["A complete answer would address...", "Consider also discussing..."],
  "strengths": ["what the student did well"],
  "improvements": ["Consider discussing...", "A stronger answer would also include..."],
  "writingFeedback": {
    "spelling": [],
    "grammar": [],
    "overall": "Clear, well-constructed response."
  },
  "format": "conceptual"
}`;
    }

    try {
      const result = await callClaudeJSON([{ role:'user', content: prompt }], maxTok, 3, { temperature: 0 });
      if (!result) {
        console.error(`[evaluate] callClaudeJSON returned null (all JSON parse retries exhausted). qtype=${qtype} answerLen=${answer?.length}`);
        return res.status(422).json({ error:'Evaluation failed — could not parse scoring response. Please try submitting your answer again.' });
      }
      result.format       = qtype;
      result.questionType = qtype;
      if (!result.keyPoints?.length && keyPoints?.length) result.keyPoints = keyPoints;

      // ── Apply matched alternative (situational only) ─────────────
      if (isSituational && isMultiAlt) {
        // Multi-alt: AI returned matchedAlternative index
        const matched = result.matchedAlternative || alternatives[0].index;
        const matchedAlt = alternatives.find(a => a.index === matched) || alternatives[0];
        result.modelAnswer              = matchedAlt.text;
        result.modelAnswerOriginal      = modelAnswer;
        result.usedAlternative          = true;
        result.matchedAlternativeNumber = matchedAlt.index;
        result.showMatchedBadge         = true;
        result.matchedAlternativeAlac   = matchedAlt.alac;
        result.alacModelAnswer          = matchedAlt.alac;
        const ac = matchedAlt.alac;
        result.modelAnswerFormatted = [
          `ANSWER: ${ac.answer}`, `LEGAL BASIS: ${ac.legalBasis}`,
          `APPLICATION: ${ac.application}`, `CONCLUSION: ${ac.conclusion}`,
        ].filter(s => !s.match(/:\s*$/)).join('\n\n');
        result.modelAnswer = result.modelAnswerFormatted;
        console.log(`[evaluate] multi-alt: matched Alt ${matchedAlt.index}/${altCount}`);

      } else if (isSituational && isSingleAlt) {
        // Single alt IS the answer — no badge
        const alt = alternatives[0];
        result.modelAnswer              = alt.text;
        result.modelAnswerOriginal      = modelAnswer;
        result.usedAlternative          = false;
        result.matchedAlternativeNumber = alt.index;
        result.showMatchedBadge         = false;
        result.matchedAlternativeAlac   = alt.alac;
        result.alacModelAnswer          = alt.alac;
        const ac = alt.alac;
        result.modelAnswerFormatted = [
          `ANSWER: ${ac.answer}`, `LEGAL BASIS: ${ac.legalBasis}`,
          `APPLICATION: ${ac.application}`, `CONCLUSION: ${ac.conclusion}`,
        ].filter(s => !s.match(/:\s*$/)).join('\n\n');
        result.modelAnswer = result.modelAnswerFormatted;
        console.log(`[evaluate] single-alt: using Alt ${alt.index} as model answer`);

      } else if (isSituational) {
        // No alt ALACs — fall back to model_answer_alac
        if (!result.modelAnswer && modelAnswer) result.modelAnswer = modelAnswer;
        result.usedAlternative  = false;
        result.showMatchedBadge = false;

        if (_cachedAlac) {
          result.alacModelAnswer = _cachedAlac;
          result.modelAnswerFormatted = [
            `ANSWER: ${_cachedAlac.answer}`, `LEGAL BASIS: ${_cachedAlac.legalBasis}`,
            `APPLICATION: ${_cachedAlac.application}`, `CONCLUSION: ${_cachedAlac.conclusion}`,
          ].filter(s => !s.match(/:\s*$/)).join('\n\n');
          result.modelAnswer = result.modelAnswerFormatted;
        } else if (result.modelAnswer) {
          const alacResult = await generateALACModelAnswer(question, context, result.modelAnswer, subject);
          if (alacResult) {
            result.alacModelAnswer      = alacResult.components;
            result.modelAnswerFormatted = alacResult.formatted;
            result.modelAnswer          = alacResult.formatted;
            _needsAlacCache = true;
          }
        }
      } else {
        // Conceptual — never use alternatives
        if (!result.modelAnswer && modelAnswer) result.modelAnswer = modelAnswer;
        result.usedAlternative  = false;
        result.showMatchedBadge = false;
      }

      // Generate structured conceptual model answer for conceptual questions
      if (!isSituational && result.modelAnswer) {
        if (_cachedConceptual) {
          result.conceptualModelAnswer = _cachedConceptual;
        } else {
          const conceptualResult = await generateConceptualModelAnswer(question, result.modelAnswer);
          if (conceptualResult) {
            result.conceptualModelAnswer = conceptualResult;
            _needsConceptualCache = true;
          }
        }
      }

      // ── Write cache to Supabase (fire-and-forget) ─────────────
      if (questionId && (_needsAlacCache || _needsConceptualCache)) {
        const cacheUpdate = {};
        if (_needsAlacCache)       cacheUpdate.model_answer_alac        = result.alacModelAnswer;
        if (_needsConceptualCache) cacheUpdate.model_answer_conceptual  = result.conceptualModelAnswer;
        supabase.from('questions').update(cacheUpdate).eq('id', questionId)
          .then(({ error: ce }) => { if (ce) console.warn('[cache-write] /api/evaluate failed:', ce.message); });
      }

      res.json(result);
    } catch(err) {
      console.error(`[evaluate] threw: ${err.message} (${err.name}) qtype=${qtype} answerLen=${answer?.length}`);
      res.status(500).json({ error:err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════
  // ── /api/evaluate-batch — async batch; client polls progress ──
  // ══════════════════════════════════════════════════════════════
  router.post('/api/evaluate-batch', requireAuth, evalLimiter, async (req, res) => {
    if (!API_KEY) return res.status(500).json({ error: 'API key not set' });
    const { questions, submissionId: clientId, resultId, sessionType, subject } = req.body;
    if (!Array.isArray(questions) || !questions.length)
      return res.status(400).json({ error: 'questions array required' });

    const submissionId = (clientId && /^[a-zA-Z0-9_-]{5,50}$/.test(clientId))
      ? clientId
      : 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    evalProgress.set(submissionId, { total: questions.length, done: 0, complete: false });

    // Capture before res.json() releases the HTTP connection
    const userId = req.userId;

    // Return immediately — HTTP connection released, client polls /api/eval-progress/:id
    res.json({ submissionId, total: questions.length });

    // Run evaluations in the background; store results when all finish
    Promise.all(questions.map((q, i) => enqueueEval(submissionId, userId, q, i)))
      .then(async scores => {
        evalResults.set(submissionId, scores);
        // evalProgress.complete is already set true by the last runEvalJob finally-block,
        // but we set it again here as a safety net in case of any race.
        const prog = evalProgress.get(submissionId);
        if (prog) prog.complete = true;
        // Clean up all maps after 10 minutes
        setTimeout(() => { evalProgress.delete(submissionId); evalResults.delete(submissionId); xpResults.delete(submissionId); }, 10 * 60 * 1000);

        // ── Post-eval: update result record + award XP ───────────
        // review_session XP is awarded at save time; skip here
        if (!resultId || !sessionType || sessionType === 'review_session') return;
        try {
          const totalQuestions = scores.length;
          const successfulEvals = scores.filter(s => !s._evalError && s.grade !== 'Error').length;

          // Compute final total score from actual evaluated components
          const computedTotal = scores.reduce((sum, s) => {
            if (s._evalError || s.grade === 'Error') return sum;
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

          // Update result record with final evaluated scores
          const { error: updateErr } = await supabase.from('results').update({
            evaluations: scores,
            score: parseFloat(computedTotal.toFixed(2)),
            passed: totalQuestions > 0 && computedTotal / (totalQuestions * 10) >= 0.7,
            last_updated_at: new Date().toISOString(),
          }).eq('id', resultId);
          if (updateErr) console.error('[evaluate-batch] result update error:', updateErr.message);

          // Award XP only if >= 80% of questions evaluated successfully
          const evalSuccessRate = successfulEvals / totalQuestions;
          if (evalSuccessRate < 0.8) {
            console.log(`[xp] Skipped — only ${successfulEvals}/${totalQuestions} questions evaluated successfully`);
            return;
          }

          const VALID_SUBJ_KEYS = ['civil','criminal','political','labor','commercial','taxation','remedial','ethics','custom'];
          const subjectKey = VALID_SUBJ_KEYS.includes(subject) ? subject : (subject || 'mixed');

          const highScoreCount = scores.filter(s => {
            if (s._evalError || s.grade === 'Error') return false;
            const qScore = s.alac
              ? (s.alac.answer?.score || 0) + (s.alac.legalBasis?.score || 0)
                + (s.alac.application?.score || 0) + (s.alac.conclusion?.score || 0)
              : s.breakdown
                ? (s.breakdown.accuracy?.score || 0) + (s.breakdown.completeness?.score || 0)
                  + (s.breakdown.clarity?.score || 0)
                : (s.numericScore || 0);
            return qScore >= 8.0;
          }).length;
          const bonusXP = highScoreCount * XP_VALUES.HIGH_SCORE_BONUS;

          let xpData = null;
          if (sessionType === 'speed_drill') {
            xpData = await awardXP(userId, 'COMPLETE_SPEED_DRILL', `Completed Speed Drill — ${subjectKey}`, bonusXP);
          } else {
            const isFullSession = totalQuestions === 20;
            const baseXP = isFullSession
              ? XP_VALUES.MOCK_BAR_FULL_BONUS
              : totalQuestions * XP_VALUES.MOCK_BAR_PER_QUESTION;
            xpData = await awardXP(
              userId,
              isFullSession ? 'MOCK_BAR_FULL' : 'MOCK_BAR_PARTIAL',
              `Completed Mock Bar — ${subjectKey} (${totalQuestions} question${totalQuestions !== 1 ? 's' : ''})`,
              baseXP + bonusXP
            );
          }
          if (xpData) {
            xpData.highScoreCount = highScoreCount;
            xpData.highScoreBonus = bonusXP;
            xpResults.set(submissionId, xpData);
          }
        } catch (xpErr) {
          console.error('[xp] evaluate-batch completion error:', xpErr.message);
        }
      })
      .catch(err => {
        console.error('[evaluate-batch] background error:', err.message);
        evalProgress.delete(submissionId);
        evalResults.delete(submissionId);
      });
  });

  return router;
};
