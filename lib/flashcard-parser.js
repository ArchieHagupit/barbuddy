// Flashcard TXT parser — Session 2.2.
//
// Parses the strict card-file format into a structured { cards, errors, stats }.
// Pure function: no DB writes, no file I/O, no external calls.
// Unit-testable in isolation.
//
// Format reference: see README / Download Template output.

module.exports = { parseFlashcardTxt, normalizeTopicPath };

// Normalize a topic path string for case/whitespace-tolerant matching.
// Lowercase, collapse whitespace, unify " > " separator.
function normalizeTopicPath(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s*>\s*/g, ' > ')     // unify separators
    .replace(/\s+/g, ' ')           // collapse whitespace
    .replace(/[.,;:]+$/g, '')       // strip trailing punctuation
    .trim();
}

/**
 * Parse flashcard .txt content.
 *
 * @param {string} text  Raw file contents.
 * @param {Array<{nodeId: string, pathLabel: string, title: string}>} availableLeaves
 *   Leaf topics for the target subject. Used for topic-path validation.
 * @param {string} expectedSubject  The subject key this file must declare.
 * @returns {{
 *   cards: Array<{nodeId, nodePath, card_type, front, back, source_snippet, lineStart}>,
 *   errors: Array<{line, message, severity}>,
 *   stats: { totalCards, topicsCovered, topicsUnmatched, linesProcessed, declaredSubject },
 * }}
 */
