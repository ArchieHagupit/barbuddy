const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const pdfParse   = require('pdf-parse');
const mammoth    = require('mammoth');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
// Disk-storage multer for syllabus PDFs — files saved directly to SYLLABUS_PDFS_DIR
// (SYLLABUS_PDFS_DIR is defined below; multer is configured lazily via a factory)
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

const app       = express();
const PORT      = process.env.PORT || 3000;
const API_KEY   = process.env.ANTHROPIC_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY || 'barbuddy-admin-2025';

const VALID_SUBJECTS = ['civil','criminal','political','labor','commercial','taxation','remedial','ethics','custom'];
const SUBJECT_MAP_FALLBACK = {
  civil:'Civil Law', criminal:'Criminal Law', political:'Political Law',
  labor:'Labor Law and Social Legislation', commercial:'Commercial Law',
  taxation:'Taxation', remedial:'Remedial Law',
  ethics:'Legal and Judicial Ethics', custom:'Custom Subject',
};

// Every Claude call is restricted to uploaded materials only
const STRICT_SYSTEM_PROMPT = `You are a content extraction and organization assistant for a Philippine Bar Exam review platform. Your ONLY role is to read the uploaded reference materials provided and organize their content into structured study materials.

ABSOLUTE RULES — never break these:
- Only use information explicitly written in the provided reference materials
- Never add any doctrine, case, G.R. number, article number, statute, or legal principle that does not appear in the provided materials
- Never invent or guess. If something is not in the materials, do not include it
- Every lesson point must quote or directly paraphrase a specific passage from the materials
- Every quiz question must test something explicitly stated in the materials
- Every answer and explanation must cite which part of the uploaded material it came from
- If the uploaded materials do not have enough content to generate a section, write exactly: [Not covered in uploaded materials]
- You are an analyst and organizer, not a content creator`;

// ── Persistence ─────────────────────────────────────────────
// On Railway: set PERSISTENT_STORAGE_PATH to your Volume mount path (e.g. /data)
// so that KB survives redeploys. Falls back to local uploads/ for dev.
const UPLOADS_DIR  = process.env.PERSISTENT_STORAGE_PATH
  ? path.join(process.env.PERSISTENT_STORAGE_PATH, 'uploads')
  : path.join(__dirname, 'uploads');
const KB_PATH           = path.join(UPLOADS_DIR, 'kb.json');
const CONTENT_PATH      = path.join(UPLOADS_DIR, 'content.json');
const TAB_SETTINGS_PATH = path.join(UPLOADS_DIR, 'tab_settings.json');
const USERS_PATH         = path.join(UPLOADS_DIR, 'users.json');
const SESSIONS_PATH      = path.join(UPLOADS_DIR, 'sessions.json');
const RESULTS_PATH       = path.join(UPLOADS_DIR, 'results.json');
const SETTINGS_PATH      = path.join(UPLOADS_DIR, 'settings.json');
const RESET_REQUESTS_PATH = path.join(UPLOADS_DIR, 'reset_requests.json');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const SYLLABUS_PDFS_DIR = path.join(UPLOADS_DIR, 'syllabus-pdfs');
if (!fs.existsSync(SYLLABUS_PDFS_DIR)) fs.mkdirSync(SYLLABUS_PDFS_DIR, { recursive: true });

// Knowledge Base — syllabus + references + past bar
const KB = {
  syllabus:   null,   // { name, rawText, topics:[{key,name,topics:[{name,subtopics:[]}]}], uploadedAt }
  references: [],     // [{ id, name, subject, type, text, summary, size, uploadedAt }]
  pastBar:    [],     // [{ id, name, subject, year, questions:[{q,modelAnswer,keyPoints}], uploadedAt }]
};

// Tab visibility settings (admin-controlled)
const DEFAULT_TAB_SETTINGS = {
  overview: true,
  subjects: {
    civil:      { learn: true, quiz: true, mockbar: true },
    criminal:   { learn: true, quiz: true, mockbar: true },
    political:  { learn: true, quiz: true, mockbar: true },
    labor:      { learn: true, quiz: true, mockbar: true },
    commercial: { learn: true, quiz: true, mockbar: true },
    taxation:   { learn: true, quiz: true, mockbar: true },
    remedial:   { learn: true, quiz: true, mockbar: true },
    ethics:     { learn: true, quiz: true, mockbar: true },
    custom:     { mockbar: true },
  },
};
function deepMerge(defaults, overrides) {
  const result = JSON.parse(JSON.stringify(defaults));
  for (const key of Object.keys(overrides)) {
    if (overrides[key] !== null && typeof overrides[key] === 'object' && !Array.isArray(overrides[key])) {
      if (result[key] !== null && typeof result[key] === 'object') {
        result[key] = deepMerge(result[key], overrides[key]);
      } else { result[key] = overrides[key]; }
    } else { result[key] = overrides[key]; }
  }
  return result;
}
let TAB_SETTINGS = JSON.parse(JSON.stringify(DEFAULT_TAB_SETTINGS));

// ── Universal JSON extractor ─────────────────────────────────
// Claude sometimes returns plain text preambles or markdown fences.
// Try 5 strategies in order before giving up.
function extractJSON(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // Strategy 1: Direct parse (already valid JSON)
  try { return JSON.parse(raw); } catch(_) {}

  // Strategy 2: Strip markdown code fences  ```json ... ``` or ``` ... ```
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) { try { return JSON.parse(fenceMatch[1].trim()); } catch(_) {} }

  // Strategy 3: Greedy-match first { ... } or [ ... ] (handles preamble text)
  const objMatch = raw.match(/(\{[\s\S]*\})/s);
  if (objMatch) { try { return JSON.parse(objMatch[1].trim()); } catch(_) {} }
  const arrMatch = raw.match(/(\[[\s\S]*\])/s);
  if (arrMatch) { try { return JSON.parse(arrMatch[1].trim()); } catch(_) {} }

  // Strategy 4: Slice from first { or [ to matching last } or ]
  const fb = raw.indexOf('{'), fk = raw.indexOf('[');
  let si = -1;
  if (fb !== -1 && fk !== -1) si = Math.min(fb, fk);
  else if (fb !== -1) si = fb;
  else if (fk !== -1) si = fk;
  if (si !== -1) {
    const trimmed = raw.slice(si);
    const ei = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    if (ei !== -1) { try { return JSON.parse(trimmed.slice(0, ei + 1)); } catch(_) {} }
  }

  // Strategy 5: Fix common malformed JSON (trailing commas, unquoted keys)
  const cleaned = raw
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":');
  const co = cleaned.match(/(\{[\s\S]*\})/s);
  if (co) { try { return JSON.parse(co[1].trim()); } catch(_) {} }

  console.error('[extractJSON] All strategies failed. First 500 chars:', raw.slice(0, 500));
  return null;
}

// User auth state
let USERS          = {};   // { [userId]: { id, name, email, passwordHash, role, active, createdAt, stats } }
let SESSIONS       = {};   // { [token]: { userId, createdAt, expiresAt } }
let RESULTS_DB     = [];   // [{ id, userId, userName, score, total, subject, questions, completedAt }]
let RESET_REQUESTS = [];   // [{ id, userId, name, email, requestedAt, status }]
const SETTINGS = { registrationOpen: true, mockBarPublic: true };

// Pre-generated content per topic
// { [subject_key]: { [topic_name]: { lesson, mcq, essay, generatedAt } } }
let CONTENT = {};

// Generation queue state
const GEN = {
  running: false, total: 0, done: 0, current: '', errors: [],
  startedAt: null, finishedAt: null,
  clients: new Set(),
};

// Background job queue (reference summarisation + past bar extraction)
const JOB_MAP   = new Map();  // jobId → { status, result, error, createdAt }
const JOB_QUEUE = [];
let   JOB_RUNNING = false;

// ── Syllabus tree helpers ────────────────────────────────────
function generateId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

function findInChildren(children, id, parent) {
  for (const child of children) {
    if (child.id === id) return { node: child, parent };
    if (child.children?.length) {
      const found = findInChildren(child.children, id, child);
      if (found) return found;
    }
  }
  return null;
}

function findNodeById(sections, id) {
  for (const sec of sections) {
    if (sec.id === id) return { node: sec, parent: null };
    const found = findInChildren(sec.children || [], id, sec);
    if (found) return found;
  }
  return null;
}

function removeNodeById(sections, id) {
  const pdfsToDelete = [];
  function collectPdfs(node) {
    if (node.pdfId) pdfsToDelete.push(node.pdfId);
    (node.children || []).forEach(collectPdfs);
  }
  function removeFrom(arr) {
    const idx = arr.findIndex(n => n.id === id);
    if (idx !== -1) { collectPdfs(arr[idx]); arr.splice(idx, 1); return true; }
    for (const node of arr) {
      if (node.children?.length && removeFrom(node.children)) return true;
    }
    return false;
  }
  removeFrom(sections);
  return pdfsToDelete;
}

function getAllSubjectsWithSections() {
  return ['civil','criminal','political','labor','commercial','taxation','remedial','ethics','custom'];
}

function migrateSyllabusIfNeeded() {
  if (!KB.syllabus) {
    KB.syllabus = { subjects: {} };
    getAllSubjectsWithSections().forEach(s => { KB.syllabus.subjects[s] = { sections: [] }; });
    saveKB();
    return;
  }
  if (!KB.syllabus.subjects) {
    // Old format: { name, topics: [{key, name, topics:[]}], ... }
    const oldTopics = KB.syllabus.topics || [];
    const newSubjects = {};
    getAllSubjectsWithSections().forEach(s => { newSubjects[s] = { sections: [] }; });
    oldTopics.forEach(subjEntry => {
      const key = subjEntry.key;
      if (!newSubjects[key]) newSubjects[key] = { sections: [] };
      newSubjects[key].sections = convertOldTopicsToSections(subjEntry.topics || []);
    });
    KB.syllabus = { subjects: newSubjects };
    saveKB();
    console.log('[syllabus] Migrated to manual builder format');
  } else {
    // Ensure all subjects exist
    getAllSubjectsWithSections().forEach(s => {
      if (!KB.syllabus.subjects[s]) KB.syllabus.subjects[s] = { sections: [] };
    });
  }
}

function convertOldTopicsToSections(topics) {
  if (!topics || !topics.length) return [];
  return [{
    id: generateId('sec'),
    type: 'section',
    label: 'I',
    title: 'IMPORTED TOPICS',
    children: topics.map(t => ({
      id: generateId('top'),
      type: (t.children?.length || t.subtopics?.length) ? 'group' : 'topic',
      label: t.label || '?',
      title: t.name || t.title || 'Unknown Topic',
      pdfId: null,
      pdfName: null,
      children: ((t.children || []).concat(t.subtopics || [])).map(c => ({
        id: generateId('sub'),
        type: 'topic',
        label: c.label || '?',
        title: c.name || c.title || '',
        pdfId: null,
        pdfName: null,
        children: [],
      })),
    })),
  }];
}

