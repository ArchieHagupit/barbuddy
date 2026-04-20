// Syllabus routes — extracted from server.js, behavior unchanged.
//
// Public read routes (auth-or-admin), admin CRUD for sections/nodes,
// PDF upload/delete (multer disk storage), and PDF serve with 3-method
// auth (admin key header / session token header / short-lived query token).
//
// Route order matters: /api/syllabus/pdf/:nodeId MUST come before
// /api/syllabus/:subject in the Router's registration order, otherwise
// a GET for /api/syllabus/pdf/xyz would match :subject=pdf instead.
//
// global.pdfTokens: short-lived iframe auth tokens. Preserved as-is
// (it's a code smell — global mutable state — but fixing it is out of
// scope for this refactor).
//
// All tree helpers (findNodeById, removeNodeById, generateId,
// getAllSubjectsWithSections) are already in lib/syllabus-tree
// from an earlier prep commit.

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { saveSyllabusSubject } = require('../lib/db-syllabus');
const {
  findNodeById, removeNodeById, generateId, getAllSubjectsWithSections,
} = require('../lib/syllabus-tree');

// Usage in server.js:
//   app.use(require('./routes/syllabus')({
//     requireAuth, adminOnly, authOrAdmin,
//     ADMIN_KEY, verifySession, KB, SYLLABUS_PDFS_DIR,
//   }));

