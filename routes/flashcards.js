// Flashcards routes — Session 2.2: .txt import-based authoring.
//
// Model: admin authors flashcards in a .txt file using a strict format,
// uploads it for preview, then commits to the DB. No AI generation.
// No PDF source upload — if committee needs reference PDFs they keep them
// local to their own machine.
//
// Routes:
//   GET  /api/admin/flashcards/status/:subject         — leaf topics + card counts
//   GET  /api/admin/flashcards/template/:subject       — download pre-filled .txt skeleton
//   POST /api/admin/flashcards/import/:subject         — upload .txt, parse, return preview
//   POST /api/admin/flashcards/import/:subject/commit  — commit previewed cards
//   GET  /api/admin/flashcards/cards/:subject/:nodeId  — list cards for a topic
//   PATCH /api/admin/flashcards/card/:cardId           — edit one card in-app
//   DELETE /api/admin/flashcards/card/:cardId          — delete one card
//
// Usage in server.js:
//   app.use(require('./routes/flashcards')({ requireAuth, adminOnly, KB }));

const express = require('express');
const multer = require('multer');
const { supabase } = require('../config/supabase');
const { getAllSubjectsWithSections } = require('../lib/syllabus-tree');
const { parseFlashcardTxt } = require('../lib/flashcard-parser');

