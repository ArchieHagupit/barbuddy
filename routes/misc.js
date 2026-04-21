// Misc routes — extracted from server.js, behavior unchanged.
// Factory pattern: dependencies injected at call site because these routes
// read from mutable server.js globals (KB, CONTENT, GEN, etc.).
//
// IMPORTANT: This router includes the catchall '*' route, so it MUST be
// mounted LAST (after all other app.METHOD calls in server.js).
//
// Usage in server.js:
//   app.use(require('./routes/misc')({
//     adminOnly, API_KEY, KB, CONTENT, GEN, JOB_MAP, JOB_QUEUE, UPLOADS_DIR,
//   }));

const express = require('express');
const path = require('path');

module.exports = function createMiscRoutes({
  adminOnly, API_KEY, KB, CONTENT, GEN, JOB_MAP, JOB_QUEUE, UPLOADS_DIR,
}) {
  const router = express.Router();

  router.get('/api/health', (req, res) => {
    const n = Object.values(CONTENT).reduce((a,s) => a+Object.keys(s).length, 0);
    res.json({ status:'ok', keySet:!!API_KEY, kb:{ hasSyllabus:!!KB.syllabus, refs:KB.references.length, pastBar:KB.pastBar.length }, content:{ topics:n }, gen:{ running:GEN.running, done:GEN.done, total:GEN.total } });
  });

  router.get('/api/job/:jobId', adminOnly, (req, res) => {
    const job = JOB_MAP.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found or expired' });
    res.json({ status: job.status, result: job.result, error: job.error });
  });

  router.get('/api/storage-info', adminOnly, (_, res) => {
    res.json({
      persistent: !!process.env.PERSISTENT_STORAGE_PATH,
      storageDir: UPLOADS_DIR,
      envVar: process.env.PERSISTENT_STORAGE_PATH || null,
      source: 'supabase',
    });
  });

  router.get('/api/status', async (req, res) => {
    const start = Date.now();
    if (!API_KEY) return res.json({ apiOk:false, model:null, latencyMs:null, queueLength:JOB_QUEUE.length });
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10000);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'x-api-key':API_KEY, 'anthropic-version':'2023-06-01' },
        body:JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:5, messages:[{role:'user',content:'hi'}] }),
        signal:controller.signal,
      });
      clearTimeout(t);
      const d = await r.json();
      const latencyMs = Date.now() - start;
      const overloaded = r.status===529||r.status===429||d?.error?.type==='overloaded_error';
      res.json({ apiOk:!overloaded&&!d.error, model:'claude-haiku-4-5-20251001', latencyMs, queueLength:JOB_QUEUE.length });
    } catch(err) {
      res.json({ apiOk:false, model:null, latencyMs:Date.now()-start, queueLength:JOB_QUEUE.length });
    }
  });

  router.get('/robots.txt', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'robots.txt'));
  });

  router.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Use the version-injected HTML from server.js. Falls back to raw file
    // if the export isn't available (e.g. misc.js loaded in isolation).
    try {
      const { getIndexHtml } = require('../server');
      res.send(getIndexHtml());
    } catch(_) {
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    }
  });

  return router;
};
