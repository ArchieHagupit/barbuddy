// Admin KB management routes — extracted from server.js, behavior unchanged.
//
// Covers: reference upload (with async summarization), KB diagnostic,
// reference delete (also cleans past_bar), syllabus wipe, CONTENT wipe.
//
// CONTENT is let-reassigned in server.js, so this module receives
// getCONTENT/setCONTENT closures (same pattern as TAB_SETTINGS).
// KB is passed by reference (const with mutable members — safe).
//
// summarizeLargeDoc, triggerPreGenerationForSubject, enqueueJob stay
// in server.js and are passed via factory (all hoisted function declarations).

const express = require('express');
const { supabase } = require('../config/supabase');
const { saveSetting } = require('../lib/db-settings');
const { saveSyllabusSubject, deletePastBarEntry } = require('../lib/db-syllabus');
const { getAllSubjectsWithSections } = require('../lib/syllabus-tree');

// Usage in server.js:
//   app.use(require('./routes/admin-kb')({
//     adminOnly, KB,
//     getCONTENT: () => CONTENT,
//     setCONTENT: (v) => { CONTENT = v; },
//     enqueueJob, summarizeLargeDoc, triggerPreGenerationForSubject,
//   }));

module.exports = function createAdminKbRoutes({
  adminOnly, KB,
  getCONTENT, setCONTENT,
  enqueueJob, summarizeLargeDoc, triggerPreGenerationForSubject,
}) {
  const router = express.Router();

  // ── ADMIN: Upload Reference — save instantly, summarise in background ──
  router.post('/api/admin/reference', adminOnly, async (req, res) => {
    try {
      const { name, subject, type, content } = req.body;
      if (!content) return res.status(400).json({ error: 'content required' });
      const id = `ref_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const ref = { id, name, subject:subject||'general', type:type||'other', text:content.slice(0,30000), summary:'processing', size:content.length, uploadedAt:new Date().toISOString() };
      KB.references.push(ref);
      await saveSetting('kb_references', KB.references);
      const jobId = enqueueJob(async () => {
        const summary = await summarizeLargeDoc(content, name, subject||'general');
        const r = KB.references.find(r => r.id === id);
        if (r) { r.summary = summary; await saveSetting('kb_references', KB.references); }
        if (KB.syllabus) triggerPreGenerationForSubject(subject);
        return { id, name };
      });
      res.json({ success:true, id, name, jobId });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── ADMIN: KB Diagnostic ─────────────────────────────────────
  router.get('/api/admin/debug/kb', adminOnly, async (_req, res) => {
    try {
      const { data: pbRows } = await supabase.from('past_bar').select('id,name,subject,year,q_count,questions,source');
      res.json({
        source: 'supabase',
        pastBarCount: pbRows?.length || 0,
        pastBarItems: (pbRows || []).map(pb => ({
          id: pb.id, name: pb.name, subject: pb.subject, year: pb.year,
          questionCount: pb.questions?.length || pb.q_count || 0,
          hasQuestions: Array.isArray(pb.questions),
          source: pb.source || 'upload',
          firstQ: pb.questions?.[0]?.q?.slice(0, 80) || '(none)',
        })),
        referenceCount: KB.references.length,
        syllabusSubjects: Object.keys(KB.syllabus?.subjects || {}),
        inMemoryKB: {
          pastBarCount: KB.pastBar.length,
          pastBarSubjects: KB.pastBar.map(pb => pb.subject),
          referenceCount: KB.references.length,
        },
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── ADMIN: Delete reference ──────────────────────────────────
  router.delete('/api/admin/reference/:id', adminOnly, async (req, res) => {
    try {
      const id = req.params.id;
      KB.references = KB.references.filter(r => r.id !== id);
      await saveSetting('kb_references', KB.references);
      const pbIdx = KB.pastBar.findIndex(p => p.id === id);
      if (pbIdx !== -1) {
        KB.pastBar.splice(pbIdx, 1);
        await deletePastBarEntry(id);
      }
      res.json({ success:true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── ADMIN: Wipe all syllabus ─────────────────────────────────
  router.delete('/api/admin/syllabus', adminOnly, async (req, res) => {
    try {
      KB.syllabus = { subjects: {} };
      getAllSubjectsWithSections().forEach(s => { KB.syllabus.subjects[s] = { sections: [] }; });
      setCONTENT({});
      await Promise.all(getAllSubjectsWithSections().map(s => saveSyllabusSubject(s, [])));
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── ADMIN: Wipe CONTENT only ─────────────────────────────────
  router.delete('/api/admin/content', adminOnly, (req, res) => {
    setCONTENT({});
    res.json({ success:true });
  });

  return router;
};
