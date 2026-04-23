// Flashcards routes — manual card authoring (Session 2.2).
//
// Scope:
//   - Admin uploads subject-level source material as committee reference
//     (PDF or text). Sources are NOT fed to any AI — purely for human
//     reviewer use while writing cards manually.
//   - Status endpoint lists syllabus leaf topics + card counts.
//   - Admin creates, edits, and deletes flashcards manually via the UI.
//   - Manually-authored cards are auto-published (enabled=true).
//
// No AI generation — that was Sessions 2/2.0 and 2.1, removed in 2.2
// after real-world testing showed AI output quality wasn't worth the
// review overhead or API cost for bar exam content.
//
// Usage in server.js:
//   app.use(require('./routes/flashcards')({
//     requireAuth, adminOnly, SYLLABUS_FLASHCARD_DIR, KB,
//   }));

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { supabase } = require('../config/supabase');
const { getAllSubjectsWithSections } = require('../lib/syllabus-tree');

module.exports = function createFlashcardRoutes({
  requireAuth, adminOnly, SYLLABUS_FLASHCARD_DIR, KB,
}) {
  const router = express.Router();

  // Multer disk-storage factory for subject source PDFs.
  // Captures SYLLABUS_FLASHCARD_DIR via closure (same pattern as syllabus router).
  function makeFlashcardSourceUpload() {
    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, SYLLABUS_FLASHCARD_DIR),
      filename: (req, file, cb) => {
        const sourceId = 'src_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        req._generatedSourceId = sourceId;
        cb(null, sourceId + '_' + safeName);
      },
    });
    return multer({
      storage,
      fileFilter: (_req, file, cb) => {
        if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) cb(null, true);
        else cb(new Error('Only PDF files are allowed'));
      },
      limits: { fileSize: 50 * 1024 * 1024 },
    });
  }

  // Walk a subject's syllabus sections and yield only LEAF topics
  // (nodes with type !== 'section' that have no non-empty children).
  // Each leaf gets a pathLabel of the form "I. Obligations > A. General > 1. Kinds"
  // built by joining ancestor label+title pairs with " > ".
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
        const hasChildren = children.some(c => c); // non-empty slot count
        if (node.type === 'section') {
          // sections are never leaves — always recurse
          walk(children, nextAncestry);
        } else if (hasChildren) {
          walk(children, nextAncestry);
        } else {
          // leaf
          leaves.push({
            nodeId: node.id,
            title: node.title || node.label || '',
            pathLabel: nextAncestry.join(' > '),
          });
        }
      }
    }
    walk(sections || [], []);
    return leaves;
  }

  // ── Route 1: Upload source (PDF multipart OR text JSON) ──────
  router.post('/api/admin/flashcards/source/:subject', adminOnly, (req, res) => {
    const subj = req.params.subject;
    if (!getAllSubjectsWithSections().includes(subj)) {
      return res.status(400).json({ error: 'Invalid subject' });
    }

    const ctype = String(req.headers['content-type'] || '');

    // ── Path A: JSON body → text source ──
    if (ctype.includes('application/json')) {
      const { name, text } = req.body || {};
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
      if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
      const textStr = String(text);
      const bytes = Buffer.byteLength(textStr, 'utf8');
      if (bytes > 2 * 1024 * 1024) {
        return res.status(413).json({ error: 'Text source must be under 2MB' });
      }
      const id = 'src_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const row = {
        id,
        subject: subj,
        source_type: 'text',
        name: String(name).trim().slice(0, 300),
        file_id: null,
        text_content: textStr,
        size_bytes: bytes,
        uploaded_by: req.userId || 'admin',
      };
      supabase.from('flashcard_sources').insert(row).select('id, subject, source_type, name, file_id, size_bytes, uploaded_at, uploaded_by').single()
        .then(({ data, error }) => {
          if (error) return res.status(500).json({ error: error.message });
          res.json({ source: data });
        })
        .catch(e => res.status(500).json({ error: e.message }));
      return;
    }

    // ── Path B: multipart/form-data → PDF source ──
    makeFlashcardSourceUpload().single('pdf')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      try {
        const id = req._generatedSourceId || ('src_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
        const row = {
          id,
          subject: subj,
          source_type: 'pdf',
          name: req.file.originalname,
          file_id: req.file.filename,
          text_content: null,
          size_bytes: req.file.size,
          uploaded_by: req.userId || 'admin',
        };
        const { data, error } = await supabase
          .from('flashcard_sources')
          .insert(row)
          .select('id, subject, source_type, name, file_id, size_bytes, uploaded_at, uploaded_by')
          .single();
        if (error) {
          try { fs.unlinkSync(req.file.path); } catch(_) {}
          return res.status(500).json({ error: error.message });
        }
        res.json({ source: data });
      } catch(e) {
        try { fs.unlinkSync(req.file.path); } catch(_) {}
        res.status(500).json({ error: e.message });
      }
    });
  });

  // ── Route 2: List sources for subject ───────────────────────
  router.get('/api/admin/flashcards/sources/:subject', adminOnly, async (req, res) => {
    try {
      const subj = req.params.subject;
      if (!getAllSubjectsWithSections().includes(subj)) {
        return res.status(400).json({ error: 'Invalid subject' });
      }
      const { data, error } = await supabase
        .from('flashcard_sources')
        .select('id, subject, source_type, name, file_id, size_bytes, uploaded_at, uploaded_by')
        .eq('subject', subj)
        .order('uploaded_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      res.json({ sources: data || [] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 3: Delete one source (PDF file + row) ─────────────
  // Does NOT delete any generated flashcards — card deletion is an
  // explicit admin action in a later session.
  router.delete('/api/admin/flashcards/source/:sourceId', adminOnly, async (req, res) => {
    try {
      const { sourceId } = req.params;
      const { data: existing, error: fetchErr } = await supabase
        .from('flashcard_sources')
        .select('id, source_type, file_id')
        .eq('id', sourceId)
        .maybeSingle();
      if (fetchErr) return res.status(500).json({ error: fetchErr.message });
      if (!existing) return res.status(404).json({ error: 'Source not found' });

      if (existing.source_type === 'pdf' && existing.file_id) {
        const filePath = path.join(SYLLABUS_FLASHCARD_DIR, existing.file_id);
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(_) {}
      }

      const { error: delErr } = await supabase.from('flashcard_sources').delete().eq('id', sourceId);
      if (delErr) return res.status(500).json({ error: delErr.message });
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 4: Status — syllabus leaf topics + per-topic counts ──
  // Session 1: pendingCount/approvedCount always 0 (no cards yet).
  // Session 2 uses this as the "what to generate" worklist.
  router.get('/api/admin/flashcards/status/:subject', adminOnly, async (req, res) => {
    try {
      const subj = req.params.subject;
      if (!getAllSubjectsWithSections().includes(subj)) {
        return res.status(400).json({ error: 'Invalid subject' });
      }

      const sections = KB.syllabus?.subjects?.[subj]?.sections || [];
      const leaves = collectLeafTopics(sections);

      // Aggregate card counts per node in one query (Session 1 returns 0s
      // since the table is empty, but the query is wired for Session 2).
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
        // Swallow — if the table doesn't exist yet (migrations not run),
        // just return zero counts. Admin will see sources UI either way.
        byNode = {};
      }

      // Sources list (same shape as Route 2 but inlined to avoid second request).
      const { data: sources, error: srcErr } = await supabase
        .from('flashcard_sources')
        .select('id, subject, source_type, name, file_id, size_bytes, uploaded_at, uploaded_by')
        .eq('subject', subj)
        .order('uploaded_at', { ascending: false });
      if (srcErr) return res.status(500).json({ error: srcErr.message });

      let totalGenerated = 0, totalApproved = 0;
      const topics = leaves.map(l => {
        const counts = byNode[l.nodeId] || { pending: 0, approved: 0 };
        totalGenerated += counts.pending + counts.approved;
        totalApproved  += counts.approved;
        return {
          nodeId: l.nodeId,
          title: l.title,
          pathLabel: l.pathLabel,
          pendingCount: counts.pending,
          approvedCount: counts.approved,
        };
      });

      res.json({
        subject: subj,
        sources: sources || [],
        topics,
        totalSyllabusTopics: topics.length,
        totalGenerated,
        totalApproved,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 5: Create a card manually (auto-published) ────────
  // Session 2.2: manually-authored cards go straight to enabled=true.
  // Body: { subject, node_id, node_path, card_type, front, back, source_snippet? }
  router.post('/api/admin/flashcards/card', adminOnly, async (req, res) => {
    try {
      const {
        subject,
        node_id,
        node_path,
        card_type,
        front,
        back,
        source_snippet,
      } = req.body || {};

      if (!subject || !getAllSubjectsWithSections().includes(subject)) {
        return res.status(400).json({ error: 'Invalid subject' });
      }
      if (!node_id || typeof node_id !== 'string') {
        return res.status(400).json({ error: 'node_id required' });
      }
      if (!['definition', 'elements', 'distinction'].includes(card_type)) {
        return res.status(400).json({ error: "card_type must be one of: definition, elements, distinction" });
      }
      const frontStr = String(front || '').trim();
      const backStr  = String(back  || '').trim();
      if (!frontStr) return res.status(400).json({ error: 'front required' });
      if (!backStr)  return res.status(400).json({ error: 'back required' });
      if (frontStr.length > 2000) return res.status(400).json({ error: 'front exceeds 2000 chars' });
      if (backStr.length  > 5000) return res.status(400).json({ error: 'back exceeds 5000 chars' });

      const nowIso = new Date().toISOString();
      const row = {
        id: 'fc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        subject,
        node_id: String(node_id),
        node_path: String(node_path || '').slice(0, 1000),
        card_type,
        front: frontStr,
        back: backStr,
        source_snippet: source_snippet ? String(source_snippet).trim().slice(0, 2000) : null,
        source_ids: [],
        generation_batch_id: 'manual',
        enabled: true,
        approved_at: nowIso,
        approved_by: req.userId || 'admin',
      };

      const { data, error } = await supabase
        .from('flashcards').insert(row).select().single();
      if (error) return res.status(500).json({ error: error.message });
      res.json({ card: data });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 8: List cards for one topic (admin review view) ──
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

  // ── Route 9: Update one card (approve / edit) ────────────────
  router.patch('/api/admin/flashcards/card/:cardId', adminOnly, async (req, res) => {
    try {
      const { cardId } = req.params;
      const { front, back, enabled, card_type } = req.body || {};
      const updates = { last_edited_at: new Date().toISOString() };
      if (typeof front === 'string')   updates.front   = front.trim().slice(0, 2000);
      if (typeof back  === 'string')   updates.back    = back.trim().slice(0, 5000);
      if (card_type && ['definition','elements','distinction'].includes(card_type)) {
        updates.card_type = card_type;
      }
      if (typeof enabled === 'boolean') {
        updates.enabled = enabled;
        if (enabled) {
          updates.approved_at = new Date().toISOString();
          updates.approved_by = req.userId || 'admin';
        }
      }
      const { data, error } = await supabase
        .from('flashcards').update(updates).eq('id', cardId)
        .select().maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!data)  return res.status(404).json({ error: 'Card not found' });
      res.json({ card: data });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Route 10: Delete (reject) a card ─────────────────────────
  router.delete('/api/admin/flashcards/card/:cardId', adminOnly, async (req, res) => {
    try {
      const { error } = await supabase.from('flashcards').delete().eq('id', req.params.cardId);
      if (error) return res.status(500).json({ error: error.message });
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
