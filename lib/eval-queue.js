// Eval queue subsystem — extracted from server.js, behavior unchanged.
//
// Exports a factory that takes server.js-resident dependencies
// (KB, callClaudeHaikuJSON, the two model-answer generators, awardXP)
// and returns the initialized queue plus the Maps that track per-
// submission state.
//
// Architecture:
//   - EvalQueue: global FIFO with per-user cap (5) and global cap (20).
//     Fair scheduling — one user can't monopolize the pool.
//   - processEvalQueue: launches eligible jobs; called after enqueue
//     and after every job finishes.
//   - runEvalJob: the per-question evaluator. Builds ALAC or conceptual
//     prompt, calls callClaudeHaikuJSON, post-processes results, writes
//     cache, upserts spaced-repetition, returns scored result.
//   - evalProgress / evalResults / xpResults: 3 Maps keyed by
//     submissionId, used by /api/evaluate-batch + the polling routes
//     in server.js.
//
// processEvalQueue and runEvalJob are factory-internal (closure access
// to deps). Only the API surface that server.js's routes need is exported.

const { supabase } = require('../config/supabase');
const {
  detectQuestionType, isCopyPastedFacts, isTrivialNonAnswer, getAlternatives, GRADE_SCALE,
} = require('./eval-helpers');

module.exports = function createEvalQueue({
  KB, callClaudeHaikuJSON, generateALACModelAnswer, generateConceptualModelAnswer, awardXP,
}) {
  // ── Per-submission state Maps ─────────────────────────────────
  const evalProgress = new Map(); // submissionId → { total, done, complete }
  const evalResults  = new Map(); // submissionId → scores array (set after all jobs finish)
  const xpResults    = new Map(); // submissionId → xpData (set after awardXP resolves)

  // ── Global evaluation queue ───────────────────────────────────
  // Handles 30+ concurrent users fairly: FIFO across users, per-user
  // concurrency cap, interleaved so every user gets partial results quickly.
  const EvalQueue = {
    queue: [],              // [{ submissionId, userId, item, idx, resolve, reject, enqueuedAt }]
    activeCount: 0,         // currently running API calls
    maxConcurrent: 20,      // matches semaphore — safe for Haiku at scale
    perUserActive: new Map(), // userId → currently-running count for that user
    perUserMax: 5,          // fairness cap: one user can't monopolise all 20 slots
    evalTimeSamples: [],    // rolling window of completed eval durations (ms)
    totalProcessed: 0,
    get avgEvalTimeMs() {
      if (!this.evalTimeSamples.length) return 3000;
      return Math.round(this.evalTimeSamples.reduce((a, b) => a + b, 0) / this.evalTimeSamples.length);
    },
    recordTime(ms) {
      this.evalTimeSamples.push(ms);
      if (this.evalTimeSamples.length > 200) this.evalTimeSamples.shift();
    },
  };

  // Start as many queued jobs as global + per-user limits allow.
  // Safe to call multiple times — JavaScript is single-threaded so the while-loop
  // is atomic with respect to the async jobs it launches.
  function processEvalQueue() {
    while (EvalQueue.activeCount < EvalQueue.maxConcurrent && EvalQueue.queue.length > 0) {
      // Find the first job whose user is under their per-user cap (FIFO within that constraint)
      const jobIdx = EvalQueue.queue.findIndex(j => {
        return (EvalQueue.perUserActive.get(j.userId) || 0) < EvalQueue.perUserMax;
      });
      if (jobIdx === -1) break; // every remaining job belongs to a user at their cap

      const [job] = EvalQueue.queue.splice(jobIdx, 1);
      EvalQueue.activeCount++;
      EvalQueue.perUserActive.set(job.userId, (EvalQueue.perUserActive.get(job.userId) || 0) + 1);

      const startMs = Date.now();
      runEvalJob(job)
        .then(result => job.resolve(result))
        .catch(err   => job.reject(err))
        .finally(() => {
          EvalQueue.activeCount--;
          EvalQueue.perUserActive.set(job.userId, Math.max(0, (EvalQueue.perUserActive.get(job.userId) || 1) - 1));
          EvalQueue.recordTime(Date.now() - startMs);
          EvalQueue.totalProcessed++;
          processEvalQueue(); // unblock next eligible job
        });
    }
  }

  // Push one evaluation onto the global queue; returns a Promise that resolves with the score.
  function enqueueEval(submissionId, userId, item, idx) {
    return new Promise((resolve, reject) => {
      EvalQueue.queue.push({ submissionId, userId, item, idx, resolve, reject, enqueuedAt: Date.now() });
      processEvalQueue();
    });
  }

  // Core per-question evaluation — called by processEvalQueue, never directly.
  async function runEvalJob(job) {
    const { submissionId, item, idx } = job;
    const { question, answer, context, modelAnswer, keyPoints, subject } = item;
    // Cache fields injected by mapQRow (or by evaluate-batch client payload if present)
    const questionId             = item.id || null;
    let   _cachedAlac            = item._cachedAlac            || null;
    let   _cachedConceptual      = item._cachedConceptual      || null;
    let   _needsAlacCache        = false;
    let   _needsConceptualCache  = false;

    if (!answer || !answer.trim()) {
      const prog = evalProgress.get(submissionId);
      if (prog) { prog.done++; }  // complete set only after evalResults.set() in .then()
      return { score: '0/10', numericScore: 0, grade: 'Not Answered', overallFeedback: 'No answer provided.', keyMissed: [] };
    }

    // Hoist qtype so the catch block can log it even if it's set inside try
    let qtype = 'unknown';
    try {
      const refCtx = KB.references.filter(r => r.subject === subject).slice(0, 1).map(r => r.summary || '').join('');
      qtype = detectQuestionType(question, context, modelAnswer);
      const isSit = qtype === 'situational' || qtype === 'essay' || qtype === 'alac';

      // ── Trivial-input short-circuit: skip Haiku call for obvious non-answers ──
      // Saves ~5 seconds and one API round-trip for answers that always score 0
      // (<20 chars or >90% copy of the question text).
      if (isTrivialNonAnswer(answer, question)) {
        console.log(`[eval-batch] Trivial non-answer short-circuit Q${idx+1} (answerLen=${answer.trim().length})`);
        if (isSit) {
          return {
            score: '0/10', numericScore: 0, grade: 'Poor',
            alac: {
              answer:      { score: 0, max: 1.5, feedback: 'Your answer is too brief to evaluate. A complete response states your position clearly.', studentDid: 'Provided an incomplete response' },
              legalBasis:  { score: 0, max: 3,   feedback: 'A strong answer cites the relevant law, article, or doctrine. Consider adding this.', studentDid: '' },
              application: { score: 0, max: 4,   feedback: 'Bar answers apply the law to the facts step by step. Try walking through the analysis.', studentDid: '' },
              conclusion:  { score: 0, max: 1.5, feedback: 'Close with a clear final ruling that ties back to your answer.', studentDid: '' },
            },
            overallFeedback: 'Your answer is too brief to score. A complete bar exam answer follows the ALAC format: state your position, cite the governing law, apply it to the facts, and conclude. Try writing at least a few sentences for each component.',
            strengths: [],
            improvements: ['Write a complete ALAC-format response: Answer, Legal Basis, Application, Conclusion', 'Aim for at least 150 words for situational questions'],
            keyMissed: ['A substantive answer that addresses the question'],
            format: qtype, questionType: qtype,
          };
        } else {
          return {
            score: '0/10', numericScore: 0, grade: 'Poor',
            breakdown: {
              accuracy:     { score: 0, max: 4, feedback: 'Your answer is too brief to evaluate for accuracy.' },
              completeness: { score: 0, max: 3, feedback: 'A complete answer covers all essential elements of the concept.' },
              clarity:      { score: 0, max: 3, feedback: 'Try organizing your answer with clear structure and legal language.' },
            },
            overallFeedback: 'Your answer is too brief to score. A strong conceptual answer defines the concept accurately, covers all essential elements, and presents them with clarity. Try writing at least a few sentences covering each component.',
            strengths: [],
            improvements: ['Define the concept first, then elaborate', 'Include essential elements and any qualifications or exceptions'],
            keyMissed: ['A substantive answer that addresses the question'],
            format: qtype, questionType: qtype,
          };
        }
      }

      // getAlternatives returns [{index, text, alac}] — only alts with cached ALAC
      const alternatives = isSit ? getAlternatives(item) : [];
      const altCount       = alternatives.length;
      const isSingleAlt    = altCount === 1;
      const isMultiAlt     = altCount >= 2;

      let maSection = '';
      if (isSit) {
        if (isMultiAlt) {
          maSection = `SUGGESTED ANSWER HAS ${altCount} VALID ALTERNATIVES — evaluate the student against whichever they most closely answered. Return "matchedAlternative" as the number of the best-matching alternative.\n\n` +
            alternatives.map(a => `ALTERNATIVE ${a.index}:\n${a.text}`).join('\n\n');
        } else if (isSingleAlt) {
          maSection = alternatives[0].text ? `Reference Answer:\n${alternatives[0].text}` : '';
        } else {
          maSection = modelAnswer ? `Reference Answer: ${modelAnswer}` : '';
        }
      } else {
        maSection = modelAnswer ? `Reference Answer: ${modelAnswer}` : '';
      }

      let prompt, maxTok;
      const copyPasteDetected = isSit && isCopyPastedFacts(answer, context);
      if (copyPasteDetected) console.log(`[eval-batch] Copy-paste detected Q${idx+1}`);

      if (isSit) {
        maxTok = 2500;
        prompt = `You are a Philippine Bar Exam examiner. Evaluate using ALAC (Answer 1.5pts, Legal Basis 3pts, Application 4pts, Conclusion 1.5pts). Keep overallFeedback under 200 words and each component feedback under 50 words.
CRITICAL JSON OUTPUT RULES: Use single quotes inside all string values. No newlines inside string values. No trailing commas. Keep all feedback on one line.

Question: ${question}
${maSection}
${(keyPoints || []).length ? `Key Points: ${keyPoints.join(', ')}` : ''}
${refCtx ? `Legal Context: ${refCtx.slice(0, 400)}` : ''}

Student Answer: ${answer}

MODEL ANSWER BOUNDARY — READ THIS FIRST:
Your ONLY benchmark is the Reference/Alternative Answer shown above. Nothing else.
BEFORE scoring ANY component:
Step 1 — Read the Reference/Alternative Answer above.
Step 2 — List what it contains: What laws/doctrines does it cite? What factual analysis does it make? What conclusion does it reach?
Step 3 — Compare student answer ONLY against that list.
Step 4 — Do NOT penalize for anything outside that list.

ABSOLUTELY FORBIDDEN:
- Citing cases not in the Reference/Alternative Answer
- Requiring doctrines not in the Reference/Alternative Answer
- Adding requirements from your own legal knowledge
- Importing ANY concept not in the Reference/Alternative Answer
- Saying 'student should have discussed X' when X is absent from the Reference Answer

SELF-CHECK — Before finalizing each score ask: 'Can I point to the exact part of the Reference/Alternative Answer that requires this?' If NO → remove the deduction. Increase the score. If YES → deduction is valid.

${copyPasteDetected ? 'COPY-PASTE WARNING: Answer appears copied from facts. Score strictly.' : ''}

FEEDBACK TONE — STRICTLY FOLLOW:
You are a supportive bar exam mentor, not a harsh critic. Your feedback must: acknowledge what the student did correctly first, frame gaps as opportunities for growth, use encouraging language throughout, sound like a mentor who wants the student to pass, be specific about what would make the answer better.
FORBIDDEN PHRASES — never use these: 'the reference answer says...', 'the model answer requires...', 'student failed to...', 'student merely...', 'student completely missed...', 'answer is inadequate...', 'missing critical...', 'completely wrong...', 'no understanding of...', 'student should have known...'
REQUIRED PHRASES — use these patterns instead: 'A stronger answer would also...', 'To earn full marks, consider adding...', 'You correctly identified... — well done!', 'Building on your answer, you could also...', 'You are on the right track — strengthen this by...', 'Great start — to maximize your score...', 'Your answer shows understanding of X — adding Y would make it complete.'
FOR COMPONENT FEEDBACK: Start with what student got right, then frame what is missing as what would make it better. FOR OVERALL FEEDBACK: Open with genuine acknowledgment, then areas to strengthen, close encouragingly. FOR keyMissed/improvements: Frame as 'Consider discussing...' or 'A good answer would include...' — never 'Student missed...' or 'Failed to include...'

A — ANSWER (Max 1.5 pts) — DECISION TREE:
Step 1: Did student answer the question? NO → 0/1.5. STOP.
Step 2: Does student position match Reference Answer OR any Alternative Answer? YES → 1.5/1.5. STOP. PARTIAL/UNCLEAR → 0.5/1.5. STOP. NO (contradicts all) → 1.0/1.5. STOP.

L — LEGAL BASIS (Max 3.0 pts):
3.0 — Student cited the correct law/doctrine present in the Reference Answer
2.0 — Student cited correct general area of law, substance is right but imprecise
1.0 — Student mentioned legal area without specific rule or doctrine
0 — No legal basis, or completely wrong law
CRITICAL: Award based ONLY on what the Reference/Alternative Answer requires. Do NOT require section numbers, case names, or doctrines absent from the Reference Answer.

A — APPLICATION (Max 4.0 pts):
4.0 — Student application mirrors the Reference/Alternative Answer application
3.0-3.5 — Covers key points, minor gaps
2.0-2.5 — Partial application
1.0-1.5 — Superficial attempt
0 — No application
BOUNDARY: Only deduct for missing analysis that is PRESENT in the Reference Answer. Do NOT deduct for missing analysis ABSENT from the Reference Answer.
SIMILARITY CHECK: If student application covers the same key points as Reference Answer application → minimum 3.5/4.

C — CONCLUSION (Max 1.5 pts):
1.5 — Clear closing statement present
1.0 — Brief conclusion present
0.5 — Implied conclusion only
0 — No conclusion at all
NEVER deduct for lacking legal foundation — that belongs in L and A components.

${GRADE_SCALE}
Respond ONLY with valid JSON: {"score":"X/10","numericScore":0,"grade":"...","alac":{"answer":{"score":0,"max":1.5,"feedback":"under 50 words — start with what student got right","studentDid":""},"legalBasis":{"score":0,"max":3,"feedback":"under 50 words — start with what student got right","studentDid":""},"application":{"score":0,"max":4,"feedback":"under 50 words — start with what student got right","studentDid":""},"conclusion":{"score":0,"max":1.5,"feedback":"under 50 words — start with what student got right","studentDid":""}},"overallFeedback":"Open with what student did well then areas to strengthen then encouraging close. Under 200 words","strengths":[],"improvements":["Consider discussing...","A stronger answer would also include..."],"keyMissed":["A complete answer would address...","Consider also discussing..."],"matchedAlternative":1,"format":"essay"}`;
      } else {
        maxTok = 2500;
        prompt = `You are a Philippine Bar Exam examiner. Evaluate this conceptual/theoretical answer. Keep overallFeedback under 100 words and each component feedback under 50 words.
CRITICAL JSON OUTPUT RULES: Use single quotes inside all string values (never double quotes inside strings). No newlines inside string values. No trailing commas. Keep all feedback fields on a single line.
IMPORTANT: Return pure JSON only. Never include { or } characters inside any string value. Write all feedback as plain text sentences only. No code examples, no nested structures, no special characters inside strings.
IMPORTANT: overallFeedback, keyMissed, strengths, improvements MUST be top-level fields — do NOT nest them inside breakdown.

FEEDBACK TONE — STRICTLY FOLLOW:
You are a supportive bar exam mentor, not a harsh critic. Your feedback must: acknowledge what the student did correctly first, frame gaps as opportunities for growth, use encouraging language throughout, sound like a mentor who wants the student to pass, be specific about what would make the answer better.
FORBIDDEN PHRASES — never use these: 'the reference answer says...', 'the model answer requires...', 'student failed to...', 'student merely...', 'student completely missed...', 'answer is inadequate...', 'missing critical...', 'completely wrong...', 'no understanding of...', 'student should have known...'
REQUIRED PHRASES — use these patterns instead: 'A stronger answer would also...', 'To earn full marks, consider adding...', 'You correctly identified... — well done!', 'Building on your answer, you could also...', 'You are on the right track — strengthen this by...', 'Great start — to maximize your score...', 'Your answer shows understanding of X — adding Y would make it complete.'
FOR COMPONENT FEEDBACK: Start with what student got right, then frame what is missing as what would make it better. FOR OVERALL FEEDBACK: Open with genuine acknowledgment, then areas to strengthen, close encouragingly. FOR keyMissed/improvements: Frame as 'Consider discussing...' or 'A good answer would include...' — never 'Student missed...' or 'Failed to include...'

Question: ${question}
${maSection}
${(keyPoints || []).length ? `Key Points: ${keyPoints.join(', ')}` : ''}
Student Answer: ${answer}
Score: Accuracy(4pts) + Completeness(3pts) + Clarity(3pts) = 10.
${GRADE_SCALE}
Respond ONLY with valid JSON: {"score":"X/10","numericScore":0,"grade":"...","breakdown":{"accuracy":{"score":0,"max":4,"feedback":"under 50 words — start with what student got right"},"completeness":{"score":0,"max":3,"feedback":"under 50 words — start with what student got right"},"clarity":{"score":0,"max":3,"feedback":"under 50 words — start with what student got right"}},"overallFeedback":"Open with what student did well then areas to strengthen then encouraging close. Under 100 words","keyMissed":["A complete answer would address...","Consider also discussing..."],"strengths":[],"improvements":["Consider discussing...","A stronger answer would also include..."],"matchedAlternative":1,"format":"conceptual"}`;
      }

      // ── Parallel kickoff: scoring call + model-answer generation ──
      // Only parallelize when we KNOW we'll need the generated model answer AND
      // don't have it cached. Alt-matching cases (multi-alt, single-alt) don't
      // call the generators at all — they use matchedAlt.alac directly.
      const needsAlacGen       = isSit  && altCount === 0 && !_cachedAlac && !!modelAnswer;
      const needsConceptualGen = !isSit && !_cachedConceptual && !!modelAnswer;

      const scorePromise = callClaudeHaikuJSON(prompt, maxTok);
      const modelAnswerPromise = needsAlacGen
        ? generateALACModelAnswer(question, context, modelAnswer, subject).catch(e => { console.warn('[eval-batch] ALAC gen parallel failed:', e.message); return null; })
        : needsConceptualGen
          ? generateConceptualModelAnswer(question, modelAnswer).catch(e => { console.warn('[eval-batch] Conceptual gen parallel failed:', e.message); return null; })
          : Promise.resolve(null);

      const [result, preComputedModelAnswer] = await Promise.all([scorePromise, modelAnswerPromise]);

      if (result) {
        result.format       = qtype;
        result.questionType = qtype;
        if (!result.keyPoints?.length && keyPoints?.length) result.keyPoints = keyPoints;

        // ── Apply matched alternative (situational only) ─────────────
        if (isSit && isMultiAlt) {
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
          console.log(`[eval-batch] multi-alt: matched Alt ${matchedAlt.index}/${altCount} Q${idx+1}`);

        } else if (isSit && isSingleAlt) {
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

        } else if (isSit) {
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
          } else if (preComputedModelAnswer) {
            // Use the result from the parallel kickoff above
            result.alacModelAnswer      = preComputedModelAnswer.components;
            result.modelAnswerFormatted = preComputedModelAnswer.formatted;
            result.modelAnswer          = preComputedModelAnswer.formatted;
            _needsAlacCache = true;
          } else if (result.modelAnswer) {
            // Fallback: only reached if needsAlacGen was false at kickoff time
            // but the scoring call produced a new modelAnswer that needs ALAC.
            // This should be rare — we kick off in parallel based on the original
            // modelAnswer, which is the same input the scorer gets.
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
        if (!isSit && result.modelAnswer) {
          if (_cachedConceptual) {
            result.conceptualModelAnswer = _cachedConceptual;
          } else if (preComputedModelAnswer) {
            // Use the result from the parallel kickoff above
            result.conceptualModelAnswer = preComputedModelAnswer;
            _needsConceptualCache = true;
          } else {
            // Fallback: reached only if needsConceptualGen was false at kickoff
            // (e.g. no modelAnswer available then, but scoring call filled one in)
            const conceptualResult = await generateConceptualModelAnswer(question, result.modelAnswer);
            if (conceptualResult) {
              result.conceptualModelAnswer = conceptualResult;
              _needsConceptualCache = true;
            }
          }
        }

        // ── Write cache to Supabase (fire-and-forget) ───────────
        if (questionId && (_needsAlacCache || _needsConceptualCache)) {
          const cacheUpdate = {};
          if (_needsAlacCache)       cacheUpdate.model_answer_alac        = result.alacModelAnswer;
          if (_needsConceptualCache) cacheUpdate.model_answer_conceptual  = result.conceptualModelAnswer;
          supabase.from('questions').update(cacheUpdate).eq('id', questionId)
            .then(({ error: ce }) => { if (ce) console.warn(`[cache-write] Q${idx + 1} failed:`, ce.message); });
        }

        // ── Spaced repetition upsert (fire-and-forget) ───────────
        if (questionId && job.userId && !result._evalError) {
          const al = result.alac || {};
          const bd = result.breakdown || {};
          const srScore = (al.answer?.score != null)
            ? Number(((al.answer.score||0)+(al.legalBasis?.score||0)+(al.application?.score||0)+(al.conclusion?.score||0)).toFixed(2))
            : (bd.accuracy?.score != null)
              ? Number(((bd.accuracy.score||0)+(bd.completeness?.score||0)+(bd.clarity?.score||0)).toFixed(2))
              : (result.numericScore || 0);
          const reviewDays = srScore < 5 ? 3 : srScore < 7 ? 7 : srScore < 8 ? 14 : null;
          const mastered   = srScore >= 8;
          const nextReviewAt = reviewDays ? new Date(Date.now() + reviewDays * 86400000).toISOString() : null;
          const srId = `sr_${job.userId}_${questionId}`;
          console.log(`[spaced-rep] Q${idx+1} score:${srScore} mastered:${mastered} qtype:${qtype} alac:${!!al.answer} breakdown:${!!bd.accuracy} numericScore:${result.numericScore}`);
          supabase.from('spaced_repetition').select('review_count, mastered').eq('id', srId).single()
            .then(({ data: ex }) => {
              const wasAlreadyMastered = ex?.mastered || false;
              return supabase.from('spaced_repetition').upsert({
                id: srId, user_id: job.userId, question_id: questionId, subject,
                last_score: srScore, last_attempted_at: new Date().toISOString(),
                next_review_at: nextReviewAt, review_count: (ex?.review_count || 0) + 1, mastered,
              }, { onConflict: 'user_id,question_id' })
                .then(({ error: e }) => {
                  if (e) { console.warn('[sr-upsert]', e.message); return; }
                  // Award XP the first time a question is mastered
                  if (mastered && !wasAlreadyMastered) {
                    awardXP(job.userId, 'MASTER_SPACED_REP', `Mastered question: ${questionId}`).catch(() => {});
                  }
                });
            })
            .catch(e => console.warn('[sr-upsert]', e.message));
        }
      }

      if (!result) {
        console.error(`[evaluate-batch] Q${idx + 1} failed: callClaudeHaikuJSON returned null (all JSON parse retries exhausted). qtype=${qtype} answerLen=${answer?.length}`);
      }
      return result || { score: '0/10', numericScore: 0, grade: 'Error', overallFeedback: 'Evaluation failed — please retry.', keyMissed: [], _evalError: true };
    } catch (e) {
      console.error(`[runEvalJob] Unexpected error for question ${questionId}:`, e.message, e.stack?.split('\n')[1]);
      console.error(`[evaluate-batch] Q${idx + 1} threw: ${e.message} (${e.name}) qtype=${qtype} answerLen=${answer?.length}`);
      return { score: '0/10', numericScore: 0, grade: 'Error', overallFeedback: 'Evaluation temporarily unavailable.', keyMissed: [], _evalError: true };
    } finally {
      const prog = evalProgress.get(submissionId);
      // Increment done counter. Do NOT set complete here — complete is set only after
      // evalResults.set() in the Promise.all .then() handler to close the race window.
      if (prog) { prog.done++; }
    }
  }

  return { evalProgress, evalResults, xpResults, EvalQueue, enqueueEval };
};
