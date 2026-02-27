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

const app       = express();
const PORT      = process.env.PORT || 3000;
const API_KEY   = process.env.ANTHROPIC_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY || 'barbuddy-admin-2025';

const VALID_SUBJECTS = ['civil','criminal','political','labor','commercial','taxation','remedial','ethics','custom'];

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

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function adminOnly(req, res, next) {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
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

// ── GET KB state (public — browser caches) ─────────────────
app.get('/api/kb', (req, res) => {
  const n = Object.values(CONTENT).reduce((a,s) => a+Object.keys(s).length, 0);
  res.json({
    hasSyllabus:    !!KB.syllabus,
    syllabusName:   KB.syllabus?.name,
    syllabusTopics: KB.syllabus?.topics || [],
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

// ── ADMIN: Upload Syllabus + trigger pre-gen ────────────────
// Uses fast regex parser — no Claude needed, returns immediately
app.post('/api/admin/syllabus', adminOnly, (req, res) => {
  const { name, content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  try {
    const subjects = parseSyllabusText(content);
    if (!subjects.length) return res.status(400).json({ error: 'Could not parse any subjects. Try plain text with clear subject headings.' });
    KB.syllabus = { name:name||'Bar Exam Syllabus', rawText:content.slice(0,60000), topics:subjects, uploadedAt:new Date().toISOString() };
    saveKB();
    const totalTopics = subjects.reduce((a,s) => a+(s.topics?.length||0), 0);
    const breakdown = subjects.map(s => ({ key:s.key, name:s.name, topicCount:s.topics?.length||0 }));
    const unknownTopics = subjects.filter(s => !VALID_SUBJECTS.includes(s.key)).map(s => s.name);
    res.json({ success:true, subjects:subjects.length, totalTopics, breakdown, unknownTopics });
    triggerPreGeneration();   // fire-and-forget
  } catch(err) { res.status(500).json({ error:err.message }); }
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
  KB.syllabus = null; CONTENT = {}; saveKB(); saveContent(); res.json({ success:true });
});
app.delete('/api/admin/content', adminOnly, (req, res) => {
  CONTENT = {}; saveContent(); res.json({ success:true });
});

// ── ADMIN: Manually trigger generation ─────────────────────
app.post('/api/admin/generate', adminOnly, (req, res) => {
  if (!KB.syllabus) return res.status(400).json({ error:'No syllabus' });
  if (GEN.running) return res.json({ message:'Already running', done:GEN.done, total:GEN.total });
  triggerPreGeneration();
  res.json({ message:'Started', total:KB.syllabus.topics.reduce((a,s)=>a+(s.topics?.length||0),0) });
});

// ── PRE-GENERATION ENGINE ───────────────────────────────────
async function triggerPreGeneration() {
  if (GEN.running || !KB.syllabus) return;
  const queue = [];
  KB.syllabus.topics.forEach(subj => {
    if (!VALID_SUBJECTS.includes(subj.key)) {
      console.warn(`triggerPreGeneration: skipping unknown subject key "${subj.key}"`);
      return;
    }
    (subj.topics||[]).forEach(t => {
      const topicSubj = t.subject || subj.key;
      if (topicSubj !== subj.key) {
        console.warn(`Skipping topic "${t.name}" — tagged to "${topicSubj}" but found under "${subj.key}"`);
        return;
      }
      queue.push({ subjKey:subj.key, subjName:subj.name, topicName:t.name, subtopics:t.subtopics||[] });
    });
  });
  if (!queue.length) return;
  await runGenQueue(queue);
}

async function triggerPreGenerationForSubject(subjKey) {
  if (GEN.running || !KB.syllabus) return;
  if (!VALID_SUBJECTS.includes(subjKey)) return;
  const subj = KB.syllabus.topics.find(s => s.key === subjKey);
  if (!subj) return;
  delete CONTENT[subjKey];
  const queue = (subj.topics||[])
    .filter(t => (t.subject || subjKey) === subjKey)
    .map(t => ({ subjKey, subjName:subj.name, topicName:t.name, subtopics:t.subtopics||[] }));
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
- CONCEPTUAL: question asks to define, distinguish, enumerate, or explain a doctrine — no specific parties or events. Leave "context" empty. Put the full question in "prompt" AND "q".`;

  const raw    = await callClaude([{ role:'user', content:prompt }], 4096);
  const parsed = JSON.parse(raw.replace(/^```json\s*/i,'').replace(/```$/,'').trim());
  if (!CONTENT[subjKey]) CONTENT[subjKey] = {};
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

Respond ONLY with valid JSON — an array of exactly ${needed} objects:
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

  const raw = await callClaude([{ role:'user', content:prompt }], 4000);
  const cleaned = raw.replace(/^```json\s*/i,'').replace(/```$/,'').trim();
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) return [];
  if (parsed.length < needed) {
    console.warn(`[mockbar/ai] AI returned ${parsed.length} but needed ${needed}`);
  }
  return parsed.slice(0, needed);
}

// ── MOCK BAR CORE LOGIC ──────────────────────────────────────
async function generateMockBar(subjects, count, options = {}) {
  const {
    sources      = { pastBar: true, preGen: true, aiGenerate: true },
    pastBarIds   = [],       // specific past bar file IDs to include; empty = all matching subjects
    includePreGen = null,    // explicit boolean override; null = use sources.preGen
    topics       = [],       // filter preGen pool to these topic names (when non-empty)
    difficulty   = 'balanced',
  } = options;

  const usePastBar  = sources.pastBar !== false;
  const usePreGen   = includePreGen !== null ? includePreGen : sources.preGen !== false;
  const useAI       = sources.aiGenerate !== false;

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
function detectQuestionFormat(questionText) {
  const q = questionText.toLowerCase();
  if (q.includes('true or false') || q.includes('true/false') || q.startsWith('t/f') || q.includes('state whether')) return 'truefalse';
  if (q.includes('which of the following') || q.includes('choose the correct') || q.includes('select the best') || /\ba\.\s|\bb\.\s|\bc\.\s/.test(q) || (q.includes('(a)') && q.includes('(b)'))) return 'mcq';
  if (q.includes('enumerate') || q.includes('list the') || q.includes('what are the requisites') || q.includes('what are the elements') || q.includes('what are the requirements') || q.includes('give the') || q.includes('name the')) return 'enumeration';
  if (q.includes('define ') || q.includes('what is meant by') || q.includes('distinguish between') || q.includes('differentiate') || q.includes('what do you understand by') || (q.startsWith('what is') && !q.includes('liable') && !q.includes('right') && !q.includes('remedy'))) return 'definition';
  return 'essay';
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
  const { question, answer, modelAnswer, keyPoints, subject } = req.body;
  const refCtx = KB.references.filter(r=>r.subject===subject).slice(0,1).map(r=>r.summary||'').join('');
  const format = detectQuestionFormat(question);
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
    const raw = await callClaude([{ role:'user', content: prompt }], maxTok);
    const result = JSON.parse(raw.replace(/^```json\s*/i,'').replace(/```$/,'').trim());
    result.format = result.format || format; // ensure format tag is present
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

// ── Fast synchronous syllabus parser (no Claude, no blocking) ─
function parseSyllabusText(content) {
  const SUBJECTS = [
    { key:'civil',      name:'Civil Law',                 patterns:['civil law','obligations and contracts','family code','property','succession law','obligations'] },
    { key:'labor',      name:'Labor Law',                 patterns:['labor law','social legislation','employment','labor standard','labor relation'] },
    { key:'political',  name:'Political Law',             patterns:['political law','constitutional law','public international','administrative law','constitutional'] },
    { key:'commercial', name:'Commercial Law',            patterns:['commercial law','corporation code','negotiable instruments','insurance','banking','securities','transport law'] },
    { key:'criminal',   name:'Criminal Law',              patterns:['criminal law','revised penal code','special penal','special laws','penal code'] },
    { key:'taxation',   name:'Taxation',                  patterns:['taxation','internal revenue','tariff','tax code','income tax','national tax'] },
    { key:'remedial',   name:'Remedial Law',              patterns:['remedial law','civil procedure','criminal procedure','evidence','special proceedings','rules of court'] },
    { key:'ethics',     name:'Legal and Judicial Ethics', patterns:['legal ethics','judicial ethics','code of professional','practical exercise','notarial','bar matters'] },
  ];
  const subjectMap = {};
  let currentKey   = null;
  let lastTopicIdx = -1;

  for (const rawLine of content.split(/\r?\n/)) {
    const line  = rawLine.trim();
    if (!line) continue;
    const lower = line.toLowerCase();

    // Match subject headings (line must be short and contain a known pattern)
    for (const s of SUBJECTS) {
      if (line.length < 150 && s.patterns.some(p => lower.includes(p))) {
        currentKey = s.key;
        if (!subjectMap[s.key]) subjectMap[s.key] = { key:s.key, name:s.name, topics:[] };
        lastTopicIdx = -1;
        break;
      }
    }

    // Match topic lines that start with a numbering/bullet prefix
    if (currentKey) {
      const m = line.match(/^(?:[IVXivx]+[.)]\s+|\d+[.)]\s+|[A-Za-z][.)]\s+|[-•·*]\s+)(.+)/);
      if (m) {
        const name   = m[1].trim();
        const indent = rawLine.search(/\S/);
        if (name.length >= 3 && name.length <= 200) {
          if (indent <= 3 || subjectMap[currentKey].topics.length === 0) {
            subjectMap[currentKey].topics.push({ name, subject: currentKey, subtopics:[] });
            lastTopicIdx = subjectMap[currentKey].topics.length - 1;
          } else if (lastTopicIdx >= 0) {
            subjectMap[currentKey].topics[lastTopicIdx].subtopics.push(name);
          }
        }
      }
    }
  }
  return Object.values(subjectMap);
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
      try {
        const raw = await callClaude([{ role:'user', content: extractPrompt }], 4000);
        chunkQ = JSON.parse(raw.replace(/^```json\s*/i,'').replace(/```$/,'').trim()).questions || [];
      } catch(e) {
        console.warn(`pastbar bg chunk ${i+1}: JSON parse failed — trying text-only retry`);
        try {
          const textRaw = await callClaude([{ role:'user', content:`This is an uploaded bar exam document. READ AND EXTRACT ONLY — do not create.\n\nFind all questions in this text. Copy each question exactly as written. If an answer appears in the text immediately after the question, copy it exactly. If no answer, use: "[No suggested answer in uploaded material]"\n\nReturn ONLY:\n{ "questions": [{ "q": "exact question text", "modelAnswer": "exact answer from document or [No suggested answer in uploaded material]", "keyPoints": [], "topics": ["${subject}"] }] }\n\nText:\n${chunks[i].slice(0,6000)}` }], 1500);
          chunkQ = JSON.parse(textRaw.replace(/^```json\s*/i,'').replace(/```$/,'').trim()).questions || [];
        } catch(e2) { console.warn(`pastbar bg chunk ${i+1}: retry also failed`); }
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