function parseFlashcardTxt(text, availableLeaves, expectedSubject) {
  const lines = String(text || '').split(/\r?\n/);
  const errors = [];
  const cards = [];

  // Build a lookup from normalized path -> leaf info
  const leafIndex = new Map();
  for (const leaf of (availableLeaves || [])) {
    leafIndex.set(normalizeTopicPath(leaf.pathLabel), leaf);
  }

  let declaredSubject = null;
  let sawSubjectDeclaration = false;

  let currentTopic = null;
  const topicsMatched = new Set();
  const topicsUnmatched = new Set();

  let currentCard = null;
  let pendingFieldName = null;
  let pendingFieldBuf = [];

  function flushPendingField() {
    if (pendingFieldName && currentCard) {
      const val = pendingFieldBuf.join('\n').trim();
      currentCard[pendingFieldName] = val;
    }
    pendingFieldName = null;
    pendingFieldBuf = [];
  }

  function commitCurrentCard() {
    flushPendingField();
    if (!currentCard) return;
    if (!currentTopic) {
      errors.push({ line: currentCard.lineStart, message: 'Card has no enclosing topic', severity: 'error' });
      currentCard = null;
      return;
    }
    const validTypes = ['definition', 'elements', 'distinction'];
    const cardType = String(currentCard.type || '').toLowerCase().trim();
    if (!validTypes.includes(cardType)) {
      errors.push({ line: currentCard.lineStart, message: `Invalid TYPE "${currentCard.type || '(missing)'}" — must be one of: ${validTypes.join(', ')}`, severity: 'error' });
      currentCard = null;
      return;
    }
    const front = String(currentCard.front || '').trim();
    const back = String(currentCard.back || '').trim();
    if (!front) {
      errors.push({ line: currentCard.lineStart, message: 'FRONT is empty or missing', severity: 'error' });
      currentCard = null;
      return;
    }
    if (!back) {
      errors.push({ line: currentCard.lineStart, message: 'BACK is empty or missing', severity: 'error' });
      currentCard = null;
      return;
    }
    if (front.length > 2000) {
      errors.push({ line: currentCard.lineStart, message: `FRONT exceeds 2000 chars (got ${front.length})`, severity: 'error' });
      currentCard = null;
      return;
    }
    if (back.length > 5000) {
      errors.push({ line: currentCard.lineStart, message: `BACK exceeds 5000 chars (got ${back.length})`, severity: 'error' });
      currentCard = null;
      return;
    }
    cards.push({
      nodeId: currentTopic.nodeId,
      nodePath: currentTopic.pathLabel,
      card_type: cardType,
      front,
      back,
      source_snippet: String(currentCard.source || '').trim() || null,
      lineStart: currentCard.lineStart,
    });
    currentCard = null;
  }

  const FIELD_RE = /^(TYPE|FRONT|BACK|SOURCE)\s*:(.*)$/i;
  const TOPIC_RE = /^##\s*TOPIC\s*:\s*(.+)$/i;
  const SUBJECT_RE = /^#\s*SUBJECT\s*:\s*(.+)$/i;
  const CARD_SEP_RE = /^-{3,}\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw = lines[i];
    const stripped = raw.trim();

    // Empty line — only meaningful as field separator if we're mid-field
    if (!stripped) {
      if (pendingFieldName) pendingFieldBuf.push('');
      continue;
    }

    // Subject declaration (must be checked BEFORE generic # comment)
    const subjectM = stripped.match(SUBJECT_RE);
    if (subjectM) {
      declaredSubject = subjectM[1].trim().toLowerCase();
      sawSubjectDeclaration = true;
      if (expectedSubject && declaredSubject !== String(expectedSubject).toLowerCase()) {
        errors.push({
          line: lineNum,
          message: `File declares SUBJECT "${declaredSubject}" but was uploaded for "${expectedSubject}". Fix the header or upload to the correct subject.`,
          severity: 'fatal',
        });
      }
      continue;
    }

    // Topic header (## TOPIC:)
    const topicM = stripped.match(TOPIC_RE);
    if (topicM) {
      commitCurrentCard();
      const pathRaw = topicM[1].trim();
      const normalized = normalizeTopicPath(pathRaw);
      const leaf = leafIndex.get(normalized);
      if (leaf) {
        currentTopic = { nodeId: leaf.nodeId, pathLabel: leaf.pathLabel, rawPathLine: lineNum };
        topicsMatched.add(leaf.nodeId);
      } else {
        currentTopic = null;
        topicsUnmatched.add(pathRaw);
        errors.push({
          line: lineNum,
          message: `Topic path did not match any syllabus leaf: "${pathRaw}". Cards under this topic will be skipped.`,
          severity: 'error',
        });
      }
      continue;
    }

    // Comments (single # not ##, or // )
    // Must come AFTER subject + topic checks since both start with #.
    if (stripped.startsWith('//') || (stripped.startsWith('#') && !stripped.startsWith('##'))) {
      continue;
    }

    // Card separator
    if (CARD_SEP_RE.test(stripped)) {
      commitCurrentCard();
      if (!currentTopic) {
        errors.push({ line: lineNum, message: 'Card separator "---" before any topic header', severity: 'error' });
      }
      currentCard = { type: null, front: null, back: null, source: null, lineStart: lineNum };
      pendingFieldName = null;
      pendingFieldBuf = [];
      continue;
    }

    // Field line (TYPE/FRONT/BACK/SOURCE)
    const fieldM = stripped.match(FIELD_RE);
    if (fieldM && currentCard) {
      flushPendingField();
      const fieldName = fieldM[1].toUpperCase();
      const firstLineValue = fieldM[2].replace(/^[ \t]/, '');
      pendingFieldName = ({
        TYPE: 'type',
        FRONT: 'front',
        BACK: 'back',
        SOURCE: 'source',
      })[fieldName];
      pendingFieldBuf = firstLineValue ? [firstLineValue] : [];
      continue;
    }

    // Continuation of current field value, or orphan line
    if (pendingFieldName && currentCard) {
      pendingFieldBuf.push(raw);
      continue;
    }

    // Orphan line — not inside any field. Warn if not inside a topic at all.
    if (!currentTopic && sawSubjectDeclaration) {
      errors.push({
        line: lineNum,
        message: `Unexpected content outside any topic or card: "${stripped.slice(0, 60)}${stripped.length > 60 ? '…' : ''}"`,
        severity: 'warning',
      });
    }
  }

  // Commit final card
  commitCurrentCard();

  if (!sawSubjectDeclaration) {
    errors.unshift({
      line: 1,
      message: 'File is missing the "# SUBJECT: <key>" header on the first non-comment line.',
      severity: 'fatal',
    });
  }

  return {
    cards,
    errors,
    stats: {
      totalCards: cards.length,
      topicsCovered: topicsMatched.size,
      topicsUnmatched: topicsUnmatched.size,
      linesProcessed: lines.length,
      declaredSubject,
    },
  };
}
