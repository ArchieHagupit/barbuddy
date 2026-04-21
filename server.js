require('dotenv').config();
const compression = require('compression');
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
// pdf-parse and mammoth are lazy-loaded in /api/admin/parse-file to speed cold starts
const crypto     = require('crypto');
// ── Rate limiters ────────────────────────────────────────────

// ── Semaphore — limits concurrent AI calls globally ─────────
const { Semaphore } = require('./lib/semaphore');
const aiSemaphore = new Semaphore(20);

// ── Per-submission evaluation progress ──────────────────────

const { supabase } = require('./config/supabase');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── XP & Level System ─────────────────────────────────────────
const {
  XP_VALUES,
  LEVEL_THRESHOLDS,
  getLevelFromXP,
  getTitleFromLevel,
  getXPForNextLevel,
} = require('./lib/xp');
const { mapQRow, mapUser, mapPastBar, _mapResult } = require('./lib/mappers');

async function awardXP(userId, action, description, bonusXP = 0) {
  try {
    const xpEarned = (XP_VALUES[action] || 0) + bonusXP;
    if (xpEarned <= 0) return null;

    const { data: user } = await supabase
      .from('users')
      .select('xp, level')
      .eq('id', userId)
      .single();

    const oldXP    = user?.xp    || 0;
    const oldLevel = user?.level || 1;
    const newXP    = oldXP + xpEarned;
    const newLevel = getLevelFromXP(newXP);
    const leveledUp = newLevel > oldLevel;
    const newTitle   = getTitleFromLevel(newLevel);
    const oldTitle   = getTitleFromLevel(oldLevel);
    const titleChanged = newTitle !== oldTitle;

    await supabase.from('users').update({ xp: newXP, level: newLevel }).eq('id', userId);

    await supabase.from('xp_transactions').insert({
      id: `xp_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      user_id: userId,
      xp_earned: xpEarned,
      action,
      description,
    });

    const nextLevelXP = getXPForNextLevel(newLevel);
    const curLevelXP  = LEVEL_THRESHOLDS[newLevel - 1] || 0;
    const rangeXP     = (nextLevelXP || curLevelXP + 1) - curLevelXP;
    const progressPercent = nextLevelXP
      ? Math.floor(((newXP - curLevelXP) / rangeXP) * 100)
      : 100;

    return {
      xpEarned, oldXP, newXP, oldLevel, newLevel,
      leveledUp, oldTitle, newTitle, titleChanged,
      xpToNextLevel: nextLevelXP ? nextLevelXP - newXP : 0,
      progressPercent,
    };
  } catch (err) {
    console.error('[XP] Award error:', err);
    return null;
  }
}


const app       = express();
const PORT      = process.env.PORT || 3000;
const API_KEY   = process.env.ANTHROPIC_API_KEY;
const ADMIN_KEY   = process.env.ADMIN_KEY;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || null;

if (!ADMIN_KEY || ADMIN_KEY.length < 20) {
  console.error('[FATAL] ADMIN_KEY env var missing or too short (min 20 chars). Refusing to start.');
  process.exit(1);
}

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

// ── File system paths (PDF files only — all data now in Supabase) ──────────
const UPLOADS_DIR = process.env.PERSISTENT_STORAGE_PATH
  ? path.join(process.env.PERSISTENT_STORAGE_PATH, 'uploads')
  : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const SYLLABUS_PDFS_DIR = path.join(UPLOADS_DIR, 'syllabus-pdfs');
if (!fs.existsSync(SYLLABUS_PDFS_DIR)) fs.mkdirSync(SYLLABUS_PDFS_DIR, { recursive: true });

// Knowledge Base — syllabus + references + past bar
const KB = {
  syllabus:   null,   // { name, rawText, topics:[{key,name,topics:[{name,subtopics:[]}]}], uploadedAt }
  references: [],     // [{ id, name, subject, type, text, summary, size, uploadedAt }]
  pastBar:    [],     // [{ id, name, subject, year, questions:[{q,modelAnswer,keyPoints}], uploadedAt }]
};

// ── Questions table helpers ───────────────────────────────────
const { getQuestionsForSubject, getQuestionsForSubjects } = require('./lib/db-questions');

// Tab visibility settings (admin-controlled)
const DEFAULT_TAB_SETTINGS = {
  overview: true,
  spaced_repetition: true,
  subjects: {
    civil:      { learn: true, quiz: true, mockbar: true, speeddrill: true },
    criminal:   { learn: true, quiz: true, mockbar: true, speeddrill: true },
    political:  { learn: true, quiz: true, mockbar: true, speeddrill: true },
    labor:      { learn: true, quiz: true, mockbar: true, speeddrill: true },
    commercial: { learn: true, quiz: true, mockbar: true, speeddrill: true },
    taxation:   { learn: true, quiz: true, mockbar: true, speeddrill: true },
    remedial:   { learn: true, quiz: true, mockbar: true, speeddrill: true },
    ethics:     { learn: true, quiz: true, mockbar: true, speeddrill: true },
    custom:     { learn: true, quiz: false, mockbar: true, speeddrill: true },
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
const { extractJSON, repairJSON, sanitizeAIResponse } = require('./lib/json');
const { detectQuestionType, isCopyPastedFacts, getAlternatives, GRADE_SCALE } = require('./lib/eval-helpers');

// Auth/settings state — loaded from Supabase at startup, users+sessions live in DB
let RESET_REQUESTS = [];
// SETTINGS is a shared mutable object — see lib/db-settings.js comments.
const { SETTINGS, loadSettingsFromDB, getSetting, saveSetting } = require('./lib/db-settings');

// ── Field mappers: Supabase snake_case → camelCase for frontend ─────────────

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
// Syllabus tree helpers (pure functions — no KB dependency)
const {
  generateId,
  findInChildren,
  findNodeById,
  removeNodeById,
  getAllSubjectsWithSections,
  convertOldTopicsToSections,
  countAllTopics,
} = require('./lib/syllabus-tree');

function migrateSyllabusIfNeeded() {
  if (!KB.syllabus) {
    KB.syllabus = { subjects: {} };
    getAllSubjectsWithSections().forEach(s => { KB.syllabus.subjects[s] = { sections: [] }; });
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
    console.log('[syllabus] Migrated to manual builder format (in-memory only)');
  } else {
    // Ensure all subjects exist
    getAllSubjectsWithSections().forEach(s => {
      if (!KB.syllabus.subjects[s]) KB.syllabus.subjects[s] = { sections: [] };
    });
  }
}

// ── Supabase DB helpers ──────────────────────────────────────
const { createSession, verifySession, deleteSession, cleanupSessions } = require('./lib/db-sessions');
setInterval(cleanupSessions, 60 * 60 * 1000);

const { saveSyllabusSubject, savePastBarEntry, syncQuestionsFromBatch, deletePastBarEntry } = require('./lib/db-syllabus');

// ── App initialisation — loads all data from Supabase at startup ─────────────
async function initializeApp() {
  console.log('Loading from Supabase...');

  // Past bar
  const { data: pbRows } = await supabase.from('past_bar').select('*');
  KB.pastBar = (pbRows || []).map(mapPastBar);

  // Syllabus
  const { data: syllRows } = await supabase.from('syllabus').select('*');
  KB.syllabus = { subjects: {} };
  getAllSubjectsWithSections().forEach(s => { KB.syllabus.subjects[s] = { sections: [] }; });
  (syllRows || []).forEach(row => {
    KB.syllabus.subjects[row.subject] = { sections: row.sections || [] };
  });

  // References
  const refs = await getSetting('kb_references');
  KB.references = Array.isArray(refs) ? refs : [];

  // Tab settings
  const savedTS = await getSetting('tab_settings');
  if (savedTS) TAB_SETTINGS = deepMerge(JSON.parse(JSON.stringify(DEFAULT_TAB_SETTINGS)), savedTS);

  // App settings
  const regOpen   = await getSetting('registration_open');
  const mbPublic  = await getSetting('mock_bar_public');
  const examDate  = await getSetting('bar_exam_date');
  if (regOpen  !== null) SETTINGS.registrationOpen = !!regOpen;
  if (mbPublic !== null) SETTINGS.mockBarPublic    = !!mbPublic;
  if (examDate && typeof examDate === 'string') SETTINGS.barExamDate = examDate;

  // Reset requests
  const rr = await getSetting('reset_requests');
  RESET_REQUESTS = Array.isArray(rr) ? rr : [];

  await cleanupSessions();
  await loadSettingsFromDB();

  const totalQ = KB.pastBar.reduce((a, pb) => a + (pb.questions?.length || pb.qCount || 0), 0);
  console.log(`✅ Supabase loaded — ${KB.pastBar.length} past bar batches, ${totalQ} questions, ${KB.references.length} refs`);
}

// ── Middleware ──────────────────────────────────────────────
// Trust 2 proxy hops: Fastly edge → Railway edge → Express.
// With only 1 hop, req.ip becomes a Fastly edge node IP (rotates per request,
// breaks rate limiting). With 2, Express reads the real client IP from Fastly's
// X-Forwarded-For value. DO NOT set to `true` — that would trust arbitrary
// client-supplied X-Forwarded-For headers and defeat rate limiting.
app.set('trust proxy', 2);

// Access log: tiny format. Skip static asset + health-check noise.
const morgan = require('morgan');
app.use(morgan('tiny', {
  skip: (req) => req.path === '/api/health'
             || req.path.startsWith('/barbuddyemblem')
             || req.path === '/robots.txt'
             || req.path === '/favicon.ico',
}));

app.use(compression());
app.use(cors());

// Block WordPress/bot probes BEFORE anything else (static, auth, routes)
const { botBlocker } = require('./middleware/bot-blocker');
app.use(botBlocker);

// JSON body limit: small by default; file uploads use multer (separate limit)
app.use(express.json({ limit: '2mb' }));

app.get('/barbuddyemblem.webp', (req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1y',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

const { requireAuth, adminOnly, authOrAdmin } = require('./middleware/auth')({
  verifySession, mapUser, adminKey: ADMIN_KEY,
});

// ── Auth routes ──────────────────────────────────────────────
app.use(require('./routes/auth')({
  requireAuth, ADMIN_EMAIL, awardXP,
  getResetRequests: () => RESET_REQUESTS,
}));

// ── Admin user management (reset requests + user CRUD) ──
app.use(require('./routes/admin-users')({
  adminOnly,
  getResetRequests: () => RESET_REQUESTS,
}));

// ── Settings routes ───────────────────────────────────────────
app.use(require('./routes/settings')({ adminOnly }));

// ── Results routes ────────────────────────────────────────────
app.use(require('./routes/results')({ requireAuth, adminOnly, awardXP }));

// ── XP Summary ───────────────────────────────────────────────
app.get('/api/xp/summary', requireAuth, async (req, res) => {
  try {
    const { data: user } = await supabase
      .from('users')
      .select('xp, level')
      .eq('id', req.userId)
      .single();

    const xp    = user?.xp    || 0;
    const level = user?.level || 1;
    const title = getTitleFromLevel(level);
    const nextLevelXP  = getXPForNextLevel(level);
    const curLevelXP   = LEVEL_THRESHOLDS[level - 1] || 0;
    const rangeXP      = (nextLevelXP || curLevelXP + 1) - curLevelXP;
    const progressPercent = nextLevelXP ? Math.floor(((xp - curLevelXP) / rangeXP) * 100) : 100;
    const xpToNextLevel   = nextLevelXP ? nextLevelXP - xp : 0;

    const { data: recent } = await supabase
      .from('xp_transactions')
      .select('id, xp_earned, action, description, created_at')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(20);

    res.json({ xp, level, title, xpToNextLevel, progressPercent, recentTransactions: recent || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Spaced repetition routes (user-facing — admin variant stays below) ────
app.use(require('./routes/spaced-rep')({ requireAuth }));

// ── Admin: aggregated Improve items across all results ──────────
app.get('/api/admin/improve-items', adminOnly, async (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit)  || 20, 100);
    const offset   = parseInt(req.query.offset) || 0;
    const subject  = req.query.subject  || '';
    const dateFrom = req.query.dateFrom || '';
    const dateTo   = req.query.dateTo   || '';

    // Build filtered query for total count
    let countQ = supabase.from('results').select('id', { count: 'exact', head: true })
      .not('questions', 'is', null);
    if (subject && subject !== 'all') countQ = countQ.eq('subject', subject);
    if (dateFrom) countQ = countQ.gte('finished_at', dateFrom);
    if (dateTo)   countQ = countQ.lte('finished_at', dateTo + 'T23:59:59.999Z');
    const { count: totalResults } = await countQ;

    // Build filtered data query
    let dataQ = supabase.from('results')
      .select('id, user_id, subject, finished_at, questions, users(id, name, email)')
      .not('questions', 'is', null)
      .order('finished_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (subject && subject !== 'all') dataQ = dataQ.eq('subject', subject);
    if (dateFrom) dataQ = dataQ.gte('finished_at', dateFrom);
    if (dateTo)   dataQ = dataQ.lte('finished_at', dateTo + 'T23:59:59.999Z');

    const { data, error } = await dataQ;
    if (error) throw error;
    const items = [];
    for (const row of data || []) {
      const studentName = row.users?.name || row.user_id || 'Unknown';
      const subj        = row.subject     || '';
      const date        = row.finished_at || '';
      for (const q of row.questions || []) {
        const improves = Array.isArray(q.improvements) ? q.improvements : [];
        const missed   = Array.isArray(q.keyMissed)    ? q.keyMissed    : [];
        if (improves.length || missed.length) {
          items.push({
            resultId:    row.id,
            studentName,
            subject: subj,
            question:    q.q || '',
            improvements: improves,
            keyMissed:    missed,
            date,
          });
        }
      }
    }
    res.json({ items, total: totalResults || 0, offset, limit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin questions CRUD ───────────────────────────────────────
app.use(require('./routes/admin-questions')({ adminOnly }));

// ── Admin backfill routes (ALAC + conceptual + alternative-ALAC) ──
app.use(require('./routes/admin-backfill')({
  adminOnly,
  extractAlternativeAnswers,
  generateALACModelAnswer,
  generateConceptualModelAnswer,
}));


// ── ADMIN: Parse uploaded file to text ─────────────────────
app.post('/api/admin/parse-file', adminOnly, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  try {
    let text = '';
    if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(req.file.buffer);
      text = data.text;
    } else if (ext === '.docx' || ext === '.doc') {
      const mammoth = require('mammoth');
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

// ── Tab settings (public read + admin write + per-user overrides) ──
app.use(require('./routes/tab-settings')({
  requireAuth, adminOnly,
  getTabSettings: () => TAB_SETTINGS,
  setTabSettings: (v) => { TAB_SETTINGS = v; },
  DEFAULT_TAB_SETTINGS, deepMerge,
  saveSetting,
}));

// ── User state (progress, change-password, exam-session) ──────
app.use(require('./routes/user')({ requireAuth }));

// ── Bookmarks ─────────────────────────────────────────────────
app.use(require('./routes/bookmarks')({ requireAuth }));

// ── GET KB state (public — browser caches) ─────────────────
app.get('/api/kb', async (_req, res) => {
  const n = Object.values(CONTENT).reduce((a,s) => a+Object.keys(s).length, 0);
  const pastBarSummary = KB.pastBar.map(p => ({
    id: p.id, name: p.name, subject: p.subject,
    year: p.year || 'Unknown',
    qCount: p.questions?.length || p.qCount || 0,
    source: p.source || 'upload',
    uploadedAt: p.uploadedAt,
    enabled: p.enabled !== false,
  }));
  const totalQuestions = pastBarSummary.reduce((a,p) => a + p.qCount, 0);

  // Also get total count from normalized questions table
  let totalQuestionsDB = null;
  let subjectQuestionCounts = {};
  try {
    const { count } = await supabase
      .from('questions').select('*', { count: 'exact', head: true });
    totalQuestionsDB = count;
    // Per-subject counts
    for (const subj of VALID_SUBJECTS) {
      const { count: sc } = await supabase
        .from('questions').select('*', { count: 'exact', head: true }).eq('subject', subj);
      if (sc) subjectQuestionCounts[subj] = sc;
    }
  } catch(_) { /* non-fatal — table may not exist yet */ }

  res.json({
    hasSyllabus:    !!(KB.syllabus?.subjects),
    syllabusTopics: [],  // legacy field (new format uses /api/syllabus/:subject)
    references:     KB.references.map(r => ({ id:r.id, name:r.name, subject:r.subject, type:r.type, size:r.size, uploadedAt:r.uploadedAt })),
    pastBar:        pastBarSummary,
    totalQuestions,
    totalQuestionsDB,
    subjectQuestionCounts,
    contentTopics:  n,
    genState:       { running:GEN.running, done:GEN.done, total:GEN.total, current:GEN.current, finishedAt:GEN.finishedAt },
    customRefs:     KB.references.filter(r => r.subject === 'custom').length,
    customPastBar:  KB.pastBar.filter(p => p.subject === 'custom').length,
    customQuestions:KB.pastBar.filter(p => p.subject === 'custom').reduce((a,p) => a + (p.questions?.length||p.qCount||0), 0),
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

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch(e) {} }, 30000);

  // Max 5 minutes — prevents Railway connection pool exhaustion
  const maxDuration = setTimeout(() => {
    GEN.clients.delete(res);
    clearInterval(heartbeat);
    try { res.end(); } catch(e) {}
  }, 300000);

  req.on('close', () => {
    GEN.clients.delete(res);
    clearInterval(heartbeat);
    clearTimeout(maxDuration);
  });
});

function sseSend(client, data) { try { client.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e){} }
function broadcast() {
  const msg = { done:GEN.done, total:GEN.total, current:GEN.current, running:GEN.running, finished:!!GEN.finishedAt&&!GEN.running, errors:GEN.errors.length };
  GEN.clients.forEach(c => sseSend(c, msg));
}

// ── SYLLABUS HELPERS ────────────────────────────────────────
// countAllTopics moved to lib/syllabus-tree.js

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

// ── Syllabus routes (public read + admin CRUD + PDF serve/upload) ──
app.use(require('./routes/syllabus')({
  requireAuth, adminOnly, authOrAdmin,
  ADMIN_KEY, verifySession, KB, SYLLABUS_PDFS_DIR,
}));

// ── Admin KB management (references, wipe, diagnostic) ──
app.use(require('./routes/admin-kb')({
  adminOnly, KB,
  getCONTENT: () => CONTENT,
  setCONTENT: (v) => { CONTENT = v; },
  enqueueJob, summarizeLargeDoc, triggerPreGenerationForSubject,
}));

// ── Admin pastbar routes (upload, download, toggle, status, manual) ──
app.use(require('./routes/admin-pastbar')({
  adminOnly, KB, enqueueJob, extractPastBarInBackground,
}));

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
    includePreGen = false,   // explicit boolean override; false = never use pregen
    topics       = [],       // filter preGen pool to these topic names (when non-empty)
    difficulty   = 'balanced',
  } = options;

  const usePastBar  = sources.pastBar !== false;
  const usePreGen   = includePreGen === true && sources.preGen === true;
  const useAI       = sources.aiGenerate === true;

  let warning = null;

  // STEP 1: Build real past bar pool (try questions table first, fall back to in-memory KB)
  let realPool = [];
  if (usePastBar) {
    let dbPool = null;
    const targetSubjects = (!subjects || subjects.includes('all'))
      ? VALID_SUBJECTS
      : subjects;

    try {
      if (targetSubjects.length === 1) {
        dbPool = await getQuestionsForSubject(targetSubjects[0]);
      } else {
        dbPool = await getQuestionsForSubjects(targetSubjects);
      }
    } catch (e) {
      console.warn('[mockbar] questions table query failed, falling back to KB:', e.message);
    }

    if (dbPool && dbPool.length > 0) {
      realPool = dbPool; // enabled filter already applied in getQuestionsForSubject(s)
      console.log(`[mockbar] using questions table (${realPool.length} questions from enabled batches)`);
    } else {
      // Fall back to in-memory KB — only use enabled batches
      KB.pastBar.forEach(pb => {
        const subjMatch = !subjects || subjects.includes('all') || subjects.includes(pb.subject);
        if (subjMatch && pb.enabled !== false) {
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
      console.log(`[mockbar] using in-memory KB (${realPool.length})`);
    }
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
app.use(require('./routes/mockbar')({ API_KEY, generateMockBar }));

// ── Alternative answer extractor ──────────────────────────────────────────────
// Returns array of alternatives if the model answer contains multiple valid options,
// or [modelAnswer] (single-element) if only one answer exists.
function extractAlternativeAnswers(modelAnswer) {
  if (!modelAnswer || modelAnswer.length < 40) return [modelAnswer];

  // Pattern 1: "SUGGESTED ANSWER: ... ALTERNATIVE ANSWER: ..."
  // Strip leading "SUGGESTED ANSWER:" then split on alternative markers
  const stripped = modelAnswer.replace(/^suggested\s+answer\s*:?\s*/i, '');
  const altSplitParts = stripped
    .split(/(?:alternative\s+answer|another\s+answer|other\s+answer)\s*:?\s*/gi)
    .map(p => p.trim()).filter(p => p.length > 20);
  if (altSplitParts.length >= 2) return altSplitParts;

  // Pattern 2: bare "alternative answer" / "another answer" markers (no preceding suggested answer)
  const altRaw = modelAnswer
    .split(/(?:alternative\s+answer|another\s+answer|other\s+answer)\s*:?\s*/gi)
    .map(p => p.trim()).filter(p => p.length > 20);
  if (altRaw.length >= 2) return altRaw;

  // Pattern 3: "or alternatively" / "or in the alternative"
  if (/\bor\s+alternatively\b|\bor\s+in\s+the\s+alternative\b/i.test(modelAnswer)) {
    const parts = modelAnswer
      .split(/\bor\s+alternatively\b|\bor\s+in\s+the\s+alternative\b/i)
      .map(p => p.trim()).filter(p => p.length > 20);
    if (parts.length >= 2) return parts;
  }

  return [modelAnswer];
}

// ── ALAC model answer generator ────────────────────────────────────────────────
// Returns { formatted, components: {answer, legalBasis, application, conclusion} }
// - If plainModelAnswer already has >=3 ALAC markers, parses into components directly
// - Otherwise calls AI to reformat into ALAC structure
async function generateALACModelAnswer(questionText, contextText, plainModelAnswer, subject) {
  if (!plainModelAnswer) return null;

  // Helper: scan ALAC text into a components object
  function parseComponents(text) {
    const SECS = [
      { key: 'ANSWER',      field: 'answer' },
      { key: 'LEGAL BASIS', field: 'legalBasis' },
      { key: 'APPLICATION', field: 'application' },
      { key: 'CONCLUSION',  field: 'conclusion' },
    ];
    const up = text.toUpperCase();
    const found = SECS.map(s => ({ ...s, idx: up.indexOf(s.key + ':') }))
      .filter(s => s.idx !== -1)
      .sort((a, b) => a.idx - b.idx);
    const comps = { answer: '', legalBasis: '', application: '', conclusion: '' };
    found.forEach((s, i) => {
      const start = s.idx + s.key.length + 1;
      const end = found[i + 1] ? found[i + 1].idx : text.length;
      comps[s.field] = text.slice(start, end).trim();
    });
    return comps;
  }

  const upper = plainModelAnswer.toUpperCase();
  const matchCount = ['ANSWER:', 'LEGAL BASIS:', 'APPLICATION:', 'CONCLUSION:'].filter(kw => upper.includes(kw)).length;

  // Already in ALAC format — parse without an extra AI call
  if (matchCount >= 3) {
    return { formatted: plainModelAnswer, components: parseComponents(plainModelAnswer) };
  }

  // Ask AI to reformat into structured ALAC
  const prompt = `You are a Philippine bar exam coach. Convert this model answer into strict ALAC format.

Subject: ${subject || 'Philippine Law'}
Question: ${questionText}
${contextText ? 'Facts: ' + contextText : ''}
Model Answer: ${plainModelAnswer}

Respond ONLY with raw JSON (no markdown, no backticks):
{"answer":"[Direct yes/no ruling — 1-2 sentences]","legalBasis":"[Cite specific law, article, provision, or case — 1-2 sentences]","application":"[Apply the law to the specific facts — 2-4 sentences]","conclusion":"[Restate the final ruling — 1 sentence]"}`;

  try {
    const res = await callClaudeJSON([{ role: 'user', content: prompt }], 2500);
    if (res?.answer) {
      const components = {
        answer:      res.answer || '',
        legalBasis:  res.legalBasis || '',
        application: res.application || '',
        conclusion:  res.conclusion || '',
      };
      const formatted = [
        `ANSWER: ${components.answer}`,
        `LEGAL BASIS: ${components.legalBasis}`,
        `APPLICATION: ${components.application}`,
        `CONCLUSION: ${components.conclusion}`,
      ].filter(s => !s.match(/:\s*$/)).join('\n\n');
      return { formatted, components };
    }
  } catch (e) {
    console.warn('[generateALACModelAnswer] AI call failed:', e.message);
  }

  // Fallback: return plain text with parsed components (may be empty if no markers)
  return { formatted: plainModelAnswer, components: parseComponents(plainModelAnswer) };
}

// ── Conceptual model answer generator ──────────────────────────────────────────
// Returns structured { overview, accuracy, completeness, clarity, conclusion, keyProvisions }
async function generateConceptualModelAnswer(questionText, plainModelAnswer) {
  if (!plainModelAnswer) return null;

  const prompt = `You are a Philippine bar exam expert.

Generate a model answer for this CONCEPTUAL bar exam question that demonstrates perfect Accuracy, Completeness, and Clarity.

Question: ${questionText}
Suggested Answer: ${plainModelAnswer}

Return ONLY this JSON (no markdown, no preamble):
{
  "overview": "Direct one-sentence answer",
  "accuracy": {
    "label": "Accuracy",
    "content": "Accurate legal definition with correct provisions and jurisprudence",
    "keyPoints": ["point1", "point2"]
  },
  "completeness": {
    "label": "Completeness",
    "content": "All essential elements covered including exceptions and qualifications",
    "keyPoints": ["element1", "element2"]
  },
  "clarity": {
    "label": "Clarity",
    "content": "Clear organized presentation with proper legal language and conclusion",
    "keyPoints": ["structure1", "structure2"]
  },
  "conclusion": "Conclusory statement",
  "keyProvisions": ["provision1", "case1"]
}

IMPORTANT: Return pure JSON only. No { } inside string values. Plain text sentences only.`;

  try {
    const res = await callClaudeJSON([{ role: 'user', content: prompt }], 2000);
    if (res?.overview || res?.accuracy) return res;
  } catch (e) {
    console.warn('[generateConceptualModelAnswer] AI call failed:', e.message);
  }
  return null;
}

// ── callClaudeHaikuJSON — haiku-only, semaphore-guarded, for fast batch eval ─
async function callClaudeHaikuJSON(prompt, maxTokens = 3000, _truncRetry = 0) {
  await aiSemaphore.acquire();
  const JSON_SYSTEM = 'You are a JSON API endpoint. Output ONLY valid JSON. STRICT RULES: (1) Use single quotes inside string values — NEVER double quotes inside strings. (2) No literal newlines inside string values — use \\n if needed. (3) No trailing commas anywhere. (4) Response must start with { and end with }. (5) No markdown, no code fences, no backticks, no explanations. (6) If feedback contains quotes, use single quotes instead.';
  const JSON_SUFFIX = '\n\nCRITICAL: Return ONLY raw JSON. No markdown. No backticks. No fences. Start with { and end with }. Use single quotes inside string values (never double quotes inside strings). No trailing commas. No line breaks inside string values.';
  try {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      temperature: 0,
      system: JSON_SYSTEM,
      messages: [{ role: 'user', content: prompt + JSON_SUFFIX }],
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
        body,
        signal: AbortSignal.timeout(35000), // 35s timeout per attempt
      });
      const d = await r.json();
      if (r.status === 529 || r.status === 429 || d?.error?.type === 'overloaded_error') {
        if (attempt < 3) { await sleep(attempt * 5000); continue; }
        throw new Error('Haiku overloaded after retries');
      }
      if (d.error) throw new Error(d.error.message);
      if (d.usage) {
        const _tot = d.usage.input_tokens + d.usage.output_tokens;
        console.log(`[tokens] haiku | in:${d.usage.input_tokens} out:${d.usage.output_tokens} total:${_tot}`);
      }
      // Detect truncation — retry once with more tokens
      if (d.stop_reason === 'max_tokens') {
        console.warn('[callClaudeHaikuJSON] Truncated!', 'Used:', d.usage?.output_tokens, '/', maxTokens, 'tokens.', 'Retrying with', maxTokens + 1000);
        if (_truncRetry < 1) {
          return callClaudeHaikuJSON(prompt, maxTokens + 1000, _truncRetry + 1);
        }
        console.warn('[callClaudeHaikuJSON] Still truncated after retry — proceeding with partial response.');
      }
      const raw = sanitizeAIResponse(d.content.map(c => c.text || '').join(''));
      const parsed = extractJSON(raw);
      if (parsed !== null) return parsed;
      if (attempt < 3) await sleep(1000);
    }
    return null;
  } finally {
    aiSemaphore.release();
  }
}

// ── Eval queue subsystem (extracted to lib/eval-queue.js) ────────
// Factory takes server.js-resident deps and returns the queue + Maps.
// processEvalQueue and runEvalJob are module-internal.
const { evalProgress, evalResults, xpResults, EvalQueue, enqueueEval } = require('./lib/eval-queue')({
  KB, callClaudeHaikuJSON, generateALACModelAnswer, generateConceptualModelAnswer, awardXP,
});


// ── Eval routes (progress polling, SSE queue-status, results, queue-stats, /evaluate, /evaluate-batch) ──
app.use(require('./routes/evaluate')({
  requireAuth, adminOnly,
  evalProgress, evalResults, xpResults, EvalQueue, enqueueEval,
  API_KEY, KB, awardXP,
  callClaudeJSON, generateALACModelAnswer, generateConceptualModelAnswer,
}));




// ── EMAIL ROUTES ─────────────────────────────────────────────
app.use(require('./routes/email')());

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
    await savePastBarEntry(entry); // also calls syncQuestionsFromBatch internally
  } catch(err) {
    console.error(`pastbar bg [${name}] failed: ${err.message}`);
    entry.extracting  = false;
    entry.extractError = err.message;
    await savePastBarEntry(entry).catch(() => {});
  }
}

// callClaudeJSON: like callClaude but retries until it gets valid JSON back
const JSON_FORMAT_REMINDER = '\n\nRESPONSE FORMAT — STRICTLY FOLLOW:\n1. Your ENTIRE response must be valid JSON only\n2. Start with { or [ immediately — no preamble\n3. End with } or ] — no text after\n4. No markdown code fences (no ```)\n5. No explanations before or after the JSON\n6. If unsure, return the JSON with empty arrays rather than explaining why';

async function callClaudeJSON(messages, maxTokens, retries = 3, { temperature } = {}) {
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
      const raw = sanitizeAIResponse(await callClaude(attempt === 1 ? msgs : [attemptMsgs[0]], maxTokens, { temperature }));
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
async function callClaude(messages, max_tokens=2000, { temperature } = {}) {
  const SONNET = 'claude-sonnet-4-5-20250929';
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
      body:JSON.stringify({ model, max_tokens, ...(temperature != null && { temperature }), messages, system: STRICT_SYSTEM_PROMPT }),
    });
    const d = await r.json();
    if (d.usage) {
      const _tot = d.usage.input_tokens + d.usage.output_tokens;
      console.log(`[tokens] ${model} | in:${d.usage.input_tokens} out:${d.usage.output_tokens} total:${_tot}`);
    }
    if (isOverloaded(r.status, d)) {
      if (i < SCHEDULE.length - 1) continue;
      throw new Error('API overloaded — please try again in a few minutes');
    }
    if (d.error) throw new Error(d.error.message);
    if (d.stop_reason === 'max_tokens') console.warn(`[callClaude] Response truncated! model=${model} used=${d.usage?.output_tokens} tokens. Increase max_tokens.`);
    if (i > 0) console.log(`Claude success on attempt ${i+1} with ${model}`);
    return d.content.map(c => c.text || '').join('');
  }
}
const shuffle = arr => { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
const sleep   = ms  => new Promise(r => setTimeout(r, ms));


// ── API Status — tests Claude reachability with 10s timeout ─
// CONTENT is kept in-memory only (regenerable from KB); no disk persistence needed
function saveContent() { /* no-op — CONTENT is in-memory only */ }

// ── Misc routes (health, status, job, storage-info, robots, catchall) ──
// Mounted LAST so the '*' catchall doesn't intercept earlier routes.
app.use(require('./routes/misc')({
  adminOnly, API_KEY, KB, CONTENT, GEN, JOB_MAP, JOB_QUEUE, UPLOADS_DIR,
}));

async function migrateOldQuestionTypes() {
  const oldTypes = ['mcq', 'truefalse', 'true_false', 'enumeration', 'definition', 'identification'];
  const { error } = await supabase
    .from('questions')
    .update({ type: 'conceptual' })
    .in('type', oldTypes);
  if (error) console.warn('[migrate] Type migration warning:', error.message);
  else console.log('[migrate] Question types normalized to situational/conceptual');
}

async function migrateUserSchema() {
  // Ensure existing users without a status field default to 'active'
  try {
    await supabase.from('users').update({ status: 'active' }).is('status', null);
  } catch (_) { /* ignore — non-fatal */ }
  console.log('[startup] User schema ready');
}

initializeApp().then(() => {
  migrateOldQuestionTypes().catch(e => console.warn('[migrate] Skipped:', e.message));
  migrateUserSchema().catch(e => console.warn('[migrate] User schema skipped:', e.message));
  app.listen(PORT, () => {
    const totalQ        = KB.pastBar.reduce((a, pb) => a + (pb.questions?.length || pb.qCount || 0), 0);
    const subjsWithData = [...new Set(KB.pastBar.map(pb => pb.subject))].join(', ') || 'none';
    console.log('\n═══ BarBuddy v3 Startup ═══════════════');
    console.log(`  Port:          ${PORT}`);
    console.log(`  Storage:       Supabase`);
    console.log(`  Past bar:      ${KB.pastBar.length} items`);
    console.log(`  Total Q:       ${totalQ}`);
    console.log(`  Manual:        ${KB.pastBar.filter(pb => pb.source === 'manual').length} batches`);
    console.log(`  References:    ${KB.references.length}`);
    console.log(`  Subjects:      ${subjsWithData}`);
    console.log('════════════════════════════════════════\n');
  });
}).catch(err => {
  console.error('❌ Failed to initialize from Supabase:', err.message);
  process.exit(1);
});