module.exports = function createFlashcardRoutes({ requireAuth, adminOnly, KB }) {
  const router = express.Router();

  // In-memory upload — file stays in req.file.buffer. No disk writes.
  const txtUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    fileFilter: (_req, file, cb) => {
      const name = (file.originalname || '').toLowerCase();
      if (name.endsWith('.txt') || file.mimetype === 'text/plain') cb(null, true);
      else cb(new Error('Only .txt files are allowed'));
    },
  });

  // Walk syllabus and yield only leaf topics with pathLabel.
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

  // ── Route 1: Status — leaf topics + card counts ─────────────
  router.get('/api/admin/flashcards/status/:subject', adminOnly, async (req, res) => {
    try {
      const subj = req.params.subject;
      if (!getAllSubjectsWithSections().includes(subj)) {
        return res.status(400).json({ error: 'Invalid subject' });
      }
      const sections = KB.syllabus?.subjects?.[subj]?.sections || [];
      const leaves = collectLeafTopics(sections);

      let byNode = {};
      try {
        const { data: cards } = await supabase
          .from('flashcards')
          .select('node_id, enabled')
          .eq('subject', subj);
        for (const c of (cards || [])) {
          if (!byNode[c.node_id]) byNode[c.node_id] = { pending: 0, approved: 0 };
          if (c.enabled) byNode[c.node_id].approved += 1;
          else           byNode[c.node_id].pending  += 1;
        }
      } catch(_) {
        byNode = {};
      }

      let totalCards = 0;
      const topics = leaves.map(l => {
        const counts = byNode[l.nodeId] || { pending: 0, approved: 0 };
        const t = counts.pending + counts.approved;
        totalCards += t;
        return {
          nodeId: l.nodeId,
          title: l.title,
          pathLabel: l.pathLabel,
          cardCount: t,
        };
      });

      res.json({
        subject: subj,
        topics,
        totalSyllabusTopics: topics.length,
        totalCards,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 2: Download pre-filled .txt template ──────────────
  router.get('/api/admin/flashcards/template/:subject', adminOnly, (req, res) => {
    const subj = req.params.subject;
    if (!getAllSubjectsWithSections().includes(subj)) {
      return res.status(400).json({ error: 'Invalid subject' });
    }
    const sections = KB.syllabus?.subjects?.[subj]?.sections || [];
    const leaves = collectLeafTopics(sections);

    const lines = [];
    lines.push(`# SUBJECT: ${subj}`);
    lines.push(`# `);
    lines.push(`# Flashcards template for ${subj.toUpperCase()} — ${leaves.length} leaf topics.`);
    lines.push(`# Fill in cards under each topic. Lines starting with a single # or // are comments.`);
    lines.push(`# `);
    lines.push(`# Format per card (separator is three hyphens on its own line):`);
    lines.push(`#`);
    lines.push(`#   ---`);
    lines.push(`#   TYPE: definition | elements | distinction`);
    lines.push(`#   FRONT: <question>`);
    lines.push(`#   BACK: <answer, can span multiple lines>`);
    lines.push(`#   SOURCE: <optional citation, single line>`);
    lines.push(`#`);
    lines.push(`# Delete the "## TOPIC:" blocks you don't need. Keep the "# SUBJECT:" line at the top.`);
    lines.push(``);

    for (const leaf of leaves) {
      lines.push(`## TOPIC: ${leaf.pathLabel}`);
      lines.push(``);
      lines.push(`# (add cards here — uncomment and edit the example below)`);
      lines.push(`# ---`);
      lines.push(`# TYPE: definition`);
      lines.push(`# FRONT: `);
      lines.push(`# BACK: `);
      lines.push(`# SOURCE: `);
      lines.push(``);
    }

    const filename = `flashcards-${subj}-template.txt`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n'));
  });

  // ── Route 3: Import — upload .txt, parse, return preview ────
  // Does NOT write to DB. Returns { cards, errors, stats } for user review.
  router.post('/api/admin/flashcards/import/:subject', adminOnly, (req, res) => {
    const subj = req.params.subject;
    if (!getAllSubjectsWithSections().includes(subj)) {
      return res.status(400).json({ error: 'Invalid subject' });
    }
    txtUpload.single('txt')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      try {
        const text = req.file.buffer.toString('utf-8');
        const sections = KB.syllabus?.subjects?.[subj]?.sections || [];
        const leaves = collectLeafTopics(sections);
        const result = parseFlashcardTxt(text, leaves, subj);
        res.json({
          subject: subj,
          filename: req.file.originalname,
          sizeBytes: req.file.size,
          ...result,
        });
      } catch(e) {
        res.status(500).json({ error: e.message });
      }
    });
  });

  // ── Route 4: Commit previewed cards to DB ───────────────────
  // Body: { cards: [...], mode: "append" | "replace_per_topic" | "full_replace" }
  router.post('/api/admin/flashcards/import/:subject/commit', adminOnly, async (req, res) => {
    try {
      const subj = req.params.subject;
      if (!getAllSubjectsWithSections().includes(subj)) {
        return res.status(400).json({ error: 'Invalid subject' });
      }
      const { cards, mode } = req.body || {};
      if (!Array.isArray(cards) || cards.length === 0) {
        return res.status(400).json({ error: 'cards array is required and non-empty' });
      }
      const validModes = ['append', 'replace_per_topic', 'full_replace'];
      if (!validModes.includes(mode)) {
        return res.status(400).json({ error: `mode must be one of: ${validModes.join(', ')}` });
      }

      // Pre-flight: delete based on mode
      let deletedCount = 0;
      if (mode === 'full_replace') {
        const { data: existingAll } = await supabase
          .from('flashcards').select('id').eq('subject', subj);
        if (existingAll && existingAll.length) {
          await supabase.from('flashcards').delete().eq('subject', subj);
          deletedCount = existingAll.length;
        }
      } else if (mode === 'replace_per_topic') {
        const touchedNodes = Array.from(new Set(cards.map(c => c.nodeId)));
        if (touchedNodes.length) {
          const { data: existingPerTopic } = await supabase
            .from('flashcards').select('id')
            .eq('subject', subj)
            .in('node_id', touchedNodes);
          if (existingPerTopic && existingPerTopic.length) {
            await supabase.from('flashcards').delete()
              .eq('subject', subj)
              .in('node_id', touchedNodes);
            deletedCount = existingPerTopic.length;
          }
        }
      }

      // Build insert rows
      const nowIso = new Date().toISOString();
      const batchId = 'import_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const rows = cards.map(c => ({
        id: 'fc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        subject: subj,
        node_id: String(c.nodeId),
        node_path: String(c.nodePath || '').slice(0, 1000),
        card_type: String(c.card_type).toLowerCase(),
        front: String(c.front).trim().slice(0, 2000),
        back: String(c.back).trim().slice(0, 5000),
        source_snippet: c.source_snippet ? String(c.source_snippet).trim().slice(0, 2000) : null,
        source_ids: [],
        generation_batch_id: batchId,
        enabled: true,
        approved_at: nowIso,
        approved_by: req.userId || 'admin',
      }));

      // Batch insert in chunks of 500 for Supabase safety
      let inserted = 0;
      const insertErrors = [];
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { data, error } = await supabase.from('flashcards').insert(chunk).select('id');
        if (error) {
          insertErrors.push({ chunkStart: i, message: error.message });
        } else {
          inserted += (data || []).length;
        }
      }

      res.json({
        ok: insertErrors.length === 0,
        mode,
        inserted,
        deleted: deletedCount,
        batchId,
        insertErrors,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 5: List cards for one topic (admin manage view) ──
  router.get('/api/admin/flashcards/cards/:subject/:nodeId', adminOnly, async (req, res) => {
    try {
      const { subject, nodeId } = req.params;
      if (!getAllSubjectsWithSections().includes(subject)) {
        return res.status(400).json({ error: 'Invalid subject' });
      }
      const { data, error } = await supabase
        .from('flashcards')
        .select('*')
        .eq('subject', subject)
        .eq('node_id', nodeId)
        .order('generated_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      res.json({ cards: data || [] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 6: Update (edit) a card ──────────────────────────
  router.patch('/api/admin/flashcards/card/:cardId', adminOnly, async (req, res) => {
    try {
      const { cardId } = req.params;
      const { front, back, card_type, source_snippet, enabled } = req.body || {};
      const updates = { last_edited_at: new Date().toISOString() };
      if (typeof front === 'string')   updates.front   = front.trim().slice(0, 2000);
      if (typeof back  === 'string')   updates.back    = back.trim().slice(0, 5000);
      if (card_type && ['definition','elements','distinction'].includes(card_type)) {
        updates.card_type = card_type;
      }
      if (typeof source_snippet === 'string') {
        updates.source_snippet = source_snippet.trim().slice(0, 2000) || null;
      }
      if (typeof enabled === 'boolean') updates.enabled = enabled;

      const { data, error } = await supabase
        .from('flashcards').update(updates).eq('id', cardId)
        .select().maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!data)  return res.status(404).json({ error: 'Card not found' });
      res.json({ card: data });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 7: Delete a card ──────────────────────────────────
  router.delete('/api/admin/flashcards/card/:cardId', adminOnly, async (req, res) => {
    try {
      const { error } = await supabase.from('flashcards').delete().eq('id', req.params.cardId);
      if (error) return res.status(500).json({ error: error.message });
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
