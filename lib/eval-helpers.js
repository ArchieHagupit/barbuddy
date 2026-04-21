// Eval helpers — pure functions used by /api/evaluate and runEvalJob.
//
// All four items are side-effect-free:
//   - detectQuestionType: classifier that returns 'situational' or 'conceptual'
//     based on context length, case-party keywords, question-text phrasing, and
//     ALAC markers in the model answer.
//   - isCopyPastedFacts: heuristic that flags student answers that mostly just
//     restate the fact pattern (>70% token overlap). Used to penalize non-answers.
//   - getAlternatives: pulls cached alternative_answer_N + alternative_alac_N
//     columns off a question row into a normalized [{index, text, alac}] list,
//     skipping alts without cached ALAC.
//   - GRADE_SCALE: const string interpolated into ALAC + conceptual prompts so
//     the LLM knows the passing threshold (7.0/10) and grade-label mapping.

function detectQuestionType(questionText, context, modelAnswer) {
  const q   = (questionText || '').toLowerCase().trim();
  const ctx = (context      || '').toLowerCase().trim();
  const ans = (modelAnswer  || '').toLowerCase();

  // ── Situational — context (fact pattern) is the strongest signal ──
  const hasFacts       = ctx.length > 80;
  const hasCaseParties = /filed|sued|plaintiff|defendant|petitioner|respondent|labor arbiter|nlrc|\brtc\b|\bca\b|supreme court/i.test(ctx);
  if (hasFacts || hasCaseParties) return 'situational';

  // ── Situational keywords in question text ──
  const situationalKw = ['rule on', 'decide', 'resolve', 'is he liable', 'is she liable',
    'is it valid', 'is the contract', 'may he', 'may she', 'can he', 'what crime',
    'what offense', 'the facts show', 'in the case', 'plaintiff', 'defendant',
    'accused', 'complainant'];
  if (situationalKw.some(kw => q.includes(kw))) return 'situational';

  // ── Model answer ALAC signal ──
  const hasALAC  = /(answer:|legal basis:|application:|conclusion:)/i.test(ans);
  const ansWords = ans.split(/\s+/).filter(w => w.length > 0).length;
  if (hasALAC && ansWords > 100) return 'situational';

  return 'conceptual'; // default — conceptual/theoretical questions
}

// ── Copy-paste detection — flags answers that just restate the given facts ──
function isCopyPastedFacts(studentAnswer, facts) {
  if (!facts || !studentAnswer) return false;
  const normalize = (text) => text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const normalizedAnswer = normalize(studentAnswer);
  const normalizedFacts  = normalize(facts);
  if (normalizedAnswer.length < 20) return false;
  const answerWords  = normalizedAnswer.split(' ');
  const matchingWords = answerWords.filter(w => w.length > 4 && normalizedFacts.includes(w)).length;
  const similarity = matchingWords / answerWords.length;
  return similarity > 0.70;
}

// ── Trivial non-answer detection — for fast-path short-circuit ──
// Returns true if the answer is obviously too brief or is a pure copy of the
// question text. Used by runEvalJob to skip the Haiku call entirely —
// these answers always score 0 regardless of AI evaluation, so we save
// ~5 seconds per submission and an API round-trip.
function isTrivialNonAnswer(studentAnswer, questionText) {
  if (!studentAnswer) return true;
  const trimmed = studentAnswer.trim();
  if (trimmed.length < 20) return true;

  // Answer is >90% contained in the question text (pure copy of question)
  if (questionText && questionText.length > 30) {
    const normalize = (t) => t.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const a = normalize(trimmed);
    const q = normalize(questionText);
    if (a.length > 20 && q.includes(a) && a.length / q.length > 0.3) return true;
  }

  return false;
}

function getAlternatives(item) {
  const alts = [];
  for (let i = 1; i <= 5; i++) {
    const altText = item[`alternativeAnswer${i}`] || item[`alternative_answer_${i}`];
    const altAlac = item[`alternativeAlac${i}`]   || item[`alternative_alac_${i}`];
    if (altAlac) {
      alts.push({ index: i, text: (altText || '').trim(), alac: altAlac });
    }
  }
  return alts;
}

const GRADE_SCALE = `Assign grade based on numericScore (passing score is 7.0/10):
  Excellent:          8.5 and above
  Good:               7.0 to 8.4  ← passing starts here
  Satisfactory:       5.5 to 6.9
  Needs Improvement:  4.0 to 5.4
  Poor:               below 4.0`;

module.exports = { detectQuestionType, isCopyPastedFacts, isTrivialNonAnswer, getAlternatives, GRADE_SCALE };