function loadData() {
  const persistent = !!process.env.PERSISTENT_STORAGE_PATH;
  console.log(`Storage: ${persistent ? '✅ Persistent (Railway Volume)' : '⚠️  Ephemeral (local)'} → ${UPLOADS_DIR}`);
  try {
    if (fs.existsSync(KB_PATH))           Object.assign(KB, JSON.parse(fs.readFileSync(KB_PATH, 'utf8')));
    if (fs.existsSync(CONTENT_PATH))      CONTENT = JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'));
    if (fs.existsSync(TAB_SETTINGS_PATH)) {
      const saved = JSON.parse(fs.readFileSync(TAB_SETTINGS_PATH, 'utf8'));
      TAB_SETTINGS = deepMerge(JSON.parse(JSON.stringify(DEFAULT_TAB_SETTINGS)), saved);
    }
    const n = Object.values(CONTENT).reduce((a,s) => a+Object.keys(s).length, 0);
    console.log(`KB loaded: syllabus=${!!KB.syllabus}, refs=${KB.references.length}, pastBar=${KB.pastBar.length}, content=${n} topics`);
    console.log(`Tab settings loaded (overview=${TAB_SETTINGS.overview})`);
  } catch(e) { console.error('Load error:', e.message); }
}
function saveKB()          { try { fs.writeFileSync(KB_PATH, JSON.stringify(KB)); } catch(e) { console.error('KB save:', e.message); } }
function saveContent()     { try { fs.writeFileSync(CONTENT_PATH, JSON.stringify(CONTENT)); } catch(e) { console.error('Content save:', e.message); } }
function saveTabSettings() { try { fs.writeFileSync(TAB_SETTINGS_PATH, JSON.stringify(TAB_SETTINGS)); } catch(e) { console.error('Tab settings save:', e.message); } }
function saveUsers()         { try { fs.writeFileSync(USERS_PATH,          JSON.stringify(USERS));          } catch(e) { console.error('Users save:', e.message); } }
function saveSessions()      { try { fs.writeFileSync(SESSIONS_PATH,       JSON.stringify(SESSIONS));       } catch(e) { console.error('Sessions save:', e.message); } }
function saveResults()       { try { fs.writeFileSync(RESULTS_PATH,        JSON.stringify(RESULTS_DB));     } catch(e) { console.error('Results save:', e.message); } }
function saveSettings()      { try { fs.writeFileSync(SETTINGS_PATH,       JSON.stringify(SETTINGS));       } catch(e) { console.error('Settings save:', e.message); } }
function saveResetRequests() { try { fs.writeFileSync(RESET_REQUESTS_PATH, JSON.stringify(RESET_REQUESTS)); } catch(e) { console.error('ResetReqs save:', e.message); } }

function loadUserData() {
  try {
    if (fs.existsSync(USERS_PATH))          USERS          = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    if (fs.existsSync(SESSIONS_PATH))       SESSIONS       = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    if (fs.existsSync(RESULTS_PATH))        RESULTS_DB     = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    if (fs.existsSync(RESET_REQUESTS_PATH)) RESET_REQUESTS = JSON.parse(fs.readFileSync(RESET_REQUESTS_PATH, 'utf8'));
    if (fs.existsSync(SETTINGS_PATH)) Object.assign(SETTINGS, JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')));
    // Clean expired sessions on startup
    const now = Date.now();
    let cleaned = 0;
    for (const token of Object.keys(SESSIONS)) {
      if (SESSIONS[token].expiresAt < now) { delete SESSIONS[token]; cleaned++; }
    }
    if (cleaned > 0) saveSessions();
    console.log(`Users: ${Object.keys(USERS).length}, Sessions: ${Object.keys(SESSIONS).length}, Results: ${RESULTS_DB.length}`);
  } catch(e) { console.error('loadUserData error:', e.message); }
}

// ── Auth helpers ─────────────────────────────────────────────
function hashPassword(pw) {
  return crypto.createHash('sha256').update('barbuddy_salt_2025' + pw).digest('hex');
}
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}
function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token || !SESSIONS[token]) return res.status(401).json({ error: 'Not authenticated' });
  if (SESSIONS[token].expiresAt < Date.now()) {
    delete SESSIONS[token];
    saveSessions();
    return res.status(401).json({ error: 'Session expired' });
  }
  req.userId = SESSIONS[token].userId;
  req.user   = USERS[req.userId];
  next();
}

loadData();
loadUserData();
migrateSyllabusIfNeeded();

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function adminOnly(req, res, next) {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function authOrAdmin(req, res, next) {
  const adminKey = req.headers['x-admin-key'] || req.body?.adminKey;
  if (adminKey === ADMIN_KEY) return next();
  const token = req.headers['x-session-token'];
  if (!token || !SESSIONS[token]) return res.status(401).json({ error: 'Not authenticated' });
  if (SESSIONS[token].expiresAt < Date.now()) {
    delete SESSIONS[token]; saveSessions();
    return res.status(401).json({ error: 'Session expired' });
  }
  req.userId = SESSIONS[token].userId;
  req.user   = USERS[req.userId];
  next();
}

// ── Auth routes ──────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  if (!SETTINGS.registrationOpen) return res.status(403).json({ error: 'Registration is currently closed' });
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });
  const existing = Object.values(USERS).find(u => u.email === email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const id = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  USERS[id] = {
    id, name: name.trim(), email: email.toLowerCase(),
    passwordHash: hashPassword(password),
    role: 'student', active: true,
    createdAt: new Date().toISOString(),
    stats: { totalAttempts: 0, totalScore: 0, totalQuestions: 0 },
  };
  saveUsers();
  const token = generateToken();
  SESSIONS[token] = { userId: id, createdAt: Date.now(), expiresAt: Date.now() + 86400000 };
  saveSessions();
  res.json({ token, user: { id, name: USERS[id].name, email: USERS[id].email, role: USERS[id].role } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const user = Object.values(USERS).find(u => u.email === email.toLowerCase());
  if (!user || user.passwordHash !== hashPassword(password)) return res.status(401).json({ error: 'Invalid email or password' });
  if (!user.active) return res.status(403).json({ error: 'Account is disabled' });
  const token = generateToken();
  SESSIONS[token] = { userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + 86400000 };
  saveSessions();
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const token = req.headers['x-session-token'];
  delete SESSIONS[token];
  saveSessions();
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role });
});

// ── Password reset routes ─────────────────────────────────────
app.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  const user = Object.values(USERS).find(u => u.email === email.toLowerCase());
  if (user) {
    const existing = RESET_REQUESTS.find(r => r.email === user.email && r.status === 'pending');
    if (!existing) {
      RESET_REQUESTS.unshift({
        id: 'reset_' + Date.now(),
        userId: user.id,
        name: user.name,
        email: user.email,
        requestedAt: new Date().toISOString(),
        status: 'pending',
      });
      saveResetRequests();
    }
  }
  res.json({ success: true }); // always success — don't reveal if email exists
});

app.get('/api/admin/reset-requests', adminOnly, (_req, res) => {
  const sorted = [...RESET_REQUESTS].sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  res.json(sorted);
});

