// Admin pastbar routes — extracted from server.js, behavior unchanged.
// Covers upload (with async extraction), bulk/per-entry download,
// enable/disable toggle, extraction-status polling, and manual entry.
//
// enqueueJob and extractPastBarInBackground stay in server.js and are
// injected via factory (both are hoisted function declarations so
// forward-reference works at factory-call time).
//
// KB is passed by reference (it's const in server.js with mutable members
// — reassigning KB.pastBar in this module is NOT safe, but .push()
// and .find() operate on the shared array instance).

const express = require('express');
const { supabase } = require('../config/supabase');
const { savePastBarEntry } = require('../lib/db-syllabus');

// Usage in server.js:
//   app.use(require('./routes/admin-pastbar')({
//     adminOnly, KB, enqueueJob, extractPastBarInBackground,
//   }));

module.exports = function createAdminPastbarRoutes({
  adminOnly, KB, enqueueJob, extractPastBarInBackground,
}) {
  const router = express.Router();

  router.post('/api/admin/pastbar', adminOnly, async (req, res) => {
    try {
      const { name, subject, year, content } = req.body;
      if (!content) return res.status(400).json({ error: 'content required' });
      const id = `pb_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const entry = { id, name, subject:subject||'general', year:year||'Unknown', questions:[], qCount:0, source:'upload', extracting:true, uploadedAt:new Date().toISOString() };
      KB.pastBar.push(entry);
      await savePastBarEntry(entry);
      const jobId = enqueueJob(async () => {
        await extractPastBarInBackground(id, content, name, subject||'general', year);
        const e = KB.pastBar.find(p => p.id === id);
        return { id, name, questionsExtracted: e?.questions?.length || 0 };
      });
      res.json({ success:true, id, name, jobId });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── ADMIN: Download all past bar questions ───────────────────
  router.get('/api/admin/pastbar/download-all', adminOnly, (_req, res) => {
    if (!KB.pastBar.length) return res.status(404).json({ error: 'No past bar questions in KB' });
    const lines = [];
    for (const p of KB.pastBar) {
      lines.push('════════════════════════════════════════════════');
      lines.push(`${p.name} — ${p.subject} — ${p.year || 'n/a'}`);
      lines.push('════════════════════════════════════════════════');
      lines.push('');
      (p.questions || []).forEach((q, idx) => {
        lines.push(`QUESTION ${idx + 1}`);
        lines.push(`Type: ${q.type === 'situational' ? 'Situational' : 'Conceptual'}`);
        lines.push('');
        if (q.context) { lines.push('FACTS:'); lines.push(q.context); lines.push(''); }
        lines.push('QUESTION:'); lines.push(q.q || ''); lines.push('');
        lines.push('SUGGESTED ANSWER:'); lines.push(q.modelAnswer || ''); lines.push('');
        if (q.keyPoints?.length) { lines.push('KEY POINTS:'); q.keyPoints.forEach(kp => lines.push(`• ${kp}`)); lines.push(''); }
        lines.push('------------------------------------------------'); lines.push('');
      });
      lines.push('');
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="barbuddy-all-questions.txt"');
    res.send(lines.join('\n'));
  });

  // ── ADMIN: Download single past bar entry ────────────────────
  router.get('/api/admin/pastbar/:id/download', adminOnly, (req, res) => {
    const entry = KB.pastBar.find(p => p.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    const fmt = req.query.format || 'json';
    const safeName = (entry.name || 'questions').replace(/[^a-zA-Z0-9_\-]/g, '_');
    const year = entry.year || 'unknown';
    const qs = entry.questions || [];
    const e = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');

    if (fmt === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}-${year}-questions.json"`);
      return res.json({ name: entry.name, subject: entry.subject, year: entry.year, exportedAt: new Date().toISOString(),
        questions: qs.map(q => ({ q: q.q, type: q.type, context: q.context||null, modelAnswer: q.modelAnswer||null, keyPoints: q.keyPoints||[], subject: q.subject||entry.subject })) });
    }

    if (fmt === 'txt') {
      const lines = [];
      lines.push('================================================');
      lines.push(`${entry.name} — ${entry.subject} — ${entry.year || 'n/a'}`);
      lines.push('BarBuddy Knowledge Base Export');
      lines.push(`Exported: ${new Date().toLocaleString('en-PH', {timeZone: 'Asia/Manila'})}`);
      lines.push(`Total Questions: ${qs.length}`);
      lines.push('================================================'); lines.push('');
      qs.forEach((q, idx) => {
        lines.push(`QUESTION ${idx + 1}`);
        lines.push(`Type: ${q.type === 'situational' ? 'Situational' : 'Conceptual'}`); lines.push('');
        if (q.context) { lines.push('FACTS:'); lines.push(q.context); lines.push(''); }
        lines.push('QUESTION:'); lines.push(q.q || ''); lines.push('');
        lines.push('SUGGESTED ANSWER:'); lines.push(q.modelAnswer || ''); lines.push('');
        if (q.keyPoints?.length) { lines.push('KEY POINTS:'); q.keyPoints.forEach(kp => lines.push(`• ${kp}`)); lines.push(''); }
        lines.push('------------------------------------------------'); lines.push('');
      });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}-${year}-questions.txt"`);
      return res.send(lines.join('\n'));
    }

    if (fmt === 'pdf') {
      const qHtml = qs.map((q, idx) => `<div class="question">
        <div class="qnum">Question ${idx + 1}</div>
        <div class="qtype">Type: ${q.type === 'situational' ? 'Situational' : 'Conceptual'}</div>
        ${q.context ? `<div class="section-label">FACTS:</div><div class="section-text">${e(q.context)}</div>` : ''}
        <div class="section-label">QUESTION:</div><div class="section-text">${e(q.q||'')}</div>
        <div class="section-label">SUGGESTED ANSWER:</div><div class="section-text">${e(q.modelAnswer||'')}</div>
        ${q.keyPoints?.length ? `<div class="section-label">KEY POINTS:</div><ul class="kp-list">${q.keyPoints.map(kp=>`<li>${e(kp)}</li>`).join('')}</ul>` : ''}
      </div>`).join('');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${e(entry.name)} — ${e(entry.subject)} — ${year}</title>
<style>
body{font-family:Georgia,serif;color:#111;max-width:800px;margin:0 auto;padding:30px;}
h1{font-size:20px;color:#7a6128;border-bottom:2px solid #7a6128;padding-bottom:8px;margin-bottom:16px;}
.meta{font-size:12px;color:#555;margin-bottom:20px;line-height:1.8;}
.question{page-break-inside:avoid;margin-bottom:30px;padding-bottom:20px;border-bottom:1px solid #ccc;}
.qnum{font-size:16px;font-weight:bold;color:#7a6128;margin-bottom:4px;}
.qtype{font-size:11px;color:#888;margin-bottom:10px;}
.section-label{font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#7a6128;margin:12px 0 4px;}
.section-text{font-size:13px;line-height:1.7;margin-bottom:8px;}
.kp-list{margin:4px 0 0 18px;font-size:13px;line-height:1.7;}
@media print{body{padding:0;}.question{page-break-inside:avoid;}}
</style></head>
<body>
<h1>${e(entry.name)} — ${e(entry.subject)} — ${year}</h1>
<div class="meta"><div><strong>Exported:</strong> ${new Date().toLocaleString('en-PH', {timeZone: 'Asia/Manila'})}</div><div><strong>Total Questions:</strong> ${qs.length}</div></div>
${qHtml}
<div style="margin-top:30px;padding-top:10px;border-top:1px solid #ccc;font-size:11px;color:#888;text-align:center;">Generated by BarBuddy — Philippine Bar Exam Companion</div>
<script>window.onload=()=>window.print();</script>
</body></html>`);
    }

    res.status(400).json({ error: 'format must be json, txt, or pdf' });
  });

  // ── ADMIN: Toggle past-bar batch enabled/disabled ────────────
  router.patch('/api/admin/pastbar/:id/toggle', adminOnly, async (req, res) => {
    try {
      const { id } = req.params;
      const enabled = !!req.body.enabled;
      const { data, error } = await supabase
        .from('past_bar')
        .update({ enabled })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      // Update in-memory KB cache
      const entry = KB.pastBar.find(p => p.id === id);
      if (entry) entry.enabled = enabled;
      console.log(`Batch ${id} ${enabled ? 'enabled' : 'disabled'}`);
      res.json({ success: true, id, enabled: data.enabled });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── ADMIN: Past Bar extraction status (legacy) ───────────────
  router.get('/api/admin/pastbar/:id/status', adminOnly, (req, res) => {
    const entry = KB.pastBar.find(p => p.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    res.json({ extracting: entry.extracting || false, questionsExtracted: entry.questions?.length || 0, extractError: entry.extractError || null });
  });

  // ── ADMIN: Manual past bar question entry (no AI) ────────────
  router.post('/api/admin/pastbar/manual', adminOnly, async (req, res) => {
    try {
      const { name, subject, year, questions } = req.body;
      if (!name || !Array.isArray(questions) || !questions.length)
        return res.status(400).json({ error: 'name and questions[] required' });
      const id = `pb_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
      const entry = {
        id, name,
        subject: subject || 'general',
        year: year || 'Unknown',
        source: 'manual',
        questions: questions.map(q => ({
          q: q.q || '',
          context: q.context || '',
          modelAnswer: q.modelAnswer || '',
          keyPoints: Array.isArray(q.keyPoints) ? q.keyPoints : [],
          type: q.type || 'situational',
        })),
        qCount: questions.length,
        extracting: false,
        uploadedAt: new Date().toISOString(),
      };
      KB.pastBar.push(entry);
      await savePastBarEntry(entry);
      res.json({ success: true, id, name, questionsAdded: questions.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
