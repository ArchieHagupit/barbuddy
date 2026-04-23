// Flashcard generation engine — Haiku + per-topic chunking, subject-level source,
// per-topic card batches. Session 2.1 implementation.
//
// Architecture (Session 2.1 — chunked):
//   - Caller passes { subject, runId, onProgress }.
//   - Engine loads all sources for subject, parses each into a chunk tree
//     using heading detection (Rule / Subsection / Numbered / Section).
//   - Engine iterates leaf topics serially.
//   - Per topic: SELECT relevant chunks using rule-anchor match, then
//     keyword fallback, then parent-section fallback, then unstructured
//     source fallback. Hard cap of 120K tokens per call.
//   - Call Haiku with ONLY the selected context (not the full source bundle).
//   - Parse response, validate card shape, insert batch to flashcards table
//     with enabled=false.
//   - Report progress via onProgress callback after each topic.
//
// Why chunking:
//   Session 2.0 sent the full concatenated source bundle to every Haiku call.
//   For large subjects (e.g., Remedial Law ~200K tokens), this exceeded
//   Haiku's 200K context window and every topic failed. Session 2.1 sends
//   only the relevant portion per topic (typically 5-60K tokens).
//
// Caching tradeoff:
//   Source-content caching is disabled in Session 2.1 because chunks vary
//   per topic. The system prompt alone is too short to cache (below Haiku's
//   4096-token minimum). Per-call cost is higher but generation actually
//   completes. A future session can add a grouped-caching optimization.
//
// Constraints:
//   - Claude's card_type enum: 'definition' | 'elements' | 'distinction'.
//   - Invalid card types from AI are dropped with a warning (not thrown).
//   - Per-call context capped at 120K tokens (leaves ~80K headroom).

const fs = require('fs');
const path = require('path');
const { supabase } = require('../config/supabase');