app.post('/api/admin/reset-password', adminOnly, (req, res) => {
  const { userId, newPassword, requestId } = req.body || {};
  if (!userId || !newPassword) return res.status(400).json({ error: 'userId and newPassword required' });
  const user = USERS[userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.passwordHash = hashPassword(newPassword);
  saveUsers();
  if (requestId) {
    const req_ = RESET_REQUESTS.find(r => r.id === requestId);
    if (req_) { req_.status = 'resolved'; req_.resolvedAt = new Date().toISOString(); }
    saveResetRequests();
  }
  res.json({ success: true });
});

app.delete('/api/admin/reset-requests/:id', adminOnly, (req, res) => {
  const item = RESET_REQUESTS.find(r => r.id === req.params.id);
  if (item) { item.status = 'dismissed'; saveResetRequests(); }
  res.json({ ok: true });
});

// ── Settings routes ───────────────────────────────────────────
app.get('/api/settings', (_req, res) => res.json(SETTINGS));

app.post('/api/admin/settings', adminOnly, (req, res) => {
  const { registrationOpen, mockBarPublic } = req.body || {};
  if (registrationOpen !== undefined) SETTINGS.registrationOpen = !!registrationOpen;
  if (mockBarPublic     !== undefined) SETTINGS.mockBarPublic     = !!mockBarPublic;
  saveSettings();
  res.json(SETTINGS);
});

// ── Results routes ────────────────────────────────────────────
app.post('/api/results/save', requireAuth, (req, res) => {
  const { score, total, subject, questions, timeTakenMs } = req.body || {};
  if (score === undefined || !total) return res.status(400).json({ error: 'score and total required' });
  const id = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const result = {
    id, userId: req.userId, userName: req.user.name,
    score, total, subject: subject || 'Mixed',
    questions: questions || [],
    timeTakenMs: timeTakenMs || null,
    completedAt: new Date().toISOString(),
  };
  RESULTS_DB.push(result);
  saveResults();
  // Update user stats
  const u = USERS[req.userId];
  u.stats.totalAttempts++;
  u.stats.totalScore     += score;
  u.stats.totalQuestions += total;
  saveUsers();
  res.json({ ok: true, id });
});

app.get('/api/admin/results', adminOnly, (_req, res) => {
  const sorted = [...RESULTS_DB].sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  res.json(sorted);
});

app.get('/api/admin/results/:userId', adminOnly, (req, res) => {
  const results = RESULTS_DB.filter(r => r.userId === req.params.userId)
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  res.json(results);
});

app.delete('/api/admin/results/:resultId', adminOnly, (req, res) => {
  const idx = RESULTS_DB.findIndex(r => r.id === req.params.resultId);
  if (idx === -1) return res.status(404).json({ error: 'Result not found' });
  RESULTS_DB.splice(idx, 1);
  saveResults();
  res.json({ ok: true });
});

// ── Admin user-management routes ──────────────────────────────
app.get('/api/admin/users', adminOnly, (_req, res) => {
  const list = Object.values(USERS).map(u => ({
    id: u.id, name: u.name, email: u.email, role: u.role,
    active: u.active, createdAt: u.createdAt, stats: u.stats,
    tabSettings: u.tabSettings || null,
  })).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

app.patch('/api/admin/users/:userId', adminOnly, (req, res) => {
  const user = USERS[req.params.userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { active, role } = req.body || {};
  if (active !== undefined) user.active = !!active;
  if (role   !== undefined) user.role   = role;
  saveUsers();
  res.json({ ok: true });
});

app.delete('/api/admin/users/:userId', adminOnly, (req, res) => {
  if (!USERS[req.params.userId]) return res.status(404).json({ error: 'User not found' });
  delete USERS[req.params.userId];
  // Also remove their sessions
  for (const [token, s] of Object.entries(SESSIONS)) {
    if (s.userId === req.params.userId) delete SESSIONS[token];
  }
  saveUsers();
  saveSessions();
  res.json({ ok: true });
});

// ── ADMIN: Parse uploaded file to text ─────────────────────
app.post('/api/admin/parse-file', adminOnly, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  try {
    let text = '';
    if (ext === '.pdf') {
      const data = await pdfParse(req.file.buffer);
      text = data.text;
    } else if (ext === '.docx' || ext === '.doc') {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;
    } else {
      text = req.file.buffer.toString('utf8');
    }
    res.json({ text: text.trim() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to extract text: ' + err.message });
  }
});

// ── Health ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const n = Object.values(CONTENT).reduce((a,s) => a+Object.keys(s).length, 0);
  res.json({ status:'ok', keySet:!!API_KEY, kb:{ hasSyllabus:!!KB.syllabus, refs:KB.references.length, pastBar:KB.pastBar.length }, content:{ topics:n }, gen:{ running:GEN.running, done:GEN.done, total:GEN.total } });
});

// ── Tab settings (public read, admin write) ──────────────────
app.get('/api/tab-settings', (_req, res) => res.json({ ...TAB_SETTINGS }));

app.post('/api/admin/tab-settings', adminOnly, (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Invalid settings object' });
  TAB_SETTINGS = deepMerge(JSON.parse(JSON.stringify(DEFAULT_TAB_SETTINGS)), incoming);
  saveTabSettings();
  res.json({ success: true, settings: TAB_SETTINGS });
});

// ── Per-user topic progress ──────────────────────────────────
app.get('/api/user/progress', requireAuth, (req, res) => {
  res.json({ progress: req.user.progress || {} });
});

app.post('/api/user/progress', requireAuth, (req, res) => {
  const { subject, topicId, done } = req.body;
  if (!subject || !topicId) return res.status(400).json({ error: 'subject and topicId required' });
  const user = USERS[req.userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.progress) user.progress = {};
  if (!user.progress[subject]) user.progress[subject] = {};
  if (done) user.progress[subject][topicId] = true;
  else delete user.progress[subject][topicId];
  saveUsers();
  res.json({ success: true });
});

// ── Per-user tab settings (admin-managed, merged with global) ─
app.get('/api/user/tab-settings', requireAuth, (req, res) => {
  const userTS = req.user.tabSettings || null;
  // Start from global settings, then apply personal restrictions (AND logic — global disabled always wins)
  const merged = JSON.parse(JSON.stringify(TAB_SETTINGS));
  if (userTS) {
    for (const subj of Object.keys(merged.subjects || {})) {
      for (const mode of Object.keys(merged.subjects[subj] || {})) {
        const personalVal = userTS.subjects?.[subj]?.[mode];
        if (personalVal === false) merged.subjects[subj][mode] = false;
      }
    }
    if (userTS.overview === false) merged.overview = false;
  }
  res.json(merged);
});

app.get('/api/admin/users/:userId/tab-settings', adminOnly, (req, res) => {
  const user = USERS[req.params.userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ tabSettings: user.tabSettings || null });
});

app.patch('/api/admin/users/:userId/tab-settings', adminOnly, (req, res) => {
  const user = USERS[req.params.userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.tabSettings = req.body.tabSettings || null;
  saveUsers();
  res.json({ ok: true });
});

app.delete('/api/admin/users/:userId/tab-settings', adminOnly, (req, res) => {
  const user = USERS[req.params.userId];
  if (!user) return res.status(404).json({ error: 'User not found' });
  delete user.tabSettings;
  saveUsers();
  res.json({ ok: true });
});

// ── GET KB state (public — browser caches) ─────────────────
app.get('/api/kb', (req, res) => {
  const n = Object.values(CONTENT).reduce((a,s) => a+Object.keys(s).length, 0);
  res.json({
    hasSyllabus:    !!(KB.syllabus?.subjects),
    syllabusTopics: [],  // legacy field (new format uses /api/syllabus/:subject)
    references:     KB.references.map(r => ({ id:r.id, name:r.name, subject:r.subject, type:r.type, size:r.size, uploadedAt:r.uploadedAt })),
    pastBar:        KB.pastBar.map(p  => ({ id:p.id, name:p.name, subject:p.subject, year:p.year, qCount:p.questions?.length||0, uploadedAt:p.uploadedAt })),
    contentTopics:  n,
    genState:       { running:GEN.running, done:GEN.done, total:GEN.total, current:GEN.current, finishedAt:GEN.finishedAt },
    customRefs:     KB.references.filter(r => r.subject === 'custom').length,
    customPastBar:  KB.pastBar.filter(p => p.subject === 'custom').length,
    customQuestions:KB.pastBar.filter(p => p.subject === 'custom').reduce((a,p) => a + (p.questions?.length||0), 0),
  });
});

// ── GET pre-generated content for one topic ─────────────────
app.get('/api/content/:subject/:topic', (req, res) => {
  const data = CONTENT[req.params.subject]?.[decodeURIComponent(req.params.topic)];
  if (data) return res.json({ found:true, ...data });
  res.json({ found:false });
});

// ── GET full content dump (browser caches on load) ──────────
app.get('/api/content', (req, res) => {
  const { subject } = req.query;
  if (subject && VALID_SUBJECTS.includes(subject) && CONTENT[subject]) {
    return res.json({ [subject]: CONTENT[subject] });
  }
  res.json(CONTENT);
});

// ── SSE: live generation progress ──────────────────────────
app.get('/api/gen/progress', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  GEN.clients.add(res);
  sseSend(res, { done:GEN.done, total:GEN.total, current:GEN.current, running:GEN.running, finished:!!GEN.finishedAt&&!GEN.running });
  req.on('close', () => GEN.clients.delete(res));
});

function sseSend(client, data) { try { client.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e){} }
function broadcast() {
  const msg = { done:GEN.done, total:GEN.total, current:GEN.current, running:GEN.running, finished:!!GEN.finishedAt&&!GEN.running, errors:GEN.errors.length };
  GEN.clients.forEach(c => sseSend(c, msg));
}

// ── SYLLABUS HELPERS ────────────────────────────────────────
function countAllTopics(topics) {
  let n = 0;
  function walk(items) { (items||[]).forEach(t => { n++; walk(t.subtopics); walk(t.children); }); }
  walk(topics);
  return n;
}

// Recursively force every node to inherit the parent subject key
function validateAndCleanParsed(parsed) {
  const VALID_KEYS = ['civil','criminal','political','labor','commercial','taxation','remedial','ethics'];
  parsed.subjects = (parsed.subjects||[]).filter(s => {
    if (!VALID_KEYS.includes(s.key)) { console.warn(`[syllabus] Invalid key "${s.key}" — skipped`); return false; }
    return true;
  });
  function tagTopics(topics, key) {
    return (topics||[]).map(t => ({ ...t, subject:key, subtopics:tagTopics(t.subtopics,key), children:tagTopics(t.children,key) }));
  }
  parsed.subjects = parsed.subjects.map(s => ({ ...s, topics:tagTopics(s.topics, s.key) }));
  return parsed;
}

// Keyword-based sanity check — logs warnings, never moves topics
function crossCheckSubjectAssignment(parsed) {
  const KW = {
    labor:      ['labor code','dole','employment','wages','termination','leave','telecommuting','poea','overseas worker','union','cba','collective bargaining','strike','lockout','maternity','paternity','gynecological','social legislation'],
    civil:      ['civil code','ncc','obligations','contracts','property','succession','family code','marriage','adoption','torts','damages'],
    criminal:   ['revised penal code','felony','crime','penalty','conspiracy','recidivism','special penal'],
    political:  ['constitution','sovereignty','due process','equal protection','bill of rights','administrative law'],
    commercial: ['corporation code','partnership','negotiable instruments','insurance','banking','intellectual property'],
    taxation:   ['nirc','income tax','estate tax','donor tax','tariff','value-added'],
    remedial:   ['rules of court','civil procedure','criminal procedure','jurisdiction','pleadings','appeals','special proceedings'],
    ethics:     ['legal ethics','notarial','disbarment','attorney','code of professional'],
  };
  const warnings = [];
  parsed.subjects.forEach(subj => {
    function check(topics) {
      (topics||[]).forEach(t => {
        const low = t.name.toLowerCase();
        Object.entries(KW).forEach(([other, kws]) => {
          if (other === subj.key) return;
          const hits = kws.filter(k => low.includes(k));
          if (hits.length >= 2) warnings.push({ topic:t.name, assignedTo:subj.key, possiblyBelongsTo:other, matchedKeywords:hits });
        });
        check(t.subtopics); check(t.children);
      });
    }
    check(subj.topics);
  });
  if (warnings.length) {
    console.warn('[syllabus] Assignment warnings:');
    warnings.forEach(w => console.warn(`  "${w.topic}" under ${w.assignedTo} — keywords suggest ${w.possiblyBelongsTo}`));
  }
  return { parsed, warnings };
}

// Flatten all non-group leaf topics for the generation queue
function flattenTopicsForGen(topics, subjKey, subjName) {
  const result = [];
  function walk(items) {
    (items||[]).forEach(t => {
      if (!t.isGroup) result.push({ subjKey, subjName, topicName:t.name, subtopics:[...(t.subtopics||[]),(t.children||[])].filter(x=>typeof x==='object').map(x=>x.name||x) });
      walk(t.subtopics); walk(t.children);
    });
  }
  walk(topics);
  return result;
}

// Two-pass Claude parse for long documents (>14 000 chars)
async function parseSyllabusInPasses(content) {
  const SUBJECT_MAP = { civil:'Civil Law', criminal:'Criminal Law', political:'Political Law', labor:'Labor Law and Social Legislation', commercial:'Commercial Law', taxation:'Taxation', remedial:'Remedial Law', ethics:'Legal and Judicial Ethics' };
  // Pass 1 — find subject boundaries
  const p1 = `This is a Philippine Bar Exam Syllabus. Find where each of the 8 bar subject sections starts.
Subjects: Civil Law, Criminal Law, Political Law, Labor Law and Social Legislation, Commercial Law, Taxation, Remedial Law, Legal and Judicial Ethics.
Return ONLY valid JSON with no markdown. DO NOT write any explanation. Start immediately with {:
{ "sections": [ { "subject":"political","subjectName":"Political Law","headerText":"exact header as it appears in text" } ] }
Document (first 8000 chars):
${content.slice(0,8000)}`;
  const bounds = await callClaudeJSON([{role:'user',content:p1}], 1500);
  if (!bounds) throw new Error('Failed to identify subject boundaries — Claude did not return valid JSON');

  // Resolve character positions
  const sections = [];
  (bounds.sections||[]).forEach((b,i) => {
    const start = content.indexOf(b.headerText);
    if (start === -1) return;
    const next = (bounds.sections||[]).slice(i+1).find(s => content.indexOf(s.headerText) > start);
    const end   = next ? content.indexOf(next.headerText) : content.length;
    sections.push({ subject:b.subject, subjectName:b.subjectName||SUBJECT_MAP[b.subject]||b.subject, text:content.slice(start,end) });
  });

  // Pass 2 — parse each section individually
  const allSubjects = [];
  for (const sec of sections) {
    await sleep(800);
    const p2 = `Parse ONLY this ${sec.subjectName} section of a Philippine Bar Exam Syllabus.
Subject key: "${sec.subject}". Extract ALL topics in the EXACT ORDER they appear.
Preserve full hierarchy. Tag every item with subject:"${sec.subject}".
Output ONLY the JSON object below — no words before or after it, no markdown fences:
{ "key":"${sec.subject}","name":"${sec.subjectName}","topics":[{"name":"exact name","isGroup":false,"subject":"${sec.subject}","subtopics":[],"children":[]}] }
Section text:
${sec.text.slice(0,6000)}`;
    const parsed = await callClaudeJSON([{role:'user',content:p2}], 3000);
    if (!parsed) {
      console.warn(`[syllabus] Pass 2 parse failed for ${sec.subjectName} — skipping subject`);
      continue;
    }
    function forceSubj(topics, key) {
      return (topics||[]).map(t => ({ ...t, subject:key, subtopics:forceSubj(t.subtopics,key), children:forceSubj(t.children,key) }));
    }
    allSubjects.push({ key:sec.subject, name:sec.subjectName, topics:forceSubj(parsed.topics||[], sec.subject) });
    console.log(`[syllabus] Parsed ${sec.subjectName}: ${parsed.topics?.length||0} top-level items`);
  }
  return { subjects: allSubjects };
}

// AI syllabus parser — single-pass for short docs, two-pass for long ones
async function parseSyllabusWithAI(content) {
  if (content.length > 14000) {
    return await parseSyllabusInPasses(content);
  }
  const prompt = `You are parsing a Philippine Bar Exam Syllabus. Extract ALL topics for EACH subject in the EXACT ORDER they appear in the document.
Preserve the full hierarchy: group headers, parent topics, and leaf topics.
The 8 subjects are: Civil Law (civil), Criminal Law (criminal), Political Law (political), Labor Law and Social Legislation (labor), Commercial Law (commercial), Taxation (taxation), Remedial Law (remedial), Legal and Judicial Ethics (ethics).

Rules:
- Keep ALL topics in the ORDER they appear
- isGroup:true for section headers that contain subtopics but are not themselves testable topics
- isGroup:false for actual testable topics
- Put sub-items inside subtopics[] or children[] of their parent
- subject field must match the parent subject key exactly
- Do NOT merge or skip topics

OUTPUT FORMAT — CRITICAL:
- Output ONLY the JSON object. No words before it. No words after it. No markdown fences.
- Do NOT say "Looking at this document", "Here is the parsed structure", or any preamble.
- Start your response with { and end with }
{"subjects":[{"key":"civil","name":"Civil Law","topics":[{"name":"exact topic name","isGroup":false,"subject":"civil","subtopics":[],"children":[]}]}]}

Syllabus text:
${content.slice(0, 14000)}`;
  return await callClaudeJSON([{ role:'user', content:prompt }], 4000);
}

// ── SYLLABUS: PDF token (for iframe auth — iframes can't send custom headers) ─
app.get('/api/syllabus/pdf-token/:nodeId', requireAuth, (req, res) => {
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

// ── SYLLABUS: PDF file serving ────────────────────────────────
// NOTE: must come BEFORE /api/syllabus/:subject to avoid routing conflict
// Auth: header session token (direct), query ?token (iframes), or admin key
app.get('/api/syllabus/pdf/:nodeId', (req, res) => {
  const { nodeId } = req.params;
  const { token } = req.query;
  let authenticated = false;

  // Method 1: admin key header
  const aKey = req.headers['x-admin-key'];
  if (aKey === ADMIN_KEY) authenticated = true;

  // Method 2: standard session token header (direct API calls)
  if (!authenticated) {
    const headerToken = req.headers['x-session-token'];
    if (headerToken && SESSIONS[headerToken] && SESSIONS[headerToken].expiresAt > Date.now()) {
      authenticated = true;
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

app.get('/api/syllabus', authOrAdmin, (req, res) => {
  res.json({ subjects: KB.syllabus?.subjects || {} });
});

app.get('/api/syllabus/:subject', authOrAdmin, (req, res) => {
  const subj = req.params.subject;
  if (!getAllSubjectsWithSections().includes(subj)) return res.status(400).json({ error: 'Invalid subject' });
  res.json(KB.syllabus?.subjects?.[subj] || { sections: [] });
});

// ── SYLLABUS: Admin write routes ──────────────────────────────
app.post('/api/admin/syllabus/:subject/section', adminOnly, (req, res) => {
  const subj = req.params.subject;
  if (!getAllSubjectsWithSections().includes(subj)) return res.status(400).json({ error: 'Invalid subject' });
  const { label, title } = req.body || {};
  if (!label || !title) return res.status(400).json({ error: 'label and title required' });
  const section = { id: generateId('sec'), type: 'section', label: label.toUpperCase(), title: title.toUpperCase(), children: [] };
  KB.syllabus.subjects[subj].sections.push(section);
  saveKB();
  res.json(KB.syllabus.subjects[subj]);
});

app.post('/api/admin/syllabus/:subject/node', adminOnly, (req, res) => {
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
  saveKB();
  res.json(KB.syllabus.subjects[subj]);
});

app.patch('/api/admin/syllabus/:subject/node/:nodeId', adminOnly, (req, res) => {
  const subj = req.params.subject;
  if (!getAllSubjectsWithSections().includes(subj)) return res.status(400).json({ error: 'Invalid subject' });
  const sections = KB.syllabus.subjects[subj].sections;
  const found = findNodeById(sections, req.params.nodeId);
  if (!found) return res.status(404).json({ error: 'Node not found' });
  const { label, title, type } = req.body || {};
  if (label !== undefined) found.node.label = label;
  if (title !== undefined) found.node.title = title;
  if (type  !== undefined) found.node.type  = type;
  saveKB();
  res.json(KB.syllabus.subjects[subj]);
});

app.delete('/api/admin/syllabus/:subject/node/:nodeId', adminOnly, (req, res) => {
  const subj = req.params.subject;
  if (!getAllSubjectsWithSections().includes(subj)) return res.status(400).json({ error: 'Invalid subject' });
  const pdfsToDelete = removeNodeById(KB.syllabus.subjects[subj].sections, req.params.nodeId);
  pdfsToDelete.forEach(pdfId => {
    const filePath = path.join(SYLLABUS_PDFS_DIR, pdfId);
    if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch(e) {} }
  });
  saveKB();
  res.json(KB.syllabus.subjects[subj]);
});

app.post('/api/admin/syllabus/:subject/node/:nodeId/pdf', adminOnly, (req, res) => {
  makeSyllabusUpload().single('pdf')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const subj = req.params.subject;
    if (!getAllSubjectsWithSections().includes(subj)) return res.status(400).json({ error: 'Invalid subject' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const sections = KB.syllabus.subjects[subj].sections;
    const found = findNodeById(sections, req.params.nodeId);
    if (!found) {
      // Cleanup orphan file
      try { fs.unlinkSync(req.file.path); } catch(e) {}
      return res.status(404).json({ error: 'Node not found' });
    }
    // Delete old PDF file if it exists
    if (found.node.pdfId) {
      const oldPath = path.join(SYLLABUS_PDFS_DIR, found.node.pdfId);
      if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch(e) {} }
    }
    found.node.pdfId   = req.file.filename;
    found.node.pdfName = req.file.originalname;
    saveKB();
    res.json({ pdfId: req.file.filename, pdfName: req.file.originalname });
  });
});

app.delete('/api/admin/syllabus/:subject/node/:nodeId/pdf', adminOnly, (req, res) => {
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
    saveKB();
  }
  res.json({ success: true });
});

app.post('/api/admin/syllabus/:subject/reorder', adminOnly, (req, res) => {
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
  saveKB();
  res.json(KB.syllabus.subjects[subj]);
});

// ── ADMIN: Upload Reference — save instantly, summarise in background ──
app.post('/api/admin/reference', adminOnly, (req, res) => {
  const { name, subject, type, content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const id = `ref_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  KB.references.push({ id, name, subject:subject||'general', type:type||'other', text:content.slice(0,30000), summary:'processing', size:content.length, uploadedAt:new Date().toISOString() });
  saveKB();
  const jobId = enqueueJob(async () => {
    const summary = await summarizeLargeDoc(content, name, subject||'general');
    const ref = KB.references.find(r => r.id === id);
    if (ref) { ref.summary = summary; saveKB(); }
    if (KB.syllabus) triggerPreGenerationForSubject(subject);
    return { id, name };
  });
  res.json({ success:true, id, name, jobId });
});

// ── ADMIN: Upload Past Bar — save instantly, extract via job queue ──
app.post('/api/admin/pastbar', adminOnly, (req, res) => {
  const { name, subject, year, content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const id = `pb_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  KB.pastBar.push({ id, name, subject:subject||'general', year:year||'Unknown', questions:[], rawText:content.slice(0,30000), extracting:true, uploadedAt:new Date().toISOString() });
  saveKB();
  const jobId = enqueueJob(async () => {
    await extractPastBarInBackground(id, content, name, subject||'general', year);
    const entry = KB.pastBar.find(p => p.id === id);
    return { id, name, questionsExtracted: entry?.questions?.length || 0 };
  });
  res.json({ success:true, id, name, jobId });
});

// ── ADMIN: Download all past bar questions ───────────────────
app.get('/api/admin/pastbar/download-all', adminOnly, (_req, res) => {
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
app.get('/api/admin/pastbar/:id/download', adminOnly, (req, res) => {
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
    lines.push(`Exported: ${new Date().toLocaleString()}`);
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
<div class="meta"><div><strong>Exported:</strong> ${new Date().toLocaleString()}</div><div><strong>Total Questions:</strong> ${qs.length}</div></div>
${qHtml}
<div style="margin-top:30px;padding-top:10px;border-top:1px solid #ccc;font-size:11px;color:#888;text-align:center;">Generated by BarBuddy — Philippine Bar Exam Companion</div>
<script>window.onload=()=>window.print();</script>
</body></html>`);
  }

  res.status(400).json({ error: 'format must be json, txt, or pdf' });
});

// ── ADMIN: Past Bar extraction status (legacy) ───────────────
app.get('/api/admin/pastbar/:id/status', adminOnly, (req, res) => {
  const entry = KB.pastBar.find(p => p.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  res.json({ extracting: entry.extracting || false, questionsExtracted: entry.questions?.length || 0, extractError: entry.extractError || null });
});

// ── Job queue status ─────────────────────────────────────────
app.get('/api/job/:jobId', adminOnly, (req, res) => {
  const job = JOB_MAP.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });
  res.json({ status: job.status, result: job.result, error: job.error });
});

// ── ADMIN: Storage info ──────────────────────────────────────
app.get('/api/storage-info', adminOnly, (_req, res) => {
  const persistent = !!process.env.PERSISTENT_STORAGE_PATH;
  let kbSize = 0, contentSize = 0;
  try { kbSize = fs.existsSync(KB_PATH) ? fs.statSync(KB_PATH).size : 0; } catch(_) {}
  try { contentSize = fs.existsSync(CONTENT_PATH) ? fs.statSync(CONTENT_PATH).size : 0; } catch(_) {}
  res.json({
    persistent,
    storageDir: UPLOADS_DIR,
    envVar: process.env.PERSISTENT_STORAGE_PATH || null,
    files: {
      'kb.json':      { exists: fs.existsSync(KB_PATH),      bytes: kbSize },
      'content.json': { exists: fs.existsSync(CONTENT_PATH), bytes: contentSize },
    },
  });
});

// ── ADMIN: Delete ───────────────────────────────────────────
app.delete('/api/admin/reference/:id', adminOnly, (req, res) => {
  KB.references = KB.references.filter(r => r.id !== req.params.id);
  KB.pastBar    = KB.pastBar.filter(p => p.id !== req.params.id);
  saveKB(); res.json({ success:true });
});
app.delete('/api/admin/syllabus', adminOnly, (req, res) => {
  // Reset all subjects to empty sections (new format)
  KB.syllabus = { subjects: {} };
  getAllSubjectsWithSections().forEach(s => { KB.syllabus.subjects[s] = { sections: [] }; });
  CONTENT = {}; saveKB(); saveContent(); res.json({ success: true });
});
app.delete('/api/admin/content', adminOnly, (req, res) => {
  CONTENT = {}; saveContent(); res.json({ success:true });
});

// ── ADMIN: Manually trigger generation ─────────────────────
app.post('/api/admin/generate', adminOnly, (req, res) => {
  if (!KB.syllabus) return res.status(400).json({ error:'No syllabus' });
  if (GEN.running) return res.json({ message:'Already running', done:GEN.done, total:GEN.total });
  triggerPreGeneration();
  const topicsArr = (KB.syllabus.topics || []).flatMap(s => s.topics || []);
  res.json({ message:'Started', total:countAllTopics(topicsArr) });
});

// ── PRE-GENERATION ENGINE ───────────────────────────────────
async function triggerPreGeneration() {
  if (GEN.running || !KB.syllabus) return;
  const queue = [];
  // Support both old format (.topics[]) and new format (.subjects{})
  const oldTopics = KB.syllabus.topics || [];
  oldTopics.forEach(subj => {
    if (!VALID_SUBJECTS.includes(subj.key)) return;
    queue.push(...flattenTopicsForGen(subj.topics, subj.key, subj.name));
  });
  if (!queue.length) return;
  await runGenQueue(queue);
}

async function triggerPreGenerationForSubject(subjKey) {
  if (GEN.running || !KB.syllabus) return;
  if (!VALID_SUBJECTS.includes(subjKey)) return;
  // Support both formats
  const subj = (KB.syllabus.topics || []).find(s => s.key === subjKey);
  if (!subj) return;
  delete CONTENT[subjKey];
  const queue = flattenTopicsForGen(subj.topics, subjKey, subj.name);
  await runGenQueue(queue);
}

async function runGenQueue(queue) {
  GEN.running = true; GEN.total = queue.length; GEN.done = 0;
  GEN.errors = []; GEN.startedAt = new Date().toISOString(); GEN.finishedAt = null;
  broadcast();
  for (const item of queue) {
    GEN.current = `${item.subjName} → ${item.topicName}`;
    broadcast();
    try { await generateTopicContent(item.subjKey, item.topicName, item.subtopics); GEN.done++; saveContent(); }
    catch(e) { console.error(`Gen error [${item.topicName}]:`, e.message); GEN.errors.push({ topic:item.topicName, error:e.message }); GEN.done++; }
    broadcast();
    await sleep(600); // rate-limit buffer
  }
  GEN.running = false; GEN.current = ''; GEN.finishedAt = new Date().toISOString();
  broadcast(); saveContent();
  console.log(`Pre-gen complete: ${GEN.done}/${GEN.total} | errors: ${GEN.errors.length}`);
}

async function generateTopicContent(subjKey, topicName, subtopics) {
  // a) Skip entirely if no reference materials exist for this exact subject
  const refs = KB.references.filter(r => r.subject===subjKey);
  if (!refs.length) {
    if (!CONTENT[subjKey]) CONTENT[subjKey] = {};
    CONTENT[subjKey][topicName] = {
      lesson: null, mcq: null, essay: null,
      status: 'no_materials',
      message: 'No reference materials uploaded for this subject yet. Go to Admin and upload reference materials for this subject first.',
      generatedAt: new Date().toISOString(),
    };
    return;
  }

  // b) Build full reference context — 6000 chars per ref, all eligible refs
  const refText = refs
    .map(r => `=== SOURCE: ${r.name} (${r.subject}) ===\n${(r.text||'').slice(0,6000)}`)
    .join('\n\n---\n\n');

  // c) Extraction-only prompt — no invented content allowed
  const prompt = `Below are the ONLY source materials you are allowed to use. Read them carefully, then extract and organize content for the topic: ${topicName}${subtopics.length?` (subtopics: ${subtopics.join(', ')})`:''}. Subject: ${subjKey} law.

SOURCE MATERIALS:
${refText}

From these materials only:
- Extract key definitions, rules, and principles that appear in the text
- Identify any cases, articles, or statutes explicitly mentioned
- Build lesson pages using ONLY what you found in the source above
- Write MCQ questions that test concepts explicitly stated in the text
- Write essay questions based on scenarios described in the text
- For every MCQ explanation, quote or cite which passage in the source supports the answer
- If a subtopic has no coverage in the materials, write exactly: [Not covered in uploaded materials]

Respond ONLY with valid JSON (no markdown):
{
  "lesson": {
    "pages": [
      { "title": "Page 1: [title from source content]", "content": "HTML using only source material. Use <p>,<strong>,<em>,<ul>,<li>. Use <div class='definition-box'>definition exactly as in source</div> <div class='case-box'><strong>Case/provision from source:</strong> ruling from source</div> <div class='codal-box'>Article/rule exactly as in source</div>", "sourceNote": "Derived from: [reference name], [section or passage used]" },
      { "title": "Page 2: [title from source content]", "content": "...", "sourceNote": "..." }
    ]
  },
  "mcq": {
    "questions": [
      { "q": "Question testing a concept explicitly stated in the source", "options": ["A.","B.","C.","D."], "answer": 0, "explanation": "Explanation citing which passage in source supports this answer", "source": "Reference: [name], [relevant passage]" },
      { "q": "...", "options": ["A.","B.","C.","D."], "answer": 1, "explanation": "...", "source": "..." },
      { "q": "...", "options": ["A.","B.","C.","D."], "answer": 2, "explanation": "...", "source": "..." },
      { "q": "...", "options": ["A.","B.","C.","D."], "answer": 0, "explanation": "...", "source": "..." },
      { "q": "...", "options": ["A.","B.","C.","D."], "answer": 3, "explanation": "...", "source": "..." }
    ]
  },
  "essay": {
    "questions": [
      { "type": "situational", "prompt": "The actual question (e.g. 'What are the rights of A? Is B liable? Decide with reasons.')", "context": "COMPLETE fact pattern from source — all parties, events, and circumstances. Nothing omitted.", "q": "Same as prompt", "modelAnswer": "Answer using ONLY information from source materials", "keyPoints": ["Point from source","Point from source"], "source": "Based on: [reference name], [relevant passage]" },
      { "type": "conceptual", "prompt": "Define or distinguish or enumerate (no fact pattern needed)", "context": "", "q": "Same as prompt", "modelAnswer": "...", "keyPoints": ["...","..."], "source": "..." },
      { "type": "situational", "prompt": "...", "context": "...", "q": "...", "modelAnswer": "...", "keyPoints": ["...","..."], "source": "..." }
    ]
  }
}

IMPORTANT for essay classification:
- SITUATIONAL: question involves specific named parties (Mr. A, ABC Corp), a sequence of events, a legal dispute or transaction. Put the COMPLETE fact pattern in "context" — nothing summarized or omitted. Put the actual question in "prompt" AND "q".
- CONCEPTUAL: question asks to define, distinguish, enumerate, or explain a doctrine — no specific parties or events. Leave "context" empty. Put the full question in "prompt" AND "q".
- Output ONLY the JSON object. Start with { and end with }. No markdown, no preamble.`;

  const parsed = await callClaudeJSON([{ role:'user', content:prompt }], 4096);
  if (!CONTENT[subjKey]) CONTENT[subjKey] = {};
  if (!parsed) {
    console.error(`[generateTopicContent] JSON parse failed for: ${topicName}`);
    CONTENT[subjKey][topicName] = { status:'generation_failed', message:'Content generation failed. Click to retry.', generatedAt:new Date().toISOString() };
    return;
  }
  CONTENT[subjKey][topicName] = { lesson:parsed.lesson, mcq:parsed.mcq, essay:parsed.essay, generatedAt:new Date().toISOString() };
}

// ── ON-DEMAND CONTENT GENERATION (lesson/quiz for uncached topics) ──
app.post('/api/generate-content', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });
  const { messages, max_tokens = 4096 } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
  try {
    const text = await callClaude(messages, max_tokens);
    res.json({ content: text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI QUESTION GENERATION (helper for mock bar) ────────────
async function generateAIQuestions(needed, subjects, syllabus, references) {
  const subjectList = (!subjects || subjects.includes('all')) ? null : subjects;
  const refCtx = (references || [])
    .filter(r => !subjectList || subjectList.includes(r.subject) || r.subject === 'general')
    .slice(0, 3)
    .map(r => `[${r.name}]\n${r.summary || (r.text||'').slice(0, 800)}`)
    .join('\n\n');

  const syllCtx = syllabus
    ? syllabus.topics.map(s => `${s.name}: ${s.topics?.map(t=>t.name).join(', ')}`).join('\n')
    : '';

  const prompt = `Generate exactly ${needed} Philippine Bar Exam essay questions. You must return exactly ${needed} questions, no more, no less.

${refCtx ? `Base questions on these uploaded materials:\n${refCtx}` : ''}
${syllCtx ? `Syllabus coverage:\n${syllCtx}` : ''}

Each question must be a complete bar exam question with full fact pattern if situational.

Output ONLY a valid JSON array. Start with [ and end with ]. No markdown, no preamble, no text after:
[
  {
    "subject": "civil|criminal|political|labor|commercial|taxation|remedial|ethics",
    "q": "Complete question text",
    "context": "Full fact pattern if situational, empty string if conceptual",
    "modelAnswer": "Complete ALAC format answer",
    "keyPoints": ["key point 1", "key point 2"],
    "type": "situational|conceptual",
    "isReal": false,
    "source": "AI Generated"
  }
]`;

  const parsed = await callClaudeJSON([{ role:'user', content:prompt }], 4000);

  if (!parsed || !Array.isArray(parsed)) {
    console.warn('[mockbar/ai] generateAIQuestions: no valid JSON array returned');
    return [];
  }
  if (parsed.length < needed) {
    console.warn(`[mockbar/ai] AI returned ${parsed.length} but needed ${needed}`);
  }
  return parsed.slice(0, needed);
}

// ── MOCK BAR CORE LOGIC ──────────────────────────────────────
async function generateMockBar(subjects, count, options = {}) {
  const {
    sources      = { pastBar: true, preGen: false, aiGenerate: false },
    pastBarIds   = [],       // specific past bar file IDs to include; empty = all matching subjects
    includePreGen = false,   // explicit boolean override; false = never use pregen
    topics       = [],       // filter preGen pool to these topic names (when non-empty)
    difficulty   = 'balanced',
  } = options;

  const usePastBar  = sources.pastBar !== false;
  const usePreGen   = includePreGen === true && sources.preGen === true;
  const useAI       = sources.aiGenerate === true;

  let warning = null;

  // STEP 1: Build real past bar pool
  let realPool = [];
  if (usePastBar) {
    KB.pastBar.forEach(pb => {
      const subjMatch = !subjects || subjects.includes('all') || subjects.includes(pb.subject);
      const idMatch   = !pastBarIds?.length || pastBarIds.includes(pb.id);
      if (subjMatch && idMatch) {
        (pb.questions || []).forEach(q => {
          realPool.push({
            q: q.q,
            context: q.context || '',
            modelAnswer: q.modelAnswer || '',
            keyPoints: q.keyPoints || [],
            subject: pb.subject,
            source: pb.name,
            year: pb.year,
            isReal: true,
            type: q.type || 'situational',
            pastBarId: pb.id,
            pastBarName: pb.name,
          });
        });
      }
    });
    realPool = shuffle(realPool);
  }
  console.log(`[mockbar] realPool size: ${realPool.length}`);

  // STEP 2: Build pre-gen pool
  let preGenPool = [];
  if (usePreGen) {
    const targetSubjs = (!subjects || subjects.includes('all')) ? Object.keys(CONTENT) : subjects;
    targetSubjs.forEach(subj => {
      Object.entries(CONTENT[subj] || {}).forEach(([topicName, data]) => {
        // Filter by topic names if provided
        if (topics.length > 0 && !topics.includes(topicName)) return;
        (data.essay?.questions || []).forEach(q => {
          preGenPool.push({
            q: q.prompt || q.q,
            context: q.context || '',
            modelAnswer: q.modelAnswer || '',
            keyPoints: q.keyPoints || [],
            subject: subj,
            source: 'Pre-generated',
            isReal: false,
            type: q.type || 'situational',
          });
        });
      });
    });
    preGenPool = shuffle(preGenPool);
  }
  console.log(`[mockbar] preGenPool size: ${preGenPool.length}`);

  // Apply difficulty preference
  if (difficulty === 'situational') {
    const sit = preGenPool.filter(q => q.type === 'situational');
    const rest = preGenPool.filter(q => q.type !== 'situational');
    preGenPool = [...sit, ...rest];
  } else if (difficulty === 'conceptual') {
    const con = preGenPool.filter(q => q.type !== 'situational');
    const rest = preGenPool.filter(q => q.type === 'situational');
    preGenPool = [...con, ...rest];
  }

  // STEP 3: Fill chosen — real first, then pre-gen
  const chosen = [];

  for (const q of realPool) {
    if (chosen.length >= count) break;
    chosen.push(q);
  }
  console.log(`[mockbar] after real: ${chosen.length}`);

  for (const q of preGenPool) {
    if (chosen.length >= count) break;
    chosen.push(q);
  }
  console.log(`[mockbar] after pregen: ${chosen.length}`);

  // STEP 4: Fill remaining gap with AI (or clamp if AI disabled)
  const gap = count - chosen.length;
  console.log(`[mockbar] gap to fill with AI: ${gap}`);

  if (gap > 0) {
    if (!useAI) {
      // Clamp to available pool size
      const available = chosen.length;
      warning = `⚠️ Only ${available} question${available===1?'':'s'} available in pool. Starting with ${available} question${available===1?'':'s'}.`;
      count = available;
      console.warn(`[mockbar] AI disabled, clamping to ${available}`);
    } else {
      try {
        const aiQuestions = await generateAIQuestions(gap, subjects, KB.syllabus, KB.references);
        console.log(`[mockbar] AI generated: ${aiQuestions.length}`);
        chosen.push(...aiQuestions);
      } catch(e) {
        console.error('[mockbar] AI generation failed:', e.message);
      }
    }
  }

  // STEP 5: Hard slice to exactly count
  const final = chosen.slice(0, count);
  console.log(`[mockbar] FINAL COUNT: ${final.length} / requested: ${count}`);

  if (final.length !== count && sources.aiGenerate !== false) {
    console.warn(`[mockbar] WARNING: Could not reach requested count. Had ${realPool.length} real + ${preGenPool.length} pregen, needed ${count}`);
  }

  final.forEach((q, i) => q.number = i + 1);

  return {
    questions: final,
    total: final.length,
    requested: count,
    warning,
    fromPastBar: final.filter(q => q.isReal).length,
    fromPreGen: final.filter(q => !q.isReal && q.source === 'Pre-generated').length,
    aiGenerated: final.filter(q => !q.isReal && q.source !== 'Pre-generated').length,
  };
}

// ── MOCK BAR GENERATOR ──────────────────────────────────────
app.post('/api/mockbar/generate', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error:'API key not set' });
  const { subjects, count=20, sources, pastBarIds, includePreGen, aiGenerate, topics, difficulty } = req.body;
  console.log(`[mockbar] requested: ${count} questions, subjects: ${JSON.stringify(subjects)}`);
  // Merge explicit top-level aiGenerate flag into sources object (new UI sends it at top level)
  const mergedSources = aiGenerate !== undefined ? { ...sources, aiGenerate } : sources;
  try {
    const result = await generateMockBar(subjects, count, { sources: mergedSources, pastBarIds, includePreGen: includePreGen ?? null, topics, difficulty });
    res.json(result);
  } catch(err) {
    console.error('[mockbar] error:', err.message);
    res.status(500).json({ error:err.message });
  }
});

// ── Question format detection ────────────────────────────────
// Improved question type detector — returns:
//   'situational' → has fact pattern → ALAC scoring
//   'definition'  → "define X", "distinguish X from Y" → Accuracy/Completeness/Clarity
//   'conceptual'  → "explain X", "what is the purpose of X" → same A/C/C scoring
//   'enumeration' → "enumerate", "what are the requisites" → proportional item scoring
//   'truefalse'   → T/F statement → correct/incorrect + explanation
//   'mcq'         → multiple choice → correct choice + reasoning
function detectQuestionType(questionText, context, modelAnswer) {
  const q   = (questionText  || '').toLowerCase().trim();
  const ctx = (context       || '').toLowerCase().trim();
  const ans = (modelAnswer   || '').toLowerCase();

  // ── Explicit format signals (highest priority) ──
  if (/true or false|true\/false|\bt\/f\b|state whether/i.test(q)) return 'truefalse';
  if (/which of the following|choose the correct|select the best|\ba\.\s|\bb\.\s|\bc\.\s|\ba\)\s|\bb\)\s|\bc\)\s/.test(q) || (q.includes('(a)') && q.includes('(b)'))) return 'mcq';

  // ── Enumeration signals ──
  if (/enumerate|(list|state|name|give) (the |at least |all )?(requisites|elements|requirements|grounds|instances|cases|kinds|classifications|stages|characteristics|effects|exceptions|limitations)|what are the (requisites|elements|requirements|grounds|instances|cases|kinds|classifications|stages|characteristics|effects|exceptions|limitations)/.test(q)) return 'enumeration';

  // ── Situational — context (fact pattern) is the strongest signal ──
  const hasFacts = ctx.length > 80;
  const hasCaseParties = /filed|sued|plaintiff|defendant|petitioner|respondent|labor arbiter|nlrc|\brtc\b|\bca\b|supreme court/i.test(ctx);
  if (hasFacts || hasCaseParties) return 'situational';

  // ── Definition signals ──
  if (/^define\b|^what is (a |an |the |meant by |understood by )|^what do you (mean|understand) by|^distinguish (between|and)|^differentiate (between)?|^what do you understand by/i.test(q)) return 'definition';

  // ── Conceptual / Explanatory signals ──
  if (/^explain (the |a |an )?(concept|doctrine|principle|rule|theory|basis|rationale|purpose|significance|nature|scope)|^describe (the |a |an )?|^what is the (purpose|effect|nature|significance|rationale|basis|scope) of|^when (is|are|does|can|may) (a|an|the) /i.test(q)) return 'conceptual';

  // Broad "what is / what are" without fact-pattern markers → treat as definition
  if (/^(what is|what are)\b/.test(q) && !/(liable|remedy|obligation of|consequence|entitled|right of)/.test(q)) return 'definition';

  // ── Model answer signals (fallback) ──
  const ansWords = ans.split(/\s+/).filter(w => w.length > 0).length;
  const hasALAC  = /(answer:|legal basis:|application:|conclusion:)/i.test(ans);
  if (hasALAC && ansWords > 100) return 'situational';
  if (ansWords > 0 && ansWords < 60) return 'definition';

  return 'situational'; // default for long-form essay questions
}
const GRADE_SCALE = `Assign grade based on numericScore (passing score is 7.0/10):
  Excellent:          8.5 and above
  Good:               7.0 to 8.4  ← passing starts here
  Satisfactory:       5.5 to 6.9
  Needs Improvement:  4.0 to 5.4
  Poor:               below 4.0`;

// ── ESSAY EVALUATION (smart multi-format) ───────────────────
app.post('/api/evaluate', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error:'API key not set' });
  const { question, answer, modelAnswer, keyPoints, subject, context, forceType } = req.body;
  const refCtx = KB.references.filter(r=>r.subject===subject).slice(0,1).map(r=>r.summary||'').join('');
  const qtype  = forceType || detectQuestionType(question, context, modelAnswer);
  // Map new type names to existing handler keys
  const format = qtype === 'situational' ? 'essay'
               : qtype === 'conceptual'  ? 'definition'
               : qtype;
  console.log(`[evaluate] type=${qtype} q="${(question||'').slice(0,60)}"`);
  let prompt, maxTok;

  if (format === 'truefalse') {
    maxTok = 600;
    prompt = `You are a Philippine Bar Exam examiner. Evaluate this True or False answer.

Question: ${question}
${modelAnswer?`Correct Answer / Explanation: ${modelAnswer}`:''}
Student Answer: ${answer}

Score out of 10:
  10/10 — Correct answer WITH a correct explanation of why it is true or false
  7/10  — Correct answer with a partial or vague explanation
  5/10  — Correct answer (True/False) but no explanation given
  0/10  — Wrong answer regardless of explanation

${GRADE_SCALE}

Respond ONLY with valid JSON (no markdown):
{
  "score": "X/10", "numericScore": 0, "grade": "Excellent|Good|Satisfactory|Needs Improvement|Poor",
  "isCorrect": true,
  "overallFeedback": "Brief assessment of the student's answer",
  "correctAnswer": "What the correct answer is and why — full explanation",
  "modelAnswer": "The complete correct answer with full legal basis",
  "format": "truefalse"
}`;

  } else if (format === 'mcq') {
    maxTok = 700;
    prompt = `You are a Philippine Bar Exam examiner. Evaluate this Multiple Choice answer.

Question: ${question}
${modelAnswer?`Correct Answer: ${modelAnswer}`:''}
Student Answer: ${answer}

Score out of 10:
  10/10 — Correct choice WITH correct legal reasoning
  7/10  — Correct choice but weak or incomplete reasoning
  5/10  — Wrong choice but reasoning shows partial understanding of the applicable law
  0/10  — Wrong choice with no reasoning or completely wrong reasoning

${GRADE_SCALE}

Respond ONLY with valid JSON (no markdown):
{
  "score": "X/10", "numericScore": 0, "grade": "Excellent|Good|Satisfactory|Needs Improvement|Poor",
  "isCorrect": true,
  "overallFeedback": "Brief assessment",
  "whyCorrect": "Full explanation of why the correct answer is right, with legal basis",
  "whyOthersWrong": "Brief note on why the other options are incorrect",
  "modelAnswer": "The complete correct answer with legal reasoning",
  "format": "mcq"
}`;

  } else if (format === 'enumeration') {
    maxTok = 800;
    const kpList = (keyPoints||[]).length ? keyPoints.join('\n') : (modelAnswer||'');
    prompt = `You are a Philippine Bar Exam examiner. Evaluate this Enumeration answer.

Question: ${question}
${kpList?`Expected Points / Key Items:\n${kpList}`:''}
Student Answer: ${answer}

Count how many required points the student correctly stated.
Award points proportionally — divide 10 by the number of required items to get points per item.
Award full item credit if the student stated the substance correctly even if wording differs.
Award half item credit if partially correct.

${GRADE_SCALE}

Respond ONLY with valid JSON (no markdown):
{
  "score": "X/10", "numericScore": 0, "grade": "Excellent|Good|Satisfactory|Needs Improvement|Poor",
  "itemsRequired": 5,
  "itemsCorrect": 3,
  "itemsMissed": ["missed item 1", "missed item 2"],
  "itemsWrong": ["incorrect item stated by student if any"],
  "overallFeedback": "Brief assessment",
  "modelAnswer": "Complete enumeration with all required items",
  "format": "enumeration"
}`;

  } else if (format === 'definition') {
    maxTok = 800;
    prompt = `You are a Philippine Bar Exam examiner. Evaluate this Definition or Distinction answer.

Question: ${question}
${modelAnswer?`Model Answer: ${modelAnswer}`:''}
${(keyPoints||[]).length?`Key Points: ${keyPoints.join(', ')}`:''}
Student Answer: ${answer}

Score out of 10 using these components:
  Accuracy     (4 pts): Is the definition or distinction legally correct?
  Completeness (3 pts): Are all essential elements or points of difference included?
  Clarity      (3 pts): Is it stated clearly and precisely in legal language?

For distinguish/differentiate questions, evaluate whether the student correctly identified the key points of difference between the two concepts.

${GRADE_SCALE}

Respond ONLY with valid JSON (no markdown):
{
  "score": "X/10", "numericScore": 0, "grade": "Excellent|Good|Satisfactory|Needs Improvement|Poor",
  "breakdown": {
    "accuracy":     { "score": 0.0, "max": 4, "feedback": "..." },
    "completeness": { "score": 0.0, "max": 3, "feedback": "..." },
    "clarity":      { "score": 0.0, "max": 3, "feedback": "..." }
  },
  "overallFeedback": "Brief assessment",
  "keyMissed": ["key element or distinction the student missed"],
  "modelAnswer": "Complete model definition or distinction",
  "format": "definition"
}`;

  } else {
    // essay / situational — full ALAC
    maxTok = 2000;
    prompt = `You are a Philippine Bar Exam examiner. Evaluate this student answer using the ALAC method (Answer, Legal Basis, Application, Conclusion) which is the standard format required in the Philippine Bar Exam.

Question: ${question}
${modelAnswer?`Reference Answer: ${modelAnswer}`:''}
${(keyPoints||[]).length?`Key Points to Check: ${keyPoints.join(', ')}`:''}
${refCtx?`\nLegal Reference Context:\n${refCtx}`:''}

Student Answer: ${answer}

Score each ALAC component using these weights which reflect actual Philippine Bar Exam priorities (total = 10 points):

A — Answer (1.5 pts): Direct answer to the question upfront. Worth less because a correct answer without legal basis is incomplete.

L — Legal Basis (3.0 pts): The purpose of this component is to check whether the student knows WHAT law or doctrine governs the issue — not to test their ability to memorize article numbers or G.R. citation numbers.

Award points using this scale:

  3.0/3.0 — FULL CREDIT. Award full 3 points if ANY of these is true:
  • Student correctly named a recognized legal doctrine or principle that actually exists in Philippine law and is applicable to the question (e.g. 'the four-fold test', 'doctrine of strained relations', 'the economic reality test', 'principle of non-diminution of benefits', 'the totality of conduct doctrine', 'the business judgment rule', 'doctrine of piercing the corporate veil', etc.)
  • Student correctly stated the substance of the governing rule even without naming it — meaning they described what the law says accurately and it is clearly applicable to the facts
  • Student cited a specific article, statute, or G.R. number correctly (this is a bonus demonstration of knowledge but is NOT required for full credit)

  2.0/3.0 — GOOD CREDIT. Award 2 points if:
  • Student identified the correct general area of law and stated a rule or principle that is mostly correct but incomplete or slightly imprecise in its statement
  • Student named the right doctrine but applied it to the wrong element or framed it slightly incorrectly
  • Student said something like 'under the Labor Code' or 'under the Civil Code' and then stated a rule that is substantially correct even without naming the doctrine

  1.0/3.0 — PARTIAL CREDIT. Award 1 point if:
  • Student mentioned the general subject area of law (e.g. 'labor law', 'civil law') but did not state any specific rule, doctrine, or legal principle
  • Student attempted a legal basis but the rule they stated is only tangentially related to the issue

  0/3.0 — NO CREDIT. Award 0 only if:
  • Student provided NO legal basis whatsoever
  • Student cited a doctrine or law that is completely wrong and inapplicable to the facts
  • Student invented a non-existent doctrine or rule

CRITICAL INSTRUCTION: Do NOT deduct points for failure to cite article numbers, G.R. numbers, or specific codal provisions. A student who correctly states 'under the four-fold test, the elements are...' has demonstrated legal knowledge and deserves full Legal Basis credit. Specific citations are impressive but optional — the substance of the legal rule matters, not the memorization of numbers.

A — Application (4.0 pts): HIGHEST WEIGHT. How well the student applies the law to the specific facts. Only award full points if the student explicitly connects the legal rule to the specific parties and facts in the question. Partial credit for general application. Zero for restating the law without applying it to the facts. This demonstrates actual legal reasoning ability which is the primary skill tested in the bar exam.

C — Conclusion (1.5 pts): Clear restatement of the answer with finality. Shows the student can synthesize their analysis.

${GRADE_SCALE}

Respond ONLY with valid JSON (no markdown):
{
  "score": "X/10", "numericScore": 7, "grade": "Excellent|Good|Satisfactory|Needs Improvement|Poor",
  "alac": {
    "answer":      { "score": 1.2, "max": 1.5, "feedback": "...", "studentDid": "..." },
    "legalBasis":  { "score": 2.5, "max": 3.0, "feedback": "...", "studentDid": "..." },
    "application": { "score": 2.8, "max": 4.0, "feedback": "...", "studentDid": "..." },
    "conclusion":  { "score": 1.2, "max": 1.5, "feedback": "...", "studentDid": "..." }
  },
  "overallFeedback": "2-3 sentence overall assessment",
  "strengths": ["..."],
  "improvements": ["..."],
  "keyMissed": ["specific law or case they should have cited"],
  "modelAnswer": "ANSWER: [direct answer]\nLEGAL BASIS: [specific article/case]\nAPPLICATION: [how law applies to these facts]\nCONCLUSION: [restatement of answer]",
  "format": "essay"
}`;
  }

  try {
    const result = await callClaudeJSON([{ role:'user', content: prompt }], maxTok);
    if (!result) {
      return res.status(422).json({ error:'Evaluation failed — could not parse scoring response. Please try submitting your answer again.' });
    }
    result.format       = qtype;  // always use detected type (overrides AI-reported format)
    result.questionType = qtype;
    res.json(result);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── EMAIL RESULTS ────────────────────────────────────────────
app.post('/api/email-results', async (req, res) => {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return res.json({ error: 'Email not configured. Add EMAIL_USER and EMAIL_PASS to Railway environment variables.' });
  }
  const { to, subject, htmlBody } = req.body;
  if (!to || !htmlBody) return res.status(400).json({ error: 'to and htmlBody required' });
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || `BarBuddy Results <${process.env.EMAIL_USER}>`,
      to,
      subject: subject || 'BarBuddy Mock Bar Results',
      html: `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>${htmlBody}</body></html>`,
    });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN: Manual past bar question entry (no AI) ────────────
app.post('/api/admin/pastbar/manual', adminOnly, (req, res) => {
  const { name, subject, year, questions } = req.body;
  if (!name || !Array.isArray(questions) || !questions.length)
    return res.status(400).json({ error: 'name and questions[] required' });
  const id = `pb_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const entry = {
    id, name,
    subject: subject || 'general',
    year: year || 'Unknown',
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
  saveKB();
  res.json({ success: true, id, name, questionsAdded: questions.length });
});

// ── HELPERS ─────────────────────────────────────────────────
const CHUNK_SIZE  = 10000;  // chars per chunk sent to Claude
const MAX_CHUNKS  = 12;     // max chunks → up to ~120k chars processed

// ── Subject key resolver (standalone — used by parser + route fallback) ─
function detectSubjectKeyFromName(name) {
  const lower = name.toLowerCase();
  const map = {
    'civil': 'civil', 'criminal': 'criminal', 'political': 'political',
    'labor': 'labor', 'social': 'labor', 'commercial': 'commercial',
    'taxation': 'taxation', 'tax': 'taxation', 'remedial': 'remedial',
    'ethics': 'ethics', 'custom': 'custom',
  };
  for (const [frag, key] of Object.entries(map)) {
    if (lower.includes(frag)) return key;
  }
  return null;
}

// ── Hierarchical regex syllabus parser (stack-based, no AI) ─────────────
// Classification rules:
//   Roman numeral lines  → type:'section'  (non-clickable header, always)
//   Letter/Number WITH children → type:'group'  (non-clickable, post-processed)
//   Letter/Number WITHOUT children → type:'topic' (clickable)
//   Lowercase letter lines → type:'topic'  (always leaf/clickable)
//   Bullet lines → type:'topic'  (always leaf/clickable)
function parseSyllabusText(text) {
  const SUBJECT_MAP = {
    civil:'Civil Law', criminal:'Criminal Law', political:'Political Law',
    labor:'Labor Law and Social Legislation', commercial:'Commercial Law',
    taxation:'Taxation', remedial:'Remedial Law',
    ethics:'Legal and Judicial Ethics', custom:'Custom Subject',
  };
  const NAME_TO_KEY = {
    'civil':'civil', 'criminal':'criminal', 'political':'political',
    'labor':'labor', 'social leg':'labor', 'commercial':'commercial',
    'taxation':'taxation', 'tax law':'taxation', 'remedial':'remedial',
    'legal ethics':'ethics', 'judicial eth':'ethics', 'ethics':'ethics', 'custom':'custom',
  };
  function detectSubjectKey(name) {
    const lower = name.toLowerCase();
    for (const [frag, key] of Object.entries(NAME_TO_KEY)) {
      if (lower.includes(frag)) return key;
    }
    return null;
  }

  const ROMAN  = /^(I{1,3}V?|VI{0,3}|IX|XI{0,3}|[IVX]{1,5})\.\s+(.+)$/;
  const LETTER = /^([A-Z])\.\s+(.+)$/;
  const NUMBER = /^(\d+)\.\s+(.+)$/;
  const LOWER  = /^([a-z])\.\s+(.+)$/;
  const BULLET = /^[-•*\u2022]\s+(.+)$/;

  function parseSubjectBlock(rawLines, subjKey) {
    const roots = [];
    const stack = []; // { node, level }

    for (const rawLine of rawLines) {
      const line = rawLine.trim();
      if (!line) continue;

      let name = null, level = -1, forceTopic = false;

      const rm = line.match(ROMAN);
      const lm = !rm && line.match(LETTER);
      const nm = !rm && !lm && line.match(NUMBER);
      const lo = !rm && !lm && !nm && line.match(LOWER);
      const bl = !rm && !lm && !nm && !lo && line.match(BULLET);

      if      (rm) { name = rm[2].trim();  level = 0; }
      else if (lm) { name = lm[2].trim();  level = 1; }
      else if (nm) { name = nm[2].trim();  level = 2; }
      else if (lo) { name = lo[2].trim();  level = 3; forceTopic = true; }
      else if (bl) { name = bl[1].trim();  level = 4; forceTopic = true; }
      else {
        const indent = rawLine.search(/\S/);
        if (indent >= 4 && line.length > 2 && line.length < 250) {
          name = line; level = 5; forceTopic = true;
        }
      }

      if (!name || name.length < 2 || name.length > 250) continue;

      const node = {
        name,
        type: level === 0 ? 'section' : 'topic',
        isHeader: level === 0,
        subject: subjKey,
        children: [],
        _force: forceTopic,
      };

      // Pop stack until we find a shallower parent
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      if (stack.length === 0) roots.push(node);
      else stack[stack.length - 1].node.children.push(node);
      stack.push({ node, level });
    }

    // Post-process: topic with children → group (unless forced leaf)
    function postProcess(nodes) {
      for (const node of nodes) {
        postProcess(node.children);
        if (node.type === 'topic' && !node._force && node.children.length > 0) {
          node.type = 'group';
        }
        delete node._force;
      }
    }
    postProcess(roots);
    return roots;
  }

  // Split text into subject blocks by divider lines
  const rawLines = text.split('\n');
  const subjectBlocks = [];
  let blockKey = null, blockName = null, blockLines = [];

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) {
      if (blockKey) blockLines.push(rawLine);
      continue;
    }

    // Check for subject divider: -----Name-----  or  === Name ===
    const divMatch = line.match(/^[-=*]+\s*(.+?)\s*[-=*]+$/);
    let subjKey = null, subjName = null;
    if (divMatch) {
      subjKey = detectSubjectKey(divMatch[1]);
      subjName = divMatch[1].trim();
    } else if (line.length < 60 && !ROMAN.test(line) && !LETTER.test(line) && !NUMBER.test(line)) {
      subjKey = detectSubjectKey(line);
      subjName = line;
    }

    if (subjKey) {
      if (blockKey) subjectBlocks.push({ key: blockKey, name: blockName, lines: blockLines });
      blockKey  = subjKey;
      blockName = SUBJECT_MAP[subjKey] || subjName;
      blockLines = [];
      continue;
    }

    if (blockKey) blockLines.push(rawLine);
  }
  if (blockKey) subjectBlocks.push({ key: blockKey, name: blockName, lines: blockLines });

  // Fallback: no dividers found — try auto-detect from first lines
  if (subjectBlocks.length === 0) {
    let autoKey = null, autoName = null;
    for (const rawLine of rawLines.slice(0, 15)) {
      const line = rawLine.trim();
      const k = line ? detectSubjectKey(line) : null;
      if (k) { autoKey = k; autoName = SUBJECT_MAP[k] || line; break; }
    }
    subjectBlocks.push({ key: autoKey || 'civil', name: autoName || 'Unknown', lines: rawLines });
  }

  const subjects = subjectBlocks.map(b => ({
    key: b.key,
    name: b.name,
    topics: parseSubjectBlock(b.lines, b.key),
  }));

  return { subjects };
}

// ── Job queue: sequential background tasks with 3s gap ───────
function enqueueJob(fn) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
  JOB_MAP.set(jobId, { status:'pending', result:null, error:null, createdAt:Date.now() });
  JOB_QUEUE.push({ jobId, fn });
  processQueue();
  return jobId;
}

async function processQueue() {
  if (JOB_RUNNING || !JOB_QUEUE.length) return;
  JOB_RUNNING = true;
  while (JOB_QUEUE.length) {
    const { jobId, fn } = JOB_QUEUE.shift();
    const job = JOB_MAP.get(jobId);
    if (!job) continue;
    job.status = 'processing';
    console.log(`Job ${jobId}: processing (queue remaining: ${JOB_QUEUE.length})`);
    try   { job.result = await fn(); job.status = 'done'; }
    catch (e) { job.error = e.message; job.status = 'failed'; console.error(`Job ${jobId} failed:`, e.message); }
    setTimeout(() => JOB_MAP.delete(jobId), 30 * 60 * 1000);  // expire after 30 min
    if (JOB_QUEUE.length) await sleep(3000);
  }
  JOB_RUNNING = false;
}

// Summarize a document of any size via sequential chunk summarisation
async function summarizeLargeDoc(content, docName, subject) {
  const chunks = [];
  for (let i = 0; i < content.length && chunks.length < MAX_CHUNKS; i += CHUNK_SIZE)
    chunks.push(content.slice(i, i + CHUNK_SIZE));

  if (chunks.length === 1) {
    return callClaude([{ role:'user', content:`Summarize the key legal concepts, doctrines, article numbers, G.R. case numbers, and topics in this Philippine law reference. Used as AI context for bar exam content generation.\n\nMaterial: ${docName} (${subject})\nContent:\n${chunks[0]}\n\nDense structured summary (max 600 words).` }], 900);
  }

  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    const s = await callClaude([{ role:'user', content:`Summarize the key legal concepts, doctrines, article numbers, G.R. case numbers, and topics in this section of a Philippine law reference.\n\nMaterial: ${docName} (${subject}) — Part ${i+1} of ${chunks.length}\nContent:\n${chunks[i]}\n\nDense summary (max 250 words).` }], 400)
      .catch(() => '');
    if (s) parts.push(s);
    if (i < chunks.length - 1) await sleep(400);
  }

  if (parts.length <= 2) return parts.join('\n\n');

  return callClaude([{ role:'user', content:`Combine these partial summaries of a Philippine law reference into one comprehensive master summary.\n\nMaterial: ${docName} (${subject})\n\n${parts.map((s,i)=>`[Part ${i+1}]\n${s}`).join('\n\n')}\n\nMaster summary (max 1000 words, dense, structured):` }], 1500);
}

// Background two-pass extraction for past bar content
async function extractPastBarInBackground(id, content, name, subject, year) {
  const entry = KB.pastBar.find(p => p.id === id);
  if (!entry) return;
  const Q_CHUNK = 12000;
  const chunks = [];
  for (let i = 0; i < content.length && chunks.length < MAX_CHUNKS; i += Q_CHUNK)
    chunks.push(content.slice(i, i + Q_CHUNK));
  console.log(`pastbar bg [${name}]: ${content.length} chars, ${chunks.length} chunk(s)`);
  try {
    // Pass 1 — Map the document: identify question locations and any paired answers
    const analyses = [];
    for (let i = 0; i < chunks.length; i++) {
      const partLabel = chunks.length > 1 ? ` | Part ${i+1} of ${chunks.length}` : '';
      const a = await callClaude([{ role:'user', content:
        `This is an uploaded Philippine Bar Exam document. READ ONLY — do not add anything.\nDescribe what format the questions are in (numbered, roman numerals, Q&A pairs, essay style, etc). Then identify and list every question you can find — a question is any text that:\n- Asks the reader to analyze a legal situation\n- Presents a fact pattern requiring a legal conclusion\n- Follows patterns like 'Is X liable?', 'What are the rights of...', 'Decide with reasons', 'Rule on the motion', 'May X...', 'Can Y...'\nAlso note any suggested answers or model answers that appear in the document paired with questions.\n\nMaterial: ${name} (${year||'?'}) | Subject: ${subject}${partLabel}\nContent:\n${chunks[i]}`
      }], 2000);
      analyses.push(a);
      if (i < chunks.length - 1) await sleep(400);
    }
    // Pass 2 — Copy questions and answers EXACTLY from the document
    const allQ = [];
    for (let i = 0; i < chunks.length; i++) {
      const partLabel = chunks.length > 1 ? ` | Part ${i+1} of ${chunks.length}` : '';
      const extractPrompt = `Based on your analysis:\n${analyses[i]}\n\nNow READ AND EXTRACT — do not create or invent anything:\n\nFor each question identified:\n1. Copy the question text EXACTLY as written in the document\n2. Look for any answer or suggested answer that immediately follows the question in the document\n3. If an answer exists in the document, copy it EXACTLY as written\n4. If no answer exists in the document, use exactly this text: "[No suggested answer in uploaded material]"\n\nNEVER write a model answer from your own knowledge. Only copy what is already written in this document.\n\nMaterial: ${name} (${year||'?'}) | Subject: ${subject}${partLabel}\nContent:\n${chunks[i]}\n\nRespond ONLY with valid JSON (no markdown fence):\n{ "questions": [{ "q": "Exact question text as written in document", "modelAnswer": "Exact answer from document, or [No suggested answer in uploaded material]", "keyPoints": [], "topics": ["${subject}"] }] }`;
      let chunkQ = [];
      const chunkResult = await callClaudeJSON([{ role:'user', content: extractPrompt }], 4000);
      if (chunkResult) {
        chunkQ = chunkResult.questions || [];
      } else {
        console.warn(`pastbar bg chunk ${i+1}: JSON parse failed — trying text-only retry`);
        const retryResult = await callClaudeJSON([{ role:'user', content:`This is an uploaded bar exam document. READ AND EXTRACT ONLY — do not create.\n\nFind all questions in this text. Copy each question exactly as written. If an answer appears in the text immediately after the question, copy it exactly. If no answer, use: "[No suggested answer in uploaded material]"\n\nOutput ONLY this JSON (start with {, no markdown):\n{ "questions": [{ "q": "exact question text", "modelAnswer": "exact answer from document or [No suggested answer in uploaded material]", "keyPoints": [], "topics": ["${subject}"] }] }\n\nText:\n${chunks[i].slice(0,6000)}` }], 1500);
        if (retryResult) {
          chunkQ = retryResult.questions || [];
        } else {
          console.warn(`pastbar bg chunk ${i+1}: retry also failed`);
        }
      }
      console.log(`pastbar bg chunk ${i+1}/${chunks.length}: found ${chunkQ.length} question(s)`);
      allQ.push(...chunkQ);
      if (i < chunks.length - 1) await sleep(400);
    }
    // Deduplicate
    const seen = new Set();
    const dedupedQ = allQ.filter(q => {
      const key = (q.q||'').trim().toLowerCase().slice(0,100);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    console.log(`pastbar bg [${name}]: raw=${allQ.length}, deduped=${dedupedQ.length}`);
    entry.questions  = dedupedQ;
    entry.extracting = false;
    entry.extractedAt = new Date().toISOString();
    saveKB();
  } catch(err) {
    console.error(`pastbar bg [${name}] failed: ${err.message}`);
    entry.extracting  = false;
    entry.extractError = err.message;
    saveKB();
  }
}

// callClaudeJSON: like callClaude but retries until it gets valid JSON back
const JSON_FORMAT_REMINDER = '\n\nRESPONSE FORMAT — STRICTLY FOLLOW:\n1. Your ENTIRE response must be valid JSON only\n2. Start with { or [ immediately — no preamble\n3. End with } or ] — no text after\n4. No markdown code fences (no ```)\n5. No explanations before or after the JSON\n6. If unsure, return the JSON with empty arrays rather than explaining why';

async function callClaudeJSON(messages, maxTokens, retries = 3) {
  const msgs = messages.map((m, i) => {
    if (i !== messages.length - 1 || m.role !== 'user') return m;
    const alreadyHasInstruction = m.content.includes('valid JSON') || m.content.includes('ONLY JSON') || m.content.includes('ONLY with valid JSON');
    return alreadyHasInstruction ? m : { ...m, content: m.content + JSON_FORMAT_REMINDER };
  });

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const attemptMsgs = attempt === 1 ? msgs : [{
        ...msgs[msgs.length - 1],
        content: msgs[msgs.length - 1].content +
          '\n\nCRITICAL: Output ONLY the JSON object/array. Do NOT write any words or sentences. Do NOT use markdown. Start with { or [. If you cannot comply, return {}.'
      }];
      const raw = await callClaude(attempt === 1 ? msgs : [attemptMsgs[0]], maxTokens);
      const parsed = extractJSON(raw);
      if (parsed !== null) return parsed;
      console.warn(`[callClaudeJSON] attempt ${attempt}/${retries} — extractJSON failed, retrying`);
      if (attempt < retries) await sleep(2000);
    } catch(e) {
      console.error(`[callClaudeJSON] attempt ${attempt} threw:`, e.message);
      if (attempt === retries) throw e;
      await sleep(3000);
    }
  }
  console.error('[callClaudeJSON] all retries exhausted');
  return null;
}

// callClaude: Sonnet first → 20s wait → Sonnet again → Haiku → 60s wait → Haiku → throw
async function callClaude(messages, max_tokens=2000) {
  const SONNET = 'claude-sonnet-4-20250514';
  const HAIKU  = 'claude-haiku-4-5-20251001';
  // [model, milliseconds to wait BEFORE this attempt]
  const SCHEDULE = [
    { model:SONNET, waitBefore:0 },
    { model:SONNET, waitBefore:20000 },
    { model:HAIKU,  waitBefore:0 },
    { model:HAIKU,  waitBefore:60000 },
  ];
  const isOverloaded = (status, body) =>
    status === 529 || status === 429 || body?.error?.type === 'overloaded_error';

  for (let i = 0; i < SCHEDULE.length; i++) {
    const { model, waitBefore } = SCHEDULE[i];
    if (waitBefore > 0) {
      console.warn(`Claude overloaded — attempt ${i+1}/4, waiting ${waitBefore/1000}s then trying ${model}`);
      await sleep(waitBefore);
    } else if (i === 2) {
      console.warn('Claude (Sonnet) overloaded twice — switching to Haiku');
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':API_KEY, 'anthropic-version':'2023-06-01' },
      body:JSON.stringify({ model, max_tokens, messages, system: STRICT_SYSTEM_PROMPT }),
    });
    const d = await r.json();
    if (isOverloaded(r.status, d)) {
      if (i < SCHEDULE.length - 1) continue;
      throw new Error('API overloaded — please try again in a few minutes');
    }
    if (d.error) throw new Error(d.error.message);
    if (i > 0) console.log(`Claude success on attempt ${i+1} with ${model}`);
    return d.content.map(c => c.text || '').join('');
  }
}
const shuffle = arr => { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
const sleep   = ms  => new Promise(r => setTimeout(r, ms));

// ── API Status — tests Claude reachability with 10s timeout ─
app.get('/api/status', async (req, res) => {
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`BarBuddy v3 on port ${PORT}`));