module.exports = function createSyllabusRoutes({
  requireAuth, adminOnly, authOrAdmin,
  ADMIN_KEY, verifySession, KB, SYLLABUS_PDFS_DIR,
}) {
  const router = express.Router();

  // Disk-storage multer factory — used only by the PDF upload route.
  // Kept inline (rather than at module scope) so it captures SYLLABUS_PDFS_DIR
  // from the factory closure.
  function makeSyllabusUpload() {
    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, SYLLABUS_PDFS_DIR),
      filename: (req, file, cb) => {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, req.params.nodeId + '_' + safeName);
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

  // ── Route 1: PDF token (short-lived auth for iframe embed) ────
  router.get('/api/syllabus/pdf-token/:nodeId', requireAuth, (req, res) => {
    const { nodeId } = req.params;
    // Verify the node exists and has a PDF
    let found = null;
    for (const subjData of Object.values(KB.syllabus?.subjects || {})) {
      const r = findNodeById(subjData.sections || [], nodeId);
      if (r) { found = r.node; break; }
    }
    if (!found || !found.pdfId) return res.status(404).json({ error: 'No PDF for this topic' });
    const tokenData = { nodeId, userId: req.userId, exp: Date.now() + 10 * 60 * 1000 };
    const token = Buffer.from(JSON.stringify(tokenData)).toString('base64url');
    if (!global.pdfTokens) global.pdfTokens = {};
    global.pdfTokens[token] = tokenData;
    // Prune expired tokens
    const now = Date.now();
    for (const t of Object.keys(global.pdfTokens)) {
      if (global.pdfTokens[t].exp < now) delete global.pdfTokens[t];
    }
    res.json({ token, nodeId });
  });

  // ── Route 2: PDF file serving ─────────────────────────────────
  // NOTE: must come BEFORE /api/syllabus/:subject to avoid routing conflict
  // Auth: header session token (direct), query ?token (iframes), or admin key
  router.get('/api/syllabus/pdf/:nodeId', async (req, res) => {
    const { nodeId } = req.params;
    const { token } = req.query;
    let authenticated = false;

    // Method 1: admin key header
    const aKey = req.headers['x-admin-key'];
    if (aKey === ADMIN_KEY) authenticated = true;

    // Method 2: standard session token header (direct API calls)
    if (!authenticated) {
      const headerToken = req.headers['x-session-token'];
      if (headerToken) {
        const session = await verifySession(headerToken).catch(() => null);
        if (session) authenticated = true;
      }
    }

    // Method 3: short-lived query param token (for iframes)
    if (!authenticated && token) {
      const td = global.pdfTokens?.[token];
      if (td && td.exp > Date.now() && td.nodeId === nodeId) authenticated = true;
    }

    if (!authenticated) return res.status(401).json({ error: 'Not authenticated' });

    // Find the node
    let targetNode = null;
    for (const subjData of Object.values(KB.syllabus?.subjects || {})) {
      const r = findNodeById(subjData.sections || [], nodeId);
      if (r) { targetNode = r.node; break; }
    }
    if (!targetNode || !targetNode.pdfId) return res.status(404).json({ error: 'No PDF attached to this node' });
    const filePath = path.join(SYLLABUS_PDFS_DIR, targetNode.pdfId);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'PDF file not found on disk' });

    const stat = fs.statSync(filePath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `inline; filename="${(targetNode.pdfName || 'document.pdf').replace(/"/g, '')}"`);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', err => { console.error('PDF stream error:', err.message); if (!res.headersSent) res.status(500).end(); });
  });

  // ── Routes 3-4: Public read (auth-or-admin) ───────────────────
  router.get('/api/syllabus', authOrAdmin, (req, res) => {
    res.json({ subjects: KB.syllabus?.subjects || {} });
  });

  router.get('/api/syllabus/:subject', authOrAdmin, (req, res) => {
    const subj = req.params.subject;
    if (!getAllSubjectsWithSections().includes(subj)) return res.status(400).json({ error: 'Invalid subject' });
    res.json(KB.syllabus?.subjects?.[subj] || { sections: [] });
  });

  // ── Routes 5-11: Admin write routes ───────────────────────────
  router.post('/api/admin/syllabus/:subject/section', adminOnly, async (req, res) => {
    try {
      const subj = req.params.subject;
      if (!getAllSubjectsWithSections().includes(subj)) return res.status(400).json({ error: 'Invalid subject' });
      const { label, title } = req.body || {};
      if (!label || !title) return res.status(400).json({ error: 'label and title required' });
      const section = { id: generateId('sec'), type: 'section', label: label.toUpperCase(), title: title.toUpperCase(), children: [] };
      KB.syllabus.subjects[subj].sections.push(section);
      await saveSyllabusSubject(subj, KB.syllabus.subjects[subj].sections);
      res.json(KB.syllabus.subjects[subj]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/admin/syllabus/:subject/node', adminOnly, async (req, res) => {
    try {
      const subj = req.params.subject;
      if (!getAllSubjectsWithSections().includes(subj)) return res.status(400).json({ error: 'Invalid subject' });
      const { parentId, label, title } = req.body || {};
      if (!parentId || !label || !title) return res.status(400).json({ error: 'parentId, label, and title required' });
      const sections = KB.syllabus.subjects[subj].sections;
      const found = findNodeById(sections, parentId);
      if (!found) return res.status(404).json({ error: 'Parent node not found' });
      const prefix = /^\d+$/.test(label) ? 'sub' : /^[a-z]$/.test(label) ? 'leaf' : 'top';
      const newNode = { id: generateId(prefix), type: 'topic', label, title, pdfId: null, pdfName: null, children: [] };
      if (!found.node.children) found.node.children = [];
      found.node.children.push(newNode);
      await saveSyllabusSubject(subj, KB.syllabus.subjects[subj].sections);
      res.json(KB.syllabus.subjects[subj]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/api/admin/syllabus/:subject/node/:nodeId', adminOnly, async (req, res) => {
    try {
      const subj = req.params.subject;
      if (!getAllSubjectsWithSections().includes(subj)) return res.status(400).json({ error: 'Invalid subject' });
      const sections = KB.syllabus.subjects[subj].sections;
      const found = findNodeById(sections, req.params.nodeId);
      if (!found) return res.status(404).json({ error: 'Node not found' });
      const { label, title, type } = req.body || {};
      if (label !== undefined) found.node.label = label;
      if (title !== undefined) found.node.title = title;
      if (type  !== undefined) found.node.type  = type;
      await saveSyllabusSubject(subj, KB.syllabus.subjects[subj].sections);
      res.json(KB.syllabus.subjects[subj]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/admin/syllabus/:subject/node/:nodeId', adminOnly, async (req, res) => {
    try {
      const subj = req.params.subject;
      if (!getAllSubjectsWithSections().includes(subj)) return res.status(400).json({ error: 'Invalid subject' });
      const pdfsToDelete = removeNodeById(KB.syllabus.subjects[subj].sections, req.params.nodeId);
      pdfsToDelete.forEach(pdfId => {
        const filePath = path.join(SYLLABUS_PDFS_DIR, pdfId);
        if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch(e) {} }
      });
      await saveSyllabusSubject(subj, KB.syllabus.subjects[subj].sections);
      res.json(KB.syllabus.subjects[subj]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/admin/syllabus/:subject/node/:nodeId/pdf', adminOnly, (req, res) => {
    makeSyllabusUpload().single('pdf')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      try {
        const subj = req.params.subject;
        if (!getAllSubjectsWithSections().includes(subj)) return res.status(400).json({ error: 'Invalid subject' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const sections = KB.syllabus.subjects[subj].sections;
        const found = findNodeById(sections, req.params.nodeId);
        if (!found) {
          try { fs.unlinkSync(req.file.path); } catch(e) {}
          return res.status(404).json({ error: 'Node not found' });
        }
        if (found.node.pdfId) {
          const oldPath = path.join(SYLLABUS_PDFS_DIR, found.node.pdfId);
          if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch(e) {} }
        }
        found.node.pdfId   = req.file.filename;
        found.node.pdfName = req.file.originalname;
        await saveSyllabusSubject(subj, KB.syllabus.subjects[subj].sections);
        res.json({ pdfId: req.file.filename, pdfName: req.file.originalname });
      } catch(e) { res.status(500).json({ error: e.message }); }
    });
  });

  router.delete('/api/admin/syllabus/:subject/node/:nodeId/pdf', adminOnly, async (req, res) => {
    try {
      const subj = req.params.subject;
      if (!getAllSubjectsWithSections().includes(subj)) return res.status(400).json({ error: 'Invalid subject' });
      const sections = KB.syllabus.subjects[subj].sections;
      const found = findNodeById(sections, req.params.nodeId);
      if (!found) return res.status(404).json({ error: 'Node not found' });
      if (found.node.pdfId) {
        const filePath = path.join(SYLLABUS_PDFS_DIR, found.node.pdfId);
        if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch(e) {} }
        found.node.pdfId   = null;
        found.node.pdfName = null;
        await saveSyllabusSubject(subj, KB.syllabus.subjects[subj].sections);
      }
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/admin/syllabus/:subject/reorder', adminOnly, async (req, res) => {
    try {
      const subj = req.params.subject;
      if (!getAllSubjectsWithSections().includes(subj)) return res.status(400).json({ error: 'Invalid subject' });
      const { nodeId, direction } = req.body || {};
      const sections = KB.syllabus.subjects[subj].sections;
      function reorderIn(arr) {
        const idx = arr.findIndex(n => n.id === nodeId);
        if (idx !== -1) {
          const newIdx = idx + (direction > 0 ? 1 : -1);
          if (newIdx >= 0 && newIdx < arr.length) {
            [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
          }
          return true;
        }
        for (const node of arr) {
          if (node.children?.length && reorderIn(node.children)) return true;
        }
        return false;
      }
      reorderIn(sections);
      await saveSyllabusSubject(subj, KB.syllabus.subjects[subj].sections);
      res.json(KB.syllabus.subjects[subj]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