module.exports = function createFlashcardGen({
  API_KEY, KB, aiSemaphore, SYLLABUS_FLASHCARD_DIR,
  extractJSON, sanitizeAIResponse,
}) {
  // Rough token estimator — 1 token ≈ 4 chars for English text.
  // Precise counting happens server-side by Anthropic.
  const estimateTokens = (text) => Math.ceil((text || '').length / 4);

  // Extract text from a PDF source at generation time (not upload).
  // Uses pdf-parse (lazy-loaded, same pattern as /api/admin/parse-file).
  async function extractPdfText(fileId) {
    try {
      const pdfParse = require('pdf-parse');
      const filePath = path.join(SYLLABUS_FLASHCARD_DIR, fileId);
      if (!fs.existsSync(filePath)) {
        console.warn(`[flashcard-gen] PDF file missing: ${fileId}`);
        return null;
      }
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      return (data.text || '').trim();
    } catch(e) {
      console.warn(`[flashcard-gen] PDF extract failed for ${fileId}:`, e.message);
      return null;
    }
  }

  // Parse one source's text into a structured chunk tree.
  // Returns an array of top-level chunks (Rules) with nested children.
  //
  // Heading detection is resilient to minor variations:
  //   - Level 1: "Rule N ..." (primary) or Roman-numeral headings as fallback
  //   - Level 2: "A. TITLE", "B. TITLE" (single capital + dot)
  //   - Level 3: "1. Title", "2. Title" (digit + dot, Title Case)
  //   - Level 4: "Section N. ..." (leaves, with full content attached)
  //
  // Ambiguous lines (e.g. "1. Best Evidence Rule" that could be content
  // or heading) are resolved by context — if we just saw a Section header,
  // we're inside section content; otherwise it's a level-3 heading.
  function parseSourceIntoChunks(text, sourceName, sourceId) {
    const lines = text.split('\n');
    const rootChunks = [];

    const RULE_RE       = /^Rule\s+(\d+[A-Za-z]?)\s+(.+)$/;
    const ROMAN_RE      = /^([IVX]+)\.\s+([A-Z][A-Z\s]{2,})$/;
    const SUBSECTION_RE = /^([A-Z])\.\s+([A-Z(][^.]{3,120})$/;
    const NUMBERED_RE   = /^(\d+)\.\s+([A-Z][a-zA-Z].{3,120})$/;
    const SECTION_RE    = /^Section\s+(\d+)\.\s*(.*)$/;

    let currentRule = null;
    let currentSub = null;
    let currentNum = null;
    let currentSection = null;
    let inSectionContent = false;

    function flushSection() {
      if (currentSection) {
        currentSection.text = (currentSection.textBuf || []).join('\n').trim();
        delete currentSection.textBuf;
        currentSection.tokens = estimateTokens(currentSection.text);
        currentSection = null;
      }
    }

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, '');
      if (!line.trim()) {
        if (currentSection) currentSection.textBuf.push('');
        continue;
      }

      // Level 1 — Rule heading
      const ruleM = line.match(RULE_RE);
      if (ruleM) {
        flushSection();
        currentSection = null;
        currentSub = null;
        currentNum = null;
        inSectionContent = false;
        currentRule = {
          heading: line,
          rulePrefix: `Rule ${ruleM[1]}`,
          title: ruleM[2],
          level: 1,
          subheading: ruleM[1],
          text: '',
          tokens: 0,
          children: [],
          sourceName,
          sourceId,
        };
        rootChunks.push(currentRule);
        continue;
      }

      // Fallback level 1 — Roman numeral heading (only if no Rule seen yet)
      const romanM = line.match(ROMAN_RE);
      if (romanM && !currentRule) {
        flushSection();
        currentSection = null;
        currentSub = null;
        currentNum = null;
        inSectionContent = false;
        currentRule = {
          heading: line,
          rulePrefix: romanM[1],
          title: romanM[2],
          level: 1,
          subheading: romanM[1],
          text: '',
          tokens: 0,
          children: [],
          sourceName,
          sourceId,
        };
        rootChunks.push(currentRule);
        continue;
      }

      // Level 2 — Subsection (inside a Rule, not inside section content)
      const subM = line.match(SUBSECTION_RE);
      if (subM && currentRule && !inSectionContent && line.length < 120) {
        flushSection();
        currentSection = null;
        currentNum = null;
        currentSub = {
          heading: line,
          rulePrefix: currentRule.rulePrefix,
          title: subM[2],
          level: 2,
          subheading: subM[1],
          text: '',
          tokens: 0,
          children: [],
          sourceName,
          sourceId,
        };
        currentRule.children.push(currentSub);
        continue;
      }

      // Level 3 — Numbered topic
      const numM = line.match(NUMBERED_RE);
      if (numM && currentRule && !inSectionContent && line.length < 120) {
        flushSection();
        currentSection = null;
        currentNum = {
          heading: line,
          rulePrefix: currentRule.rulePrefix,
          title: numM[2],
          level: 3,
          subheading: numM[1],
          text: '',
          tokens: 0,
          children: [],
          sourceName,
          sourceId,
        };
        const parent = currentSub || currentRule;
        parent.children.push(currentNum);
        continue;
      }

      // Level 4 — Section entry (leaf)
      const secM = line.match(SECTION_RE);
      if (secM && currentRule) {
        flushSection();
        currentSection = {
          heading: line.slice(0, 120),
          rulePrefix: currentRule.rulePrefix,
          title: secM[2] || `Section ${secM[1]}`,
          level: 4,
          subheading: secM[1],
          text: '',
          textBuf: [line],
          tokens: 0,
          children: [],
          sourceName,
          sourceId,
        };
        const parent = currentNum || currentSub || currentRule;
        parent.children.push(currentSection);
        inSectionContent = true;
        continue;
      }

      // Content line — accumulate into current section (or rule if no section)
      if (currentSection) {
        currentSection.textBuf.push(line);
      } else if (currentRule) {
        currentRule.text = (currentRule.text ? currentRule.text + '\n' : '') + line;
      }
    }
    flushSection();

    // Finalize aggregate token counts by summing descendants
    function sumTokens(node) {
      let total = estimateTokens(node.text);
      for (const child of node.children) total += sumTokens(child);
      node.tokens = total;
      return total;
    }
    for (const r of rootChunks) sumTokens(r);

    return rootChunks;
  }

  // Load all sources for a subject, parse into chunk trees.
  // Returns { chunkTrees, unstructuredFallbacks, sourceIds, totalTokens, hasStructure }.
  async function buildSourceChunks(subject) {
    const { data: sources, error } = await supabase
      .from('flashcard_sources')
      .select('id, source_type, name, file_id, text_content, size_bytes')
      .eq('subject', subject)
      .order('uploaded_at', { ascending: true });
    if (error) throw new Error('Failed to load sources: ' + error.message);
    if (!sources || !sources.length) throw new Error('No sources uploaded for this subject');

    const chunkTrees = [];
    const sourceIds = [];
    let totalTokens = 0;
    let hasStructure = false;
    const unstructuredFallbacks = [];

    for (const src of sources) {
      sourceIds.push(src.id);
      let text = '';
      if (src.source_type === 'text') {
        text = (src.text_content || '').trim();
      } else if (src.source_type === 'pdf' && src.file_id) {
        text = await extractPdfText(src.file_id);
        if (!text) {
          console.warn(`[flashcard-gen] PDF extract failed: ${src.name}`);
          continue;
        }
      }
      if (!text) continue;

      const chunks = parseSourceIntoChunks(text, src.name, src.id);
      if (chunks.length > 0) {
        chunkTrees.push({ sourceId: src.id, sourceName: src.name, chunks });
        hasStructure = true;
        for (const c of chunks) totalTokens += c.tokens;
      } else {
        console.warn(`[flashcard-gen] No headings detected in source: ${src.name} (${estimateTokens(text)} tokens) — using flat fallback`);
        unstructuredFallbacks.push({
          sourceId: src.id,
          sourceName: src.name,
          text,
          tokens: estimateTokens(text),
        });
        totalTokens += estimateTokens(text);
      }
    }

    return { chunkTrees, unstructuredFallbacks, sourceIds, totalTokens, hasStructure };
  }

  // Leaf-topic walker — same logic as routes/flashcards.js collectLeafTopics
  // (duplicated here to avoid circular import; small enough to tolerate).
  function collectLeafTopics(sections) {
    const leaves = [];
    function fmt(node) {
      const label = node.label ? String(node.label).trim() : '';
      const title = node.title ? String(node.title).trim() : '';
      if (label && title) return `${label}. ${title}`;
      return title || label || '';
    }
    function walk(nodes, ancestry) {
      for (const node of (nodes || [])) {
        const nextAncestry = ancestry.concat(fmt(node));
        const children = node.children || [];
        const hasChildren = children.some(c => c);
        if (node.type === 'section') walk(children, nextAncestry);
        else if (hasChildren) walk(children, nextAncestry);
        else leaves.push({
          nodeId: node.id,
          title: node.title || node.label || '',
          pathLabel: nextAncestry.join(' > '),
        });
      }
    }
    walk(sections || [], []);
    return leaves;
  }

  // Extract keywords from a path segment for fallback matching.
  function extractKeywords(text) {
    const stopwords = new Set(['the','of','a','an','and','or','in','on','for','to','with','by','from','at','as','is','are','be','its','vs','v','under','over']);
    return String(text).toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !stopwords.has(w));
  }

  // Walk a chunk tree and yield all level-3+4 chunks plus their ancestry string.
  function* iterLeafChunks(rootChunks) {
    function* walk(node, ancestry) {
      if (node.level >= 3 && node.text) {
        yield { chunk: node, ancestry: ancestry.slice() };
      }
      for (const child of node.children) {
        yield* walk(child, ancestry.concat(child.heading));
      }
    }
    for (const root of rootChunks) {
      yield* walk(root, [root.heading]);
    }
  }

  // Render a chunk and all its descendants as plain text, preserving headings.
  function renderChunkSubtree(node) {
    let out = node.heading;
    if (node.text) out += '\n' + node.text;
    for (const child of node.children) {
      out += '\n\n' + renderChunkSubtree(child);
    }
    return out;
  }

  // Greedy truncation: take items from a parts[] array until token budget is hit.
  function truncateToTokens(parts, maxTokens) {
    const out = [];
    let tokens = 0;
    for (const p of parts) {
      const t = estimateTokens(p);
      if (tokens + t > maxTokens) break;
      out.push(p);
      tokens += t;
    }
    return { text: out.join('\n\n'), tokens, count: out.length };
  }

  // Select chunks relevant to a given topic.
  // Returns { text, tokens, method, chunkCount }.
  function selectChunksForTopic(topic, chunkTrees, unstructuredFallbacks) {
    const MAX_CONTEXT_TOKENS = 120_000;

    // Strategy 1: Rule anchor match
    const ruleMatch = topic.pathLabel.match(/Rule\s+(\d+[A-Za-z]?)/);
    if (ruleMatch) {
      const anchor = `Rule ${ruleMatch[1]}`;
      const matched = [];
      for (const tree of chunkTrees) {
        for (const rule of tree.chunks) {
          if (rule.rulePrefix === anchor) matched.push(rule);
        }
      }
      if (matched.length > 0) {
        const parts = matched.map(r => renderChunkSubtree(r));
        const joined = parts.join('\n\n');
        const tokens = estimateTokens(joined);
        if (tokens <= MAX_CONTEXT_TOKENS) {
          return { text: joined, tokens, method: 'rule_anchor', chunkCount: matched.length };
        }
        const truncated = truncateToTokens(parts, MAX_CONTEXT_TOKENS);
        return { text: truncated.text, tokens: truncated.tokens, method: 'rule_anchor_truncated', chunkCount: truncated.count };
      }
    }

    // Strategy 2: Keyword fallback across level-3+ chunks
    const segments = topic.pathLabel.split(' > ');
    const lastTwo = segments.slice(-2).join(' ');
    const keywords = extractKeywords(lastTwo);
    if (keywords.length > 0) {
      const scored = [];
      for (const { chunk, ancestry } of iterLeafChunks(chunkTrees.flatMap(t => t.chunks))) {
        const hay = (chunk.heading + ' ' + chunk.text).toLowerCase();
        let score = 0;
        for (const kw of keywords) {
          if (hay.includes(kw)) score++;
        }
        if (score > 0) scored.push({ chunk, ancestry, score });
      }
      scored.sort((a, b) => b.score - a.score);
      if (scored.length > 0) {
        const chosen = [];
        let cumTokens = 0;
        for (const s of scored) {
          if (cumTokens + s.chunk.tokens > MAX_CONTEXT_TOKENS) break;
          chosen.push(s);
          cumTokens += s.chunk.tokens;
        }
        if (chosen.length > 0) {
          const parts = chosen.map(c => `${c.ancestry.join(' → ')}\n${c.chunk.text}`);
          return {
            text: parts.join('\n\n'),
            tokens: cumTokens,
            method: 'keyword_fallback',
            chunkCount: chosen.length,
          };
        }
      }
    }

    // Strategy 3: Parent-section fallback — first syllabus segment vs Rule titles
    const firstSegment = segments[0] || '';
    const parentKeywords = extractKeywords(firstSegment);
    if (parentKeywords.length > 0) {
      const matchedRules = [];
      for (const tree of chunkTrees) {
        for (const rule of tree.chunks) {
          const hay = (rule.heading + ' ' + rule.title).toLowerCase();
          if (parentKeywords.some(k => hay.includes(k))) matchedRules.push(rule);
        }
      }
      if (matchedRules.length > 0) {
        const parts = matchedRules.map(r => renderChunkSubtree(r));
        const truncated = truncateToTokens(parts, MAX_CONTEXT_TOKENS);
        return {
          text: truncated.text,
          tokens: truncated.tokens,
          method: 'parent_fallback',
          chunkCount: truncated.count,
        };
      }
    }

    // Strategy 4: Unstructured source fallback
    if (unstructuredFallbacks.length > 0) {
      const parts = [];
      let cumTokens = 0;
      for (const src of unstructuredFallbacks) {
        if (cumTokens + src.tokens > MAX_CONTEXT_TOKENS) {
          const ratio = (MAX_CONTEXT_TOKENS - cumTokens) / src.tokens;
          const cutoff = Math.floor(src.text.length * ratio);
          parts.push(`=== SOURCE: ${src.sourceName} (partial) ===\n${src.text.slice(0, cutoff)}`);
          cumTokens = MAX_CONTEXT_TOKENS;
          break;
        }
        parts.push(`=== SOURCE: ${src.sourceName} ===\n${src.text}`);
        cumTokens += src.tokens;
      }
      return {
        text: parts.join('\n\n'),
        tokens: cumTokens,
        method: 'unstructured_fallback',
        chunkCount: parts.length,
      };
    }

    return { text: '', tokens: 0, method: 'no_match', chunkCount: 0 };
  }

  const SYSTEM_PROMPT = `You are a Philippine Bar Exam flashcard generator. Generate high-quality flashcards from the provided source material for law students preparing for the Philippine Bar.

Card types you may produce:
- "definition": Front asks for the definition of a legal term; back gives the precise definition.
- "elements": Front asks for the elements/requisites of a legal concept; back lists them clearly numbered.
- "distinction": Front asks to distinguish between two related legal concepts; back provides the distinction.

Rules:
- Generate 10–20 cards per topic. Lean toward fewer cards for narrow topics, more for dense topics. Maximum 25.
- Use ONLY information present in the source material. Do NOT invent doctrine, cases, or article numbers.
- If a card type doesn't fit the topic naturally, skip it. Don't force distinctions on topics that have none.
- Cards must be self-contained: the back must fully answer the front without external context.
- Backs should cite the specific article number, case name, or doctrine from the source when possible.
- If the source material does NOT adequately cover this topic, return { "cards": [], "flag": "insufficient_source", "reason": "brief explanation" }.

Output format: valid JSON only. No markdown fences. No preamble.`;

  // Call Haiku with topic-specific context. Returns parsed JSON or null on hard failure.
  async function generateCardsForTopic(contextText, topic) {
    const sourceBlock = `\n\nSOURCE MATERIAL (relevant chunks for this topic):\n${contextText}`;

    const topicPrompt = `Generate flashcards for this topic from the source material above:

Topic: ${topic.pathLabel}
Leaf: ${topic.title}

Return JSON in this exact shape:
{
  "cards": [
    {
      "card_type": "definition" | "elements" | "distinction",
      "front": "The question/prompt side",
      "back": "The answer side — complete and self-contained",
      "source_snippet": "The key sentence or two from the source that supports this card (1-3 sentences max)"
    }
  ]
}

If source material is insufficient for this topic, return:
{ "cards": [], "flag": "insufficient_source", "reason": "explanation" }`;

    // Session 2.1: no source-content caching since chunks vary per topic.
    // System prompt alone is too short for Haiku's 4096-token cache minimum.
    const systemBlocks = [
      { type: 'text', text: SYSTEM_PROMPT },
      { type: 'text', text: sourceBlock },
    ];

    await aiSemaphore.acquire();
    try {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        temperature: 0,
        system: systemBlocks,
        messages: [{ role: 'user', content: topicPrompt }],
      });

      for (let attempt = 1; attempt <= 3; attempt++) {
        let r, d;
        try {
          r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': API_KEY,
              'anthropic-version': '2023-06-01',
              // Harmless if kept — no longer strictly needed in 2.1 since
              // we're not using 1-hour cache TTL on source content.
              'anthropic-beta': 'extended-cache-ttl-2025-04-11',
            },
            body,
            signal: AbortSignal.timeout(60000),
          });
          d = await r.json();
        } catch(e) {
          if (attempt < 3) { await sleep(attempt * 2000); continue; }
          throw e;
        }
        if (r.status === 529 || r.status === 429 || d?.error?.type === 'overloaded_error') {
          if (attempt < 3) { await sleep(attempt * 5000); continue; }
          throw new Error('Haiku overloaded after retries');
        }
        if (d.error) throw new Error(d.error.message);

        if (d.usage) {
          const cw = d.usage.cache_creation_input_tokens || 0;
          const cr = d.usage.cache_read_input_tokens || 0;
          console.log(`[flashcard-gen] ${topic.pathLabel.slice(0,60)}… | in:${d.usage.input_tokens} cache_read:${cr} cache_write:${cw} out:${d.usage.output_tokens}`);
        }

        const raw = sanitizeAIResponse(d.content.map(c => c.text || '').join(''));
        const parsed = extractJSON(raw);
        if (parsed !== null) return parsed;
        if (attempt < 3) await sleep(1500);
      }
      return null;
    } finally {
      aiSemaphore.release();
    }
  }

  // Validate and normalize a card from Claude's output.
  // Returns null if invalid (dropped with warning).
  function normalizeCard(raw, subject, nodeId, nodePath, batchId, sourceIds) {
    if (!raw || typeof raw !== 'object') return null;
    const validTypes = ['definition', 'elements', 'distinction'];
    const card_type = String(raw.card_type || '').toLowerCase().trim();
    if (!validTypes.includes(card_type)) return null;
    const front = String(raw.front || '').trim();
    const back  = String(raw.back  || '').trim();
    if (!front || !back) return null;
    if (front.length > 2000 || back.length > 5000) return null;
    return {
      id: 'fc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      subject,
      node_id: nodeId,
      node_path: nodePath,
      card_type,
      front,
      back,
      source_snippet: String(raw.source_snippet || '').trim().slice(0, 2000) || null,
      source_ids: sourceIds,
      generation_batch_id: batchId,
      enabled: false,
    };
  }

  // Main entry point — runs a full generation cycle for a subject.
  async function runGeneration({ subject, runId, onProgress }) {
    const batchId = 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

    // 1. Build source chunk trees
    onProgress({ phase: 'loading_sources' });
    const { chunkTrees, unstructuredFallbacks, sourceIds, totalTokens, hasStructure } =
      await buildSourceChunks(subject);
    console.log(`[flashcard-gen] Parsed sources: ${chunkTrees.length} structured, ${unstructuredFallbacks.length} unstructured, ~${totalTokens} total tokens, structure=${hasStructure}`);

    // 2. Get leaf topics from syllabus
    const sections = KB.syllabus?.subjects?.[subject]?.sections || [];
    const leaves = collectLeafTopics(sections);
    if (!leaves.length) throw new Error('No leaf topics in syllabus for this subject');

    onProgress({
      phase: 'generating',
      totalTopics: leaves.length,
      doneTopics: 0,
      cardsSoFar: 0,
      skippedTopics: 0,
      totalSourceTokens: totalTokens,
      structuredSources: chunkTrees.length,
      unstructuredSources: unstructuredFallbacks.length,
      batchId,
    });

    // 3. Iterate topics serially
    let doneTopics = 0, cardsSoFar = 0, skippedTopics = 0;
    const topicResults = [];

    for (const topic of leaves) {
      // Check for cancel signal (set by caller)
      if (global._flashcardGenRuns?.[runId]?.cancelled) {
        onProgress({ phase: 'cancelled', doneTopics, cardsSoFar, skippedTopics });
        return { batchId, doneTopics, cardsSoFar, skippedTopics, cancelled: true };
      }

      onProgress({ phase: 'generating', current: topic.pathLabel, doneTopics, cardsSoFar, skippedTopics, totalTopics: leaves.length });

      try {
        const selection = selectChunksForTopic(topic, chunkTrees, unstructuredFallbacks);
        console.log(`[flashcard-gen] ${topic.pathLabel.slice(0,70)}… | match=${selection.method} chunks=${selection.chunkCount} ctx_tokens=${selection.tokens}`);

        if (selection.tokens === 0) {
          topicResults.push({ topic: topic.pathLabel, ok: false, reason: 'no_source_match' });
          skippedTopics++;
          doneTopics++;
          onProgress({ phase: 'generating', current: topic.pathLabel, doneTopics, cardsSoFar, skippedTopics, totalTopics: leaves.length });
          continue;
        }

        const result = await generateCardsForTopic(selection.text, topic);
        if (!result) {
          console.warn(`[flashcard-gen] Topic parse failed: ${topic.pathLabel}`);
          topicResults.push({ topic: topic.pathLabel, ok: false, reason: 'parse_failed' });
          skippedTopics++;
          doneTopics++;
          continue;
        }
        if (result.flag === 'insufficient_source') {
          console.log(`[flashcard-gen] Insufficient source for: ${topic.pathLabel}`);
          topicResults.push({ topic: topic.pathLabel, ok: false, reason: 'insufficient_source', detail: result.reason });
          skippedTopics++;
          doneTopics++;
          continue;
        }
        const rawCards = Array.isArray(result.cards) ? result.cards : [];
        const cards = rawCards
          .slice(0, 25)
          .map(c => normalizeCard(c, subject, topic.nodeId, topic.pathLabel, batchId, sourceIds))
          .filter(Boolean);

        if (cards.length > 0) {
          const { error: insErr } = await supabase.from('flashcards').insert(cards);
          if (insErr) {
            console.error(`[flashcard-gen] Insert failed for ${topic.pathLabel}:`, insErr.message);
            topicResults.push({ topic: topic.pathLabel, ok: false, reason: 'insert_failed' });
            skippedTopics++;
          } else {
            cardsSoFar += cards.length;
            topicResults.push({ topic: topic.pathLabel, ok: true, cardCount: cards.length });
          }
        } else {
          topicResults.push({ topic: topic.pathLabel, ok: false, reason: 'no_valid_cards' });
          skippedTopics++;
        }
      } catch(e) {
        console.error(`[flashcard-gen] Error on ${topic.pathLabel}:`, e.message);
        topicResults.push({ topic: topic.pathLabel, ok: false, reason: 'error', detail: e.message });
        skippedTopics++;
      }

      doneTopics++;
      onProgress({ phase: 'generating', current: topic.pathLabel, doneTopics, cardsSoFar, skippedTopics, totalTopics: leaves.length });
    }

    onProgress({ phase: 'done', doneTopics, cardsSoFar, skippedTopics, totalTopics: leaves.length, batchId, results: topicResults });
    return { batchId, doneTopics, cardsSoFar, skippedTopics, results: topicResults };
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return { runGeneration };
};
