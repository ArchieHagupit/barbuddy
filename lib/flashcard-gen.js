// Flashcard generation engine — Haiku + prompt caching, subject-level source,
// per-topic card batches. Session 2 implementation.
//
// Architecture:
//   - Caller passes { subject, runId, onProgress }.
//   - Engine fetches sources for subject, concatenates to one text bundle.
//   - Engine iterates leaf topics (from KB.syllabus) serially.
//   - Per topic: call Haiku with cached source bundle + topic-specific prompt.
//   - Parse response, validate card shape, insert batch to flashcards table
//     with enabled=false.
//   - Report progress via onProgress callback after each topic.
//
// Prompt caching:
//   - System prompt + source bundle marked with cache_control (1-hour TTL).
//   - Topic-specific instruction after the cache breakpoint (in messages[]).
//   - First topic writes cache (~1.25x input price).
//   - All subsequent topics hit cache (~0.1x input price).
//
// Constraints:
//   - Haiku requires 4,096+ tokens for caching. Below that, cache is skipped.
//   - Claude's card_type enum: 'definition' | 'elements' | 'distinction'.
//   - Invalid card types from AI are dropped with a warning (not thrown).

const fs = require('fs');
const path = require('path');
const { supabase } = require('../config/supabase');

module.exports = function createFlashcardGen({
  API_KEY, KB, aiSemaphore, SYLLABUS_FLASHCARD_DIR,
  extractJSON, sanitizeAIResponse,
}) {
  // Rough token estimator — 1 token ≈ 4 chars for English text.
  // Used only for the 4096-token cache threshold check; precise counting
  // happens server-side by Anthropic.
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

  // Build subject-level source bundle by concatenating all sources.
  // PDFs are extracted to text at this point (one-time cost per run).
  async function buildSourceBundle(subject) {
    const { data: sources, error } = await supabase
      .from('flashcard_sources')
      .select('id, source_type, name, file_id, text_content, size_bytes')
      .eq('subject', subject)
      .order('uploaded_at', { ascending: true });
    if (error) throw new Error('Failed to load sources: ' + error.message);
    if (!sources || !sources.length) throw new Error('No sources uploaded for this subject');

    const parts = [];
    const sourceIds = [];
    for (const src of sources) {
      sourceIds.push(src.id);
      let text = '';
      if (src.source_type === 'text') {
        text = (src.text_content || '').trim();
      } else if (src.source_type === 'pdf' && src.file_id) {
        text = await extractPdfText(src.file_id);
        if (!text) {
          parts.push(`=== SOURCE: ${src.name} (PDF) ===\n[Extraction failed — skipping]`);
          continue;
        }
      }
      if (text) {
        parts.push(`=== SOURCE: ${src.name} (${src.source_type.toUpperCase()}) ===\n${text}`);
      }
    }
    return { bundle: parts.join('\n\n'), sourceIds };
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

  // Call Haiku with cached source bundle + topic-specific instruction.
  // Returns parsed JSON or null on hard failure.
  async function generateCardsForTopic(sourceBundle, topic, shouldCache) {
    const cacheSuffix = `\n\nSOURCE MATERIAL:\n${sourceBundle}`;

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

    // Build system content blocks. If caching, mark the source bundle block.
    // The cache breakpoint is at the END of the system block so everything
    // before it is cached; the user-message topic prompt is the uncached suffix.
    const systemBlocks = [{ type: 'text', text: SYSTEM_PROMPT }];
    if (shouldCache) {
      systemBlocks.push({
        type: 'text',
        text: cacheSuffix,
        cache_control: { type: 'ephemeral', ttl: '1h' },
      });
    } else {
      systemBlocks.push({ type: 'text', text: cacheSuffix });
    }

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
              // Opt into 1-hour cache TTL beta header
              'anthropic-beta': 'extended-cache-ttl-2025-04-11',
            },
            body,
            signal: AbortSignal.timeout(60000), // 60s — generation can be slow
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

        // Log cache performance
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
  // Designed to be called from a route handler in fire-and-forget style.
  // onProgress fires after each topic completes.
  async function runGeneration({ subject, runId, onProgress }) {
    const batchId = 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

    // 1. Build source bundle
    onProgress({ phase: 'loading_sources' });
    const { bundle, sourceIds } = await buildSourceBundle(subject);
    const bundleTokens = estimateTokens(bundle);
    const shouldCache = bundleTokens >= 4096;
    if (!shouldCache) {
      console.warn(`[flashcard-gen] Bundle is ~${bundleTokens} tokens — below Haiku 4096 cache minimum. Caching disabled.`);
    }

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
      bundleTokens,
      cached: shouldCache,
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

      onProgress({ phase: 'generating', current: topic.pathLabel, doneTopics, cardsSoFar, skippedTopics, totalTopics: leaves.length, cached: shouldCache });

      try {
        const result = await generateCardsForTopic(bundle, topic, shouldCache);
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
          .slice(0, 25) // hard cap
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
      onProgress({ phase: 'generating', current: topic.pathLabel, doneTopics, cardsSoFar, skippedTopics, totalTopics: leaves.length, cached: shouldCache });
    }

    onProgress({ phase: 'done', doneTopics, cardsSoFar, skippedTopics, totalTopics: leaves.length, batchId, results: topicResults });
    return { batchId, doneTopics, cardsSoFar, skippedTopics, results: topicResults };
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return { runGeneration };
};
