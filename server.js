const compression = require('compression');
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const pdfParse   = require('pdf-parse');
const mammoth    = require('mammoth');
const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const bcrypt     = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

// ── Semaphore — limits concurrent AI calls globally ─────────
class Semaphore {
  constructor(max) { this.max = max; this.count = 0; this.queue = []; }
  acquire() {
    return new Promise(resolve => {
      if (this.count < this.max) { this.count++; resolve(); }
      else this.queue.push(resolve);
    });
  }
  release() {
    this.count--;
    if (this.queue.length) { this.count++; this.queue.shift()(); }
  }
}
const aiSemaphore = new Semaphore(20);

// ── Per-submission evaluation progress ──────────────────────
const evalProgress = new Map(); // submissionId → { total, done, complete }
const evalResults  = new Map(); // submissionId → scores array (set after all jobs finish)
const xpResults    = new Map(); // submissionId → xpData (set after awardXP resolves)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── XP & Level System ─────────────────────────────────────────
const XP_VALUES = {
  MOCK_BAR_FULL_BONUS:      1000,  // flat bonus when exactly 20 questions
  MOCK_BAR_PER_QUESTION:      10,  // per question when partial (< 20)
  COMPLETE_SPEED_DRILL:       40,  // flat per speed drill completion
  HIGH_SCORE_BONUS:           50,  // per question scoring 8.0+ in any mode
  DAILY_LOGIN:                10,  // once per day
  STREAK_BONUS:               25,  // per day of active streak
  FIRST_SUBJECT_COMPLETE:    200,  // one-time per subject
  MASTER_SPACED_REP:          30,  // per question mastered
  COMPLETE_REVIEW_SESSION:    60,  // spaced repetition review session
};

const LEVEL_THRESHOLDS = [
  0, 100, 200, 350, 500, 700, 900, 1150, 1400, 1700,
  2000, 2400, 2800, 3300, 3800, 4400, 5000, 5700, 6400, 7200,
  8000, 9000, 10000, 11200, 12400, 13800, 15200, 16800, 18400, 20200,
  22000, 24200, 26400, 28800, 31200, 33800, 36400, 39200, 42000, 45000,
  48000, 51500, 55000, 58800, 62600, 66600, 70600, 74800, 79000, 83500,
  88000, 93000, 98000, 103500, 109000, 115000, 121000, 127500, 134000, 141000,
  148000, 156000, 164000, 172500, 181000, 190000, 199000, 208500, 218000, 228000,
  238000, 249000, 260000, 271500, 283000, 295000, 307000, 319500, 332000, 345000,
  358500, 372500, 386500, 401000, 415500, 430500, 445500, 461000, 476500, 492500,
  509000, 526000, 543000, 560500, 578000, 596000, 614000, 632500, 651000, 100000000,
];

function getLevelFromXP(xp) {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= LEVEL_THRESHOLDS[i]) return i + 1;
  }
  return 1;
}

function getTitleFromLevel(level) {
  if (level >= 100) return 'Attorney-at-Law';
  if (level >= 91)  return 'Senior Partner';
  if (level >= 71)  return 'Partner';
  if (level >= 51)  return 'Senior Counsel';
  if (level >= 31)  return 'Junior Counsel';
  if (level >= 11)  return 'Associate';
  return 'Law Student';
}

function getXPForNextLevel(currentLevel) {
  return LEVEL_THRESHOLDS[currentLevel] || null;
}

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
const ADMIN_KEY   = process.env.ADMIN_KEY   || 'barbuddy-admin-2025';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || null;

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
// Map a questions-table row to the shape expected by generateMockBar
function mapQRow(q) {
  return {
    id: q.id,
    q: q.question_text,
    context: q.context,
    modelAnswer: q.model_answer,
    keyPoints: q.key_points || [],
    subject: q.subject,
    source: q.source,
    year: q.year,
    type: q.type || 'essay',
    isReal: true,
    pastBarId: q.batch_id,
    pastBarName: q.source,
    max: q.max_score || 10,
    // Cache fields — populated from DB, used by runEvalJob to skip redundant AI calls
    _cachedAlternatives: q.alternative_answers || null,
    _cachedAlac: q.model_answer_alac || null,
  };
}

async function getQuestionsForSubject(subject, limit = 400) {
  const { data, error } = await supabase
    .from('questions')
    .select('*, batch_info:past_bar!batch_id(enabled)')
    .eq('subject', subject);
  if (error || !data || data.length === 0) return null; // null = fall back to KB
  const enabled = data.filter(q => q.batch_info?.enabled !== false);
  if (enabled.length === 0) return null;
  const shuffled = enabled.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, limit).map(mapQRow);
}

async function getQuestionsForSubjects(subjects, limit = 800) {
  const { data, error } = await supabase
    .from('questions')
    .select('*, batch_info:past_bar!batch_id(enabled)')
    .in('subject', subjects);
  if (error || !data || data.length === 0) return null; // null = fall back to KB
  const enabled = data.filter(q => q.batch_info?.enabled !== false);
  if (enabled.length === 0) return null;
  const shuffled = enabled.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, limit).map(mapQRow);
}

// Tab visibility settings (admin-controlled)
const DEFAULT_TAB_SETTINGS = {
  overview: true,
  subjects: {
    civil:      { learn: true, quiz: true, mockbar: true, speeddrill: true },
    criminal:   { learn: true, quiz: true, mockbar: true, speeddrill: true },
    political:  { learn: true, quiz: true, mockbar: true, speeddrill: true },
    labor:      { learn: true, quiz: true, mockbar: true, speeddrill: true },
    commercial: { learn: true, quiz: true, mockbar: true, speeddrill: true },
    taxation:   { learn: true, quiz: true, mockbar: true, speeddrill: true },
    remedial:   { learn: true, quiz: true, mockbar: true, speeddrill: true },
    ethics:     { learn: true, quiz: true, mockbar: true, speeddrill: true },
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
function extractJSON(text) {
  if (!text) return null;

  // Sanitize: remove BOM and control characters before anything else
  let t = text
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();

  // Fix invalid JSON escape sequences that AI models emit
  t = t
    .replace(/\\'/g,  "'")   // \' → '
    .replace(/\\s/g,  "s")   // \s → s
    .replace(/\\d/g,  "d")   // \d → d
    .replace(/\\w/g,  "w")   // \w → w
    .replace(/\\-/g,  "-")   // \- → -
    .replace(/\\%/g,  "%")   // \% → %
    .replace(/\\&/g,  "&")   // \& → &
    .replace(/\\\(/g, "(")   // \( → (
    .replace(/\\\)/g, ")")   // \) → )
    .replace(/\\\./g, ".")   // \. → .  (note: /\\./ would match any char — use /\\\. /)
    .replace(/\\,/g,  ",")   // \, → ,
    .replace(/\\:/g,  ":")   // \: → :
    .replace(/\\;/g,  ";");  // \; → ;

  // Strip { } inside quoted string values using a character-by-character walk so
  // structural braces are preserved and escaped quotes are handled correctly.
  function sanitizeNestedBraces(str) {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (escaped) { result += ch; escaped = false; continue; }
      if (ch === '\\') { escaped = true; result += ch; continue; }
      if (ch === '"') { inString = !inString; result += ch; continue; }
      if (inString && ch === '{') { result += ''; continue; }
      if (inString && ch === '}') { result += ''; continue; }
      result += ch;
    }
    return result;
  }
  t = sanitizeNestedBraces(t);

  // Fix trailing commas before closing braces/brackets
  t = t.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');

  // Fix non-JSON numeric literals
  t = t.replace(/:\s*NaN/g, ': null').replace(/:\s*Infinity/g, ': null').replace(/:\s*undefined/g, ': null');

  // Strip markdown fences (Sonnet fallback returns ```json ... ```)
  t = t
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Strategy 1: Direct parse
  try {
    return JSON.parse(t);
  } catch(e) {
    const pos = parseInt(e.message.match(/position (\d+)/)?.[1]);
    if (!isNaN(pos)) {
      console.warn('[extractJSON] Strategy 1 failed:', e.message, '| char code at pos:', t.charCodeAt(pos));
    } else {
      console.warn('[extractJSON] Strategy 1 failed:', e.message);
    }
  }

  // Strategy 2: Strip markdown fences (secondary pass on original t)
  let stripped = t
    .replace(/^```(?:json)?[\r\n]*/i, '')
    .replace(/[\r\n]*```[\s\S]*$/i, '')
    .trim();
  try { return JSON.parse(stripped); } catch(_) {}

  // Strategy 3: Brace-matched extraction (string-aware, handles trailing text)
  {
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (esc)          { esc = false; continue; }
      if (ch === '\\')  { esc = true;  continue; }
      if (ch === '"')   { inStr = !inStr; continue; }
      if (inStr)        continue;
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start !== -1) {
          try { return JSON.parse(t.slice(start, i + 1)); } catch(_) { break; }
        }
      }
    }
  }

  // Strategy 4: Aggressive repair then parse
  try {
    const repaired = repairJSON(t);
    if (repaired) return JSON.parse(repaired);
  } catch(_) {}

  // Strategy 5: jsonrepair as last resort (handles structural issues)
  try {
    const { jsonrepair } = require('jsonrepair');
    const repaired = jsonrepair(t);
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === 'object') {
      console.log('[extractJSON] Strategy 5 (jsonrepair) succeeded');
      return parsed;
    }
  } catch(e) {
    console.warn('[extractJSON] Strategy 5 (jsonrepair) failed:', e.message);
  }

  console.error('[extractJSON] All strategies failed. First 300 chars:', t.slice(0, 300));
  return null;
}

function repairJSON(text) {
  if (!text) return null;
  let t = text.replace(/^\uFEFF/, '').trim();

  // Strip markdown fences
  t = t.replace(/^```(?:json)?[\r\n]*/i, '').replace(/[\r\n]*```[\s\S]*$/i, '').trim();

  // Find outermost braces
  const start = t.indexOf('{');
  const end   = t.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  t = t.slice(start, end + 1);

  // Fix 1: Remove trailing commas before } or ]
  t = t.replace(/,(\s*[}\]])/g, '$1');

  // Fix 2: Escape unescaped control chars inside strings (char-by-char)
  let result = '', inStr = false, escaped = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i], code = t.charCodeAt(i);
    if (escaped)       { result += ch; escaped = false; continue; }
    if (ch === '\\')   { result += ch; escaped = true;  continue; }
    if (ch === '"')    { inStr = !inStr; result += ch; continue; }
    if (inStr) {
      if      (code === 10) result += '\\n';
      else if (code === 13) result += '\\r';
      else if (code === 9)  result += '\\t';
      else result += ch;
    } else {
      result += ch;
    }
  }

  // Fix 3: Close any open string and open braces (handles truncation)
  let depth = 0, inString = false, isEscaped = false;
  for (let i = 0; i < result.length; i++) {
    const ch = result[i];
    if (isEscaped)    { isEscaped = false; continue; }
    if (ch === '\\')  { isEscaped = true;  continue; }
    if (ch === '"')   { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
  }
  if (inString) result += '"';
  while (depth > 0) { result += '}'; depth--; }

  return result;
}

function sanitizeAIResponse(text) {
  if (!text) return text;
  return text
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

// Auth/settings state — loaded from Supabase at startup, users+sessions live in DB
let RESET_REQUESTS = [];
const SETTINGS = { registrationOpen: true, mockBarPublic: true, barExamDate: '2026-11-01' };

// ── Field mappers: Supabase snake_case → camelCase for frontend ─────────────
function mapUser(u) {
  if (!u) return null;
  return {
    id:                u.id,
    name:              u.name,
    email:             u.email,
    passwordHash:      u.password_hash,
    isAdmin:           u.is_admin || false,
    isActive:          u.is_active !== false,
    role:              u.is_admin ? 'admin' : 'student',
    active:            u.is_active !== false,
    status:            u.status || 'active',
    joinedAt:          u.joined_at,
    createdAt:         u.joined_at || u.registered_at,
    registeredAt:      u.registered_at || u.joined_at,
    tabSettings:       u.tab_settings || {},
    progress:          u.progress || {},
    activeExamSession: u.active_exam_session || null,
    mockBarCount:      u.mock_bar_count || 0,
    avgScore:          u.avg_score || 0,
    school:            u.school || null,
    stats: { totalAttempts: u.mock_bar_count || 0, totalScore: 0, totalQuestions: 0 },
  };
}

function mapPastBar(pb) {
  if (!pb) return null;
  return {
    id:         pb.id,
    name:       pb.name,
    subject:    pb.subject,
    year:       pb.year,
    source:     pb.source,
    questions:  pb.questions || [],
    qCount:     pb.q_count || 0,
    uploadedAt: pb.uploaded_at,
    enabled:    pb.enabled !== false,  // default true
  };
}

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

// ── Supabase DB helpers ──────────────────────────────────────
async function getSetting(key) {
  const { data } = await supabase.from('settings').select('value').eq('key', key).single();
  return data ? data.value : null;
}
async function saveSetting(key, value) {
  await supabase.from('settings').upsert([{ key, value, updated_at: new Date().toISOString() }], { onConflict: 'key' });
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('sessions').insert([{ token, user_id: userId, expires_at: expires }]);
  return token;
}
async function verifySession(token) {
  const { data } = await supabase
    .from('sessions')
    .select('*, users(*)')
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .single();
  return data || null;
}
async function deleteSession(token) {
  await supabase.from('sessions').delete().eq('token', token);
}
async function cleanupSessions() {
  await supabase.from('sessions').delete().lt('expires_at', new Date().toISOString());
}
setInterval(cleanupSessions, 60 * 60 * 1000);

async function saveSyllabusSubject(subject, sections) {
  await supabase.from('syllabus').upsert(
    [{ subject, sections, updated_at: new Date().toISOString() }],
    { onConflict: 'subject' }
  );
}
async function savePastBarEntry(entry) {
  await supabase.from('past_bar').upsert([{
    id: entry.id, name: entry.name, subject: entry.subject,
    year: entry.year || 'Unknown', source: entry.source || 'upload',
    questions: entry.questions || [], q_count: entry.questions?.length || entry.qCount || 0,
    uploaded_at: entry.uploadedAt || new Date().toISOString(),
  }], { onConflict: 'id' });
  await syncQuestionsFromBatch(entry);
}

async function syncQuestionsFromBatch(batch) {
  const questions = batch.questions || [];
  if (questions.length === 0) return;

  for (let i = 0; i < questions.length; i++) {
    const q   = questions[i];
    const qId = `q_${batch.id}_${i}`;
    await supabase.from('questions').upsert([{
      id:            qId,
      batch_id:      batch.id,
      subject:       batch.subject,
      year:          q.year    || batch.year   || 'Unknown',
      source:        q.source  || batch.source || 'upload',
      type:          q.type    || 'situational',
      question_text: q.q       || q.question   || q.question_text || '',
      context:       q.context || q.facts      || null,
      model_answer:  q.answer  || q.modelAnswer || null,
      key_points:    q.keyPoints || q.key_points || [],
      max_score:     q.max     || q.maxScore    || 10,
    }], { onConflict: 'id' });
  }

  console.log(`Synced ${questions.length} questions from ${batch.name}`);
}

async function deletePastBarEntry(id) {
  await supabase.from('past_bar').delete().eq('id', id);
}

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

  const totalQ = KB.pastBar.reduce((a, pb) => a + (pb.questions?.length || pb.qCount || 0), 0);
  console.log(`✅ Supabase loaded — ${KB.pastBar.length} past bar batches, ${totalQ} questions, ${KB.references.length} refs`);
}

// ── Middleware ──────────────────────────────────────────────
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function requireAuth(req, res, next) {
  try {
    const token = req.headers['x-session-token'];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const session = await verifySession(token);
    if (!session) return res.status(401).json({ error: 'Session expired' });
    req.userId = session.user_id;
    req.user   = mapUser(session.users);
    next();
  } catch(e) { res.status(500).json({ error: 'Auth error' }); }
}

async function adminOnly(req, res, next) {
  try {
    const key = req.headers['x-admin-key'] || req.body?.adminKey;
    if (key && key === ADMIN_KEY) return next();
    const token = req.headers['x-session-token'];
    if (token) {
      const session = await verifySession(token);
      if (session?.users?.is_admin) {
        req.userId = session.user_id;
        req.user   = mapUser(session.users);
        return next();
      }
    }
    return res.status(401).json({ error: 'Unauthorized' });
  } catch(e) { res.status(500).json({ error: 'Auth error' }); }
}

async function authOrAdmin(req, res, next) {
  try {
    const adminKey = req.headers['x-admin-key'] || req.body?.adminKey;
    if (adminKey === ADMIN_KEY) return next();
    const token = req.headers['x-session-token'];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const session = await verifySession(token);
    if (!session) return res.status(401).json({ error: 'Session expired' });
    req.userId = session.user_id;
    req.user   = mapUser(session.users);
    next();
  } catch(e) { res.status(500).json({ error: 'Auth error' }); }
}

// ── Block WordPress/bot probe paths ──────────────────────────
app.use((req, res, next) => {
  const path = req.path.toLowerCase();
  const blocked = [
    '/wp-admin', '/wp-includes', '/wp-login',
    '/wp-content', '/wp-json', '/wp-cron',
    '/wordpress', '/xmlrpc.php', '/wlwmanifest',
    '/feed', '/wp1', '/wp2',
    'license.txt', 'readme.html',
    'setup-config'
  ];
  const normalizedPath = path.replace(/\/+/g, '/');
  if (blocked.some(b => normalizedPath.includes(b))) return res.status(404).send('Not found');
  next();
});

// ── Auth routes ──────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    if (!SETTINGS.registrationOpen) return res.status(403).json({ error: 'Registration is currently closed' });
    const { name, email, password, school } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required' });
    const emailLower = email.toLowerCase().trim();
    const { data: existing } = await supabase.from('users').select('id').eq('email', emailLower).single();
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const { count } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const isFirstUser  = (count || 0) === 0;
    const isAdminEmail = ADMIN_EMAIL && emailLower === ADMIN_EMAIL.toLowerCase();
    const isPrivileged = isFirstUser || !!isAdminEmail;
    const id = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const passwordHash = await bcrypt.hash(password, 10);
    const now = new Date().toISOString();
    const { error: insertErr } = await supabase.from('users').insert([{
      id, name: name.trim(), email: emailLower, password_hash: passwordHash,
      is_admin: isPrivileged, is_active: true,
      status: 'active',
      privacy_consent: true, consent_date: now,
      registered_at: now, joined_at: now,
      progress: {}, tab_settings: {},
      school: school || null,
    }]);
    if (insertErr) throw insertErr;

    const token = await createSession(id);
    return res.json({ token, user: { id, name: name.trim(), email: emailLower,
      role: isPrivileged ? 'admin' : 'student', isAdmin: isPrivileged } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const { data: user } = await supabase.from('users').select('*').eq('email', email.toLowerCase().trim()).single();
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.is_active) return res.status(403).json({ error: 'Account is disabled' });
    if (user.status === 'rejected' || user.status === 'disabled') {
      return res.status(403).json({ error: 'account_disabled', message: 'Your account has been disabled. Please contact the admin.' });
    }
    const token = await createSession(user.id);
    // Daily login XP (once per calendar day)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }); // YYYY-MM-DD in PHT
    if (user.last_login_xp_date !== today) {
      await supabase.from('users').update({ last_login_xp_date: today }).eq('id', user.id);
      awardXP(user.id, 'DAILY_LOGIN', 'Daily login bonus').catch(() => {});
    }
    const u = mapUser(user);
    res.json({ token, user: { id: u.id, name: u.name, email: u.email, role: u.role, isAdmin: u.isAdmin } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  try {
    await deleteSession(req.headers['x-session-token']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, name: u.name, email: u.email, role: u.role, isAdmin: u.isAdmin || false });
});

// TEMPORARY EXPORT ROUTES
app.get('/api/admin/export/kb', (req, res) => {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const storagePath = process.env.PERSISTENT_STORAGE_PATH || '/data';
  const kbPath = path.join(storagePath, 'uploads', 'kb.json');
  console.log('Export kb from:', kbPath);
  if (!fs.existsSync(kbPath)) {
    return res.status(404).json({ error: 'Not found', path: kbPath });
  }
  const data = fs.readFileSync(kbPath, 'utf8');
  res.setHeader('Content-Type', 'application/json');
  res.send(data);
});

app.get('/api/admin/export/users', (req, res) => {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const storagePath = process.env.PERSISTENT_STORAGE_PATH || '/data';
  const usersPath = path.join(storagePath, 'uploads', 'users.json');
  console.log('Export users from:', usersPath);
  if (!fs.existsSync(usersPath)) {
    return res.status(404).json({ error: 'Not found', path: usersPath });
  }
  const data = fs.readFileSync(usersPath, 'utf8');
  res.setHeader('Content-Type', 'application/json');
  res.send(data);
});

// ── Password reset routes ─────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email required' });
    const { data: user } = await supabase.from('users').select('id,name,email').eq('email', email.toLowerCase().trim()).single();
    if (user) {
      const existing = RESET_REQUESTS.find(r => r.email === user.email && r.status === 'pending');
      if (!existing) {
        RESET_REQUESTS.unshift({ id: 'reset_' + Date.now(), userId: user.id, name: user.name, email: user.email, requestedAt: new Date().toISOString(), status: 'pending' });
        saveSetting('reset_requests', RESET_REQUESTS).catch(() => {});
      }
    }
    res.json({ success: true }); // always success — don't reveal if email exists
  } catch(e) { res.json({ success: true }); }
});

app.get('/api/admin/reset-requests', adminOnly, (_req, res) => {
  const sorted = [...RESET_REQUESTS].sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
  res.json(sorted);
});

app.post('/api/admin/reset-password', adminOnly, async (req, res) => {
  try {
    const { userId, newPassword, requestId } = req.body || {};
    if (!userId || !newPassword) return res.status(400).json({ error: 'userId and newPassword required' });
    const { data: user } = await supabase.from('users').select('id').eq('id', userId).single();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await supabase.from('users').update({ password_hash: passwordHash }).eq('id', userId);
    if (requestId) {
      const r = RESET_REQUESTS.find(r => r.id === requestId);
      if (r) { r.status = 'resolved'; r.resolvedAt = new Date().toISOString(); }
      saveSetting('reset_requests', RESET_REQUESTS).catch(() => {});
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/reset-requests/:id', adminOnly, async (req, res) => {
  const item = RESET_REQUESTS.find(r => r.id === req.params.id);
  if (item) { item.status = 'dismissed'; saveSetting('reset_requests', RESET_REQUESTS).catch(() => {}); }
  res.json({ ok: true });
});

// ── Settings routes ───────────────────────────────────────────
app.get('/api/settings', (_req, res) => res.json(SETTINGS));

app.post('/api/admin/settings', adminOnly, async (req, res) => {
  const { registrationOpen, mockBarPublic } = req.body || {};
  if (registrationOpen !== undefined) SETTINGS.registrationOpen = !!registrationOpen;
  if (mockBarPublic     !== undefined) SETTINGS.mockBarPublic    = !!mockBarPublic;
  await Promise.all([
    saveSetting('registration_open', SETTINGS.registrationOpen),
    saveSetting('mock_bar_public',   SETTINGS.mockBarPublic),
  ]);
  res.json(SETTINGS);
});

app.patch('/api/admin/settings', adminOnly, async (req, res) => {
  const { key, value } = req.body || {};
  if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });
  if (key === 'bar_exam_date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return res.status(400).json({ error: 'Invalid date format (YYYY-MM-DD)' });
    SETTINGS.barExamDate = value;
    await saveSetting('bar_exam_date', value);
    return res.json({ ok: true, barExamDate: value });
  }
  res.status(400).json({ error: `Unknown setting key: ${key}` });
});

// ── Results routes ────────────────────────────────────────────
app.post('/api/results/save', requireAuth, async (req, res) => {
  try {
    const { score, total, subject, questions, timeTakenMs, sessionType } = req.body || {};
    const questionCount = questions?.length || total || 0;
    if (score === undefined || !questionCount) return res.status(400).json({ error: 'score and total required' });
    // Normalise subject: strip display names, keep the subject key (e.g. "commercial" not "Mock Bar")
    const VALID_SUBJ_KEYS = ['civil','criminal','political','labor','commercial','taxation','remedial','ethics','custom'];
    const subjectKey = VALID_SUBJ_KEYS.includes(subject) ? subject : (subject || 'mixed');
    const id = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const maxPossible = questionCount * 10;
    const { error } = await supabase.from('results').insert([{
      id, user_id: req.userId, subject: subjectKey,
      score, total_questions: questionCount, passed: maxPossible > 0 && score / maxPossible >= 0.7,
      finished_at: new Date().toISOString(),
      questions: questions || [], answers: {}, evaluations: [], sources: [],
    }]);
    if (error) throw error;
    // Increment mock_bar_count on user
    const { data: uData } = await supabase.from('users').select('mock_bar_count').eq('id', req.userId).single();
    await supabase.from('users').update({ mock_bar_count: (uData?.mock_bar_count || 0) + 1 }).eq('id', req.userId);

    // ── Award XP ────────────────────────────────────────────────
    // mock_bar and speed_drill XP are deferred until evaluations complete
    // (awarded in /api/evaluate-batch completion handler after all evals succeed)
    let xpResult = null;
    try {
      const type = sessionType || 'mock_bar';
      if (type === 'review_session') {
        xpResult = await awardXP(
          req.userId,
          'COMPLETE_REVIEW_SESSION',
          'Completed Spaced Repetition Review Session',
          0
        );
      }
    } catch(xpErr) { console.error('[XP] results/save error:', xpErr); }

    res.json({ ok: true, id, xpResult });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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

function _mapResult(r) {
  return {
    ...r,
    userName:       r.users?.name  || r.user_id,
    userEmail:      r.users?.email || '',
    totalQuestions: r.total_questions,
    finishedAt:     r.finished_at,
    startedAt:      r.started_at   || null,
  };
}

app.get('/api/admin/results', adminOnly, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 20, 500);
    const offset = parseInt(req.query.offset) || 0;
    const { data, count, error } = await supabase.from('results')
      .select('*, users(id, name, email)', { count: 'exact' })
      .order('finished_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    res.json({ results: (data || []).map(_mapResult), total: count || 0, offset, limit });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/results/:userId', adminOnly, async (req, res) => {
  try {
    const { data } = await supabase.from('results')
      .select('*, users(id, name, email)')
      .eq('user_id', req.params.userId)
      .order('finished_at', { ascending: false });
    res.json((data || []).map(_mapResult));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── User: fetch own results for progress dashboard ───────────────
app.get('/api/user/results', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('results')
      .select('id, score, total_questions, subject, finished_at, passed')
      .eq('user_id', req.userId)
      .order('finished_at', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Spaced repetition: due reviews ────────────────────────────
app.get('/api/spaced-repetition/due', requireAuth, async (req, res) => {
  try {
    // Step 1: Get due spaced repetition records (no JOIN — no FK relationship)
    const { data: dueRecords, error: srError } = await supabase
      .from('spaced_repetition')
      .select('*')
      .eq('user_id', req.userId)
      .eq('mastered', false)
      .not('next_review_at', 'is', null)
      .lte('next_review_at', new Date().toISOString())
      .order('next_review_at', { ascending: true });
    if (srError) {
      console.error('[spaced-rep/due] SR query error:', srError.message);
      return res.json({ due: [], total: 0 });
    }
    if (!dueRecords || dueRecords.length === 0) return res.json([]);

    // Step 2: Fetch question details for each due record
    const questionIds = dueRecords.map(r => r.question_id).filter(Boolean);
    const { data: questions, error: qError } = await supabase
      .from('questions')
      .select('id, question_text, context, model_answer, key_points, subject, source, year, type, max_score, alternative_answers, model_answer_alac')
      .in('id', questionIds);
    if (qError) console.error('[spaced-rep/due] Questions query error:', qError.message);
    const qMap = {};
    for (const q of (questions || [])) qMap[q.id] = q;

    // Step 3: Merge and return
    const items = dueRecords.map(row => {
      const q = qMap[row.question_id] || {};
      const daysOverdue = row.next_review_at
        ? Math.max(0, Math.floor((Date.now() - new Date(row.next_review_at)) / 86400000))
        : 0;
      return {
        srId: row.id, questionId: row.question_id, subject: row.subject,
        lastScore: row.last_score, lastAttemptedAt: row.last_attempted_at,
        nextReviewAt: row.next_review_at, reviewCount: row.review_count, daysOverdue,
        question: {
          id: q.id, q: q.question_text || '', context: q.context || null,
          modelAnswer: q.model_answer || '', keyPoints: q.key_points || [],
          subject: row.subject, source: q.source || '', year: q.year || '',
          type: q.type || 'essay', max: q.max_score || 10,
          _cachedAlternatives: q.alternative_answers || null,
          _cachedAlac: q.model_answer_alac || null, isReal: true,
        },
      };
    });
    res.json(items);
  } catch(e) {
    console.error('[spaced-rep/due]', e);
    res.json({ due: [], total: 0 });
  }
});

// ── Spaced repetition: stats ──────────────────────────────────
app.get('/api/spaced-repetition/stats', requireAuth, async (req, res) => {
  try {
    const now      = new Date().toISOString();
    const weekLater = new Date(Date.now() + 7 * 86400000).toISOString();
    const { data, error } = await supabase
      .from('spaced_repetition')
      .select('mastered, next_review_at')
      .eq('user_id', req.userId);
    if (error) throw error;
    const rows = data || [];
    const total            = rows.length;
    const mastered         = rows.filter(r => r.mastered).length;
    const dueNow           = rows.filter(r => !r.mastered && r.next_review_at && r.next_review_at <= now).length;
    const upcomingThisWeek = rows.filter(r => !r.mastered && r.next_review_at && r.next_review_at > now && r.next_review_at <= weekLater).length;
    res.json({ total, mastered, dueNow, upcomingThisWeek });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: aggregated Improve items across all results ──────────
app.get('/api/admin/improve-items', adminOnly, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const { count: totalResults } = await supabase
      .from('results')
      .select('id', { count: 'exact', head: true });
    const { data, error } = await supabase
      .from('results')
      .select('id, subject, finished_at, questions, users(id, name, email)')
      .order('finished_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    const items = [];
    for (const row of data || []) {
      const studentName = row.users?.name || row.user_id || 'Unknown';
      const subject     = row.subject     || '';
      const date        = row.finished_at || '';
      for (const q of row.questions || []) {
        const improves = Array.isArray(q.improvements) ? q.improvements : [];
        const missed   = Array.isArray(q.keyMissed)    ? q.keyMissed    : [];
        if (improves.length || missed.length) {
          items.push({
            resultId:    row.id,
            studentName,
            subject,
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

app.delete('/api/admin/results/:resultId', adminOnly, async (req, res) => {
  try {
    const { error } = await supabase.from('results').delete().eq('id', req.params.resultId);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update an existing result record after a retry evaluation
app.patch('/api/results/:resultId', requireAuth, async (req, res) => {
  try {
    const { resultId } = req.params;
    const { score, questions, passed } = req.body || {};
    if (score === undefined) return res.status(400).json({ error: 'score required' });
    // Verify the record belongs to this user before updating
    const { data: existing, error: fetchErr } = await supabase
      .from('results').select('id, user_id').eq('id', resultId).single();
    if (fetchErr || !existing) return res.status(404).json({ error: 'Result not found' });
    if (existing.user_id !== req.userId) return res.status(403).json({ error: 'Forbidden' });
    const total = questions?.length || 0;
    const maxPossible = total * 10;
    const { error } = await supabase.from('results').update({
      score: parseFloat(score.toFixed ? score.toFixed(2) : score),
      passed: passed ?? (maxPossible > 0 && score / maxPossible >= 0.7),
      questions: questions || [],
      last_updated_at: new Date().toISOString(),
    }).eq('id', resultId);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) {
    console.error('[results/patch] Error:', e.message, e);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin questions CRUD ───────────────────────────────────────
app.get('/api/admin/questions', adminOnly, async (req, res) => {
  try {
    let query = supabase.from('questions').select('*', { count: 'exact' });
    if (req.query.subject) query = query.eq('subject', req.query.subject);
    if (req.query.year)    query = query.eq('year', req.query.year);
    if (req.query.type)    query = query.eq('type', req.query.type);
    if (req.query.q)       query = query.ilike('question_text', `%${req.query.q}%`);
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    query = query.range(offset, offset + limit - 1).order('subject').order('year');
    const { data, count, error } = await query;
    if (error) throw error;
    res.json({ questions: data || [], total: count });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/questions/:id', adminOnly, async (req, res) => {
  try {
    const { error } = await supabase.from('questions').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/questions/:id', adminOnly, async (req, res) => {
  try {
    const allowed = ['question_text','context','model_answer','key_points','type','subject','year','source','max_score'];
    const updates = {};
    for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
    // Cache bust — model_answer was edited by admin; force full regeneration on next evaluation
    if (updates.model_answer !== undefined) {
      updates.model_answer_alac   = null;
      updates.alternative_answers = null;
    }
    const { data, error } = await supabase
      .from('questions').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Pre-generate ALAC + alternatives cache for all questions ────────────
// Processes questions missing either cache column, sequentially with a 1s delay.
// Client polls GET /api/admin/backfill-alac-cache/status for live progress.
const backfillState = { running: false, done: 0, total: 0, errors: 0, complete: false };

app.get('/api/admin/backfill-alac-cache/status', adminOnly, (_req, res) => {
  res.json({ ...backfillState });
});

app.post('/api/admin/backfill-alac-cache', adminOnly, async (_req, res) => {
  if (backfillState.running) return res.json({ started: false, message: 'Backfill already in progress' });

  // Fetch all questions missing at least one cache column
  const { data, error } = await supabase
    .from('questions')
    .select('id, question_text, context, model_answer, subject, alternative_answers, model_answer_alac')
    .or('alternative_answers.is.null,model_answer_alac.is.null');
  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) return res.json({ started: false, message: 'All questions already cached' });

  Object.assign(backfillState, { running: true, done: 0, total: data.length, errors: 0, complete: false });
  res.json({ started: true, total: data.length });

  // Process sequentially in background — do NOT await
  (async () => {
    for (const q of data) {
      try {
        const cacheUpdate = {};

        // Alternatives
        if (!q.alternative_answers) {
          cacheUpdate.alternative_answers = extractAlternativeAnswers(q.model_answer);
        }

        // ALAC — only for questions without existing alternatives (single-answer questions)
        const alts = q.alternative_answers || cacheUpdate.alternative_answers || [];
        const hasManyAlts = Array.isArray(alts) && alts.length > 1;
        if (!q.model_answer_alac && !hasManyAlts && q.model_answer) {
          const alacResult = await generateALACModelAnswer(q.question_text, q.context, q.model_answer, q.subject);
          if (alacResult) cacheUpdate.model_answer_alac = alacResult.components;
        }

        if (Object.keys(cacheUpdate).length > 0) {
          const { error: ue } = await supabase.from('questions').update(cacheUpdate).eq('id', q.id);
          if (ue) { console.warn(`[backfill] update failed for ${q.id}:`, ue.message); backfillState.errors++; }
        }
      } catch (e) {
        console.warn(`[backfill] error on ${q.id}:`, e.message);
        backfillState.errors++;
      }
      backfillState.done++;
      await new Promise(r => setTimeout(r, 1000)); // 1s delay between questions
    }
    backfillState.running  = false;
    backfillState.complete = true;
    console.log(`[backfill] complete — ${backfillState.done} processed, ${backfillState.errors} errors`);
  })();
});

// ── Admin user-management routes ──────────────────────────────
app.get('/api/admin/users', adminOnly, async (_req, res) => {
  try {
    const { data } = await supabase.from('users').select('*').order('joined_at', { ascending: false });
    res.json((data || []).map(u => {
      const m = mapUser(u);
      return { id: m.id, name: m.name, email: m.email, role: m.role, isAdmin: m.isAdmin,
               active: m.active, status: m.status, createdAt: m.createdAt, registeredAt: m.registeredAt,
               school: m.school, stats: m.stats, tabSettings: m.tabSettings || null };
    }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users/:userId', adminOnly, async (req, res) => {
  try {
    const { active, isAdmin } = req.body || {};
    const updates = {};
    if (active  !== undefined) updates.is_active = !!active;
    if (isAdmin !== undefined) updates.is_admin  = !!isAdmin;
    const { error } = await supabase.from('users').update(updates).eq('id', req.params.userId);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users/:userId/role', adminOnly, async (req, res) => {
  try {
    const { isAdmin } = req.body || {};
    if (req.params.userId === req.userId && !isAdmin)
      return res.status(400).json({ error: 'Cannot remove your own admin access' });
    const { error } = await supabase.from('users').update({ is_admin: !!isAdmin }).eq('id', req.params.userId);
    if (error) throw error;
    res.json({ success: true, userId: req.params.userId, isAdmin: !!isAdmin });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:userId', adminOnly, async (req, res) => {
  try {
    await supabase.from('sessions').delete().eq('user_id', req.params.userId);
    const { error } = await supabase.from('users').delete().eq('id', req.params.userId);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

app.post('/api/admin/tab-settings', adminOnly, async (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'Invalid settings object' });
    TAB_SETTINGS = deepMerge(JSON.parse(JSON.stringify(DEFAULT_TAB_SETTINGS)), incoming);
    await saveSetting('tab_settings', TAB_SETTINGS);
    res.json({ success: true, settings: TAB_SETTINGS });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Per-user topic progress ──────────────────────────────────
app.get('/api/user/progress', requireAuth, (req, res) => {
  res.json({ progress: req.user.progress || {} });
});

// ── Exam session auto-save ────────────────────────────────────
app.post('/api/exam-session/save', requireAuth, async (req, res) => {
  try {
    const { session } = req.body || {};
    if (!session) return res.status(400).json({ error: 'No session data' });
    const savedAt = new Date().toISOString();
    const { error } = await supabase.from('users').update({
      active_exam_session: { ...session, userId: req.userId, lastSavedAt: savedAt }
    }).eq('id', req.userId);
    if (error) throw error;
    res.json({ success: true, savedAt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/exam-session/active', requireAuth, async (req, res) => {
  try {
    const { data } = await supabase.from('users').select('active_exam_session').eq('id', req.userId).single();
    const session = data?.active_exam_session;
    if (!session) return res.json({ session: null });
    const ageMs = Date.now() - new Date(session.lastSavedAt).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      await supabase.from('users').update({ active_exam_session: null }).eq('id', req.userId);
      return res.json({ session: null });
    }
    res.json({ session });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/exam-session/clear', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase.from('users').update({ active_exam_session: null }).eq('id', req.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/progress', requireAuth, async (req, res) => {
  try {
    const { subject, topicId, done } = req.body;
    if (!subject || !topicId) return res.status(400).json({ error: 'subject and topicId required' });
    const { data } = await supabase.from('users').select('progress').eq('id', req.userId).single();
    const progress = data?.progress || {};
    if (!progress[subject]) progress[subject] = {};
    if (done) progress[subject][topicId] = true;
    else delete progress[subject][topicId];
    const { error } = await supabase.from('users').update({ progress }).eq('id', req.userId);
    if (error) throw error;
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Bookmarks ─────────────────────────────────────────────────
app.get('/api/bookmarks', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bookmarks')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bookmarks', requireAuth, async (req, res) => {
  try {
    const { topicId, topicTitle, subject } = req.body;
    if (!topicId || !subject) return res.status(400).json({ error: 'topicId and subject required' });
    const id = 'bm_' + req.userId.slice(-8) + '_' + topicId.slice(0, 20).replace(/[^a-zA-Z0-9]/g, '_');
    const { data, error } = await supabase
      .from('bookmarks')
      .upsert(
        { id, user_id: req.userId, subject, topic_id: topicId, topic_title: topicTitle || topicId },
        { onConflict: 'user_id,topic_id' }
      )
      .select()
      .single();
    if (error) throw error;
    res.json({ bookmarked: true, bookmark: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/bookmarks/:topicId', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('bookmarks')
      .delete()
      .eq('user_id', req.userId)
      .eq('topic_id', req.params.topicId);
    if (error) throw error;
    res.json({ bookmarked: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords are required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const { data: userData } = await supabase.from('users').select('password_hash').eq('id', req.userId).single();
    if (!userData) return res.status(404).json({ error: 'User not found' });
    const valid = await bcrypt.compare(currentPassword, userData.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const newHash = await bcrypt.hash(newPassword, 10);
    const { error } = await supabase.from('users').update({ password_hash: newHash }).eq('id', req.userId);
    if (error) throw error;
    res.json({ success: true, message: 'Password changed successfully' });
  } catch(e) {
    console.error('Change password error:', e.message);
    res.status(500).json({ error: 'Failed to change password' });
  }
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

app.get('/api/admin/users/:userId/tab-settings', adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('tab_settings').eq('id', req.params.userId).single();
    if (error || !data) return res.status(404).json({ error: 'User not found' });
    res.json({ tabSettings: data.tab_settings || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/users/:userId/tab-settings', adminOnly, async (req, res) => {
  try {
    const { error } = await supabase.from('users').update({ tab_settings: req.body.tabSettings || null }).eq('id', req.params.userId);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:userId/tab-settings', adminOnly, async (req, res) => {
  try {
    const { error } = await supabase.from('users').update({ tab_settings: null }).eq('id', req.params.userId);
    if (error) throw error;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
app.get('/api/syllabus/pdf/:nodeId', async (req, res) => {
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

app.get('/api/syllabus', authOrAdmin, (req, res) => {
  res.json({ subjects: KB.syllabus?.subjects || {} });
});

app.get('/api/syllabus/:subject', authOrAdmin, (req, res) => {
  const subj = req.params.subject;
  if (!getAllSubjectsWithSections().includes(subj)) return res.status(400).json({ error: 'Invalid subject' });
  res.json(KB.syllabus?.subjects?.[subj] || { sections: [] });
});

// ── SYLLABUS: Admin write routes ──────────────────────────────
app.post('/api/admin/syllabus/:subject/section', adminOnly, async (req, res) => {
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

app.post('/api/admin/syllabus/:subject/node', adminOnly, async (req, res) => {
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

app.patch('/api/admin/syllabus/:subject/node/:nodeId', adminOnly, async (req, res) => {
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

app.delete('/api/admin/syllabus/:subject/node/:nodeId', adminOnly, async (req, res) => {
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

app.post('/api/admin/syllabus/:subject/node/:nodeId/pdf', adminOnly, (req, res) => {
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

app.delete('/api/admin/syllabus/:subject/node/:nodeId/pdf', adminOnly, async (req, res) => {
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

app.post('/api/admin/syllabus/:subject/reorder', adminOnly, async (req, res) => {
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

// ── ADMIN: Upload Reference — save instantly, summarise in background ──
app.post('/api/admin/reference', adminOnly, async (req, res) => {
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

// ── ADMIN: Upload Past Bar — save instantly, extract via job queue ──
app.post('/api/admin/pastbar', adminOnly, async (req, res) => {
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

// ── ADMIN: Toggle past-bar batch enabled/disabled ────────────
app.patch('/api/admin/pastbar/:id/toggle', adminOnly, async (req, res) => {
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

// ── ADMIN: KB Diagnostic ─────────────────────────────────────
app.get('/api/admin/debug/kb', adminOnly, async (_req, res) => {
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

// ── ADMIN: Storage info ──────────────────────────────────────
app.get('/api/storage-info', adminOnly, (_, res) => {
  res.json({
    persistent: !!process.env.PERSISTENT_STORAGE_PATH,
    storageDir: UPLOADS_DIR,
    envVar: process.env.PERSISTENT_STORAGE_PATH || null,
    source: 'supabase',
  });
});

// ── ADMIN: Delete ───────────────────────────────────────────
app.delete('/api/admin/reference/:id', adminOnly, async (req, res) => {
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
app.delete('/api/admin/syllabus', adminOnly, async (req, res) => {
  try {
    KB.syllabus = { subjects: {} };
    getAllSubjectsWithSections().forEach(s => { KB.syllabus.subjects[s] = { sections: [] }; });
    CONTENT = {};
    await Promise.all(getAllSubjectsWithSections().map(s => saveSyllabusSubject(s, [])));
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/admin/content', adminOnly, (req, res) => {
  CONTENT = {}; res.json({ success:true });
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
app.post('/api/mockbar/generate', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error:'API key not set' });
  const { subjects, count=20, sources, includePreGen, aiGenerate, topics, difficulty } = req.body;
  console.log(`[mockbar] requested: ${count} questions, subjects: ${JSON.stringify(subjects)}`);
  // Merge explicit top-level aiGenerate flag into sources object (new UI sends it at top level)
  const mergedSources = aiGenerate !== undefined ? { ...sources, aiGenerate } : sources;
  try {
    const result = await generateMockBar(subjects, count, { sources: mergedSources, includePreGen: includePreGen ?? null, topics, difficulty });
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
//   'situational' → fact pattern present or situational keywords → ALAC scoring
//   'conceptual'  → all other questions → Accuracy/Completeness/Clarity scoring
function detectQuestionType(questionText, context, modelAnswer) {
  const q   = (questionText || '').toLowerCase().trim();
  const ctx = (context      || '').toLowerCase().trim();
  const ans = (modelAnswer  || '').toLowerCase();

  // ── Situational — context (fact pattern) is the strongest signal ──
  const hasFacts       = ctx.length > 80;
  const hasCaseParties = /filed|sued|plaintiff|defendant|petitioner|respondent|labor arbiter|nlrc|\brtc\b|\bca\b|supreme court/i.test(ctx);
  if (hasFacts || hasCaseParties) return 'situational';

  // ── Situational keywords in question text ──
  const situationalKw = ['rule on', 'decide', 'resolve', 'is he liable', 'is she liable',
    'is it valid', 'is the contract', 'may he', 'may she', 'can he', 'what crime',
    'what offense', 'the facts show', 'in the case', 'plaintiff', 'defendant',
    'accused', 'complainant'];
  if (situationalKw.some(kw => q.includes(kw))) return 'situational';

  // ── Model answer ALAC signal ──
  const hasALAC  = /(answer:|legal basis:|application:|conclusion:)/i.test(ans);
  const ansWords = ans.split(/\s+/).filter(w => w.length > 0).length;
  if (hasALAC && ansWords > 100) return 'situational';

  return 'conceptual'; // default — conceptual/theoretical questions
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
  const { question, answer, modelAnswer, keyPoints, subject, context, forceType, questionId } = req.body;
  const refCtx = KB.references.filter(r=>r.subject===subject).slice(0,1).map(r=>r.summary||'').join('');
  const qtype = forceType || detectQuestionType(question, context, modelAnswer);
  const isSituational = qtype === 'situational' || qtype === 'essay' || qtype === 'alac';
  console.log(`[evaluate] type=${qtype} q="${(question||'').slice(0,60)}"`);

  // ── Cache lookup (alternatives + ALAC) ────────────────────
  let _cachedAlternatives = null;
  let _cachedAlac         = null;
  let _needsAltCache      = false;
  let _needsAlacCache     = false;
  if (questionId) {
    const { data: qCache } = await supabase
      .from('questions')
      .select('alternative_answers, model_answer_alac')
      .eq('id', questionId)
      .single();
    _cachedAlternatives = qCache?.alternative_answers || null;
    _cachedAlac         = qCache?.model_answer_alac   || null;
  }

  // ── Alternative answer detection ──────────────────────────
  const alternatives    = _cachedAlternatives || ((_needsAltCache = true), extractAlternativeAnswers(modelAnswer));
  const hasAlternatives = alternatives.length > 1;
  const maSection = hasAlternatives
    ? `SUGGESTED ANSWER HAS ${alternatives.length} VALID ALTERNATIVES — evaluate the student against whichever they most closely answered. Return "matchedAlternative" as the number (1, 2, …) of the best-matching alternative. A student who correctly answers any valid alternative deserves full credit for that approach.\n\n${alternatives.map((a, i) => `ALTERNATIVE ${i + 1}:\n${a}`).join('\n\n')}`
    : (modelAnswer ? `Reference Answer: ${modelAnswer}` : '');

  let prompt, maxTok;

  if (isSituational) {
    // ── ALAC evaluation (situational / essay) ─────────────────
    maxTok = 3000;
    prompt = `You are a Philippine Bar Exam examiner. Evaluate this student answer using the ALAC method (Answer, Legal Basis, Application, Conclusion) which is the standard format required in the Philippine Bar Exam.
Keep overallFeedback under 200 words. Keep each ALAC component feedback under 50 words. Be concise and direct.
CRITICAL JSON OUTPUT RULES: Use single quotes inside all string values (never double quotes inside strings). No newlines inside string values. No trailing commas. Keep all feedback values on a single line.

Question: ${question}
${maSection}
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

In your JSON response, all string values must use single quotes for any internal quotation. Example: use 'the court held' not "the court held". Keep each feedback field to one line.
Respond ONLY with valid JSON (no markdown):
{
  "score": "X/10", "numericScore": 7, "grade": "Excellent|Good|Satisfactory|Needs Improvement|Poor",
  "matchedAlternative": 1,
  "alac": {
    "answer":      { "score": 1.2, "max": 1.5, "feedback": "...", "studentDid": "..." },
    "legalBasis":  { "score": 2.5, "max": 3.0, "feedback": "...", "studentDid": "..." },
    "application": { "score": 2.8, "max": 4.0, "feedback": "...", "studentDid": "..." },
    "conclusion":  { "score": 1.2, "max": 1.5, "feedback": "...", "studentDid": "..." }
  },
  "overallFeedback": "2-3 sentence overall assessment under 200 words",
  "strengths": ["..."],
  "improvements": ["..."],
  "keyMissed": ["specific law or case they should have cited"],
  "format": "essay"
}`;
  } else {
    // ── Conceptual evaluation ─────────────────────────────────
    maxTok = 2500;
    prompt = `You are a Philippine Bar Exam examiner. Evaluate this conceptual/theoretical answer.
Keep overallFeedback under 100 words and each component feedback under 50 words. Be concise and direct.
CRITICAL JSON OUTPUT RULES: Use single quotes inside all string values (never double quotes inside strings). No newlines inside string values. No trailing commas. Keep all feedback values on a single line.

Question: ${question}
${maSection}
${(keyPoints||[]).length?`Key Points: ${keyPoints.join(', ')}`:''}
Student Answer: ${answer}

Score out of 10 using these components:
  Accuracy     (4 pts): Is the answer legally correct and on-point?
  Completeness (3 pts): Are all essential elements or points included?
  Clarity      (3 pts): Is it stated clearly and precisely in legal language?

${GRADE_SCALE}

In your JSON response, all string values must use single quotes for any internal quotation. Example: use 'the court held' not "the court held". Keep each feedback field to one line.
Respond ONLY with valid JSON (no markdown):
{
  "score": "X/10", "numericScore": 0, "grade": "Excellent|Good|Satisfactory|Needs Improvement|Poor",
  "matchedAlternative": 1,
  "breakdown": {
    "accuracy":     { "score": 0.0, "max": 4, "feedback": "under 50 words" },
    "completeness": { "score": 0.0, "max": 3, "feedback": "under 50 words" },
    "clarity":      { "score": 0.0, "max": 3, "feedback": "under 50 words" }
  },
  "overallFeedback": "Brief assessment under 100 words",
  "keyMissed": ["key element the student missed"],
  "format": "conceptual"
}`;
  }

  try {
    const result = await callClaudeJSON([{ role:'user', content: prompt }], maxTok);
    if (!result) {
      console.error(`[evaluate] callClaudeJSON returned null (all JSON parse retries exhausted). qtype=${qtype} answerLen=${answer?.length}`);
      return res.status(422).json({ error:'Evaluation failed — could not parse scoring response. Please try submitting your answer again.' });
    }
    result.format       = qtype;
    result.questionType = qtype;
    if (!result.keyPoints?.length && keyPoints?.length) result.keyPoints = keyPoints;

    // ── Apply matched alternative ──────────────────────────────
    if (hasAlternatives) {
      const idx = Math.max(0, Math.min((result.matchedAlternative || 1) - 1, alternatives.length - 1));
      result.modelAnswer              = alternatives[idx];
      result.modelAnswerOriginal      = modelAnswer;
      result.usedAlternative          = true;
      result.matchedAlternativeNumber = idx + 1;
      console.log(`[evaluate] alt ${idx + 1}/${alternatives.length} selected for scoring`);
    } else {
      if (!result.modelAnswer && modelAnswer) result.modelAnswer = modelAnswer;
      result.usedAlternative = false;
    }

    // Generate structured ALAC model answer for situational questions
    if (isSituational && result.modelAnswer) {
      // Use cached ALAC only for single-answer questions (multi-alternative ALAC varies per match)
      if (_cachedAlac && !hasAlternatives) {
        result.alacModelAnswer      = _cachedAlac;
        result.modelAnswerFormatted = [
          `ANSWER: ${_cachedAlac.answer}`,
          `LEGAL BASIS: ${_cachedAlac.legalBasis}`,
          `APPLICATION: ${_cachedAlac.application}`,
          `CONCLUSION: ${_cachedAlac.conclusion}`,
        ].filter(s => !s.match(/:\s*$/)).join('\n\n');
        result.modelAnswer = result.modelAnswerFormatted;
      } else {
        const alacResult = await generateALACModelAnswer(question, context, result.modelAnswer, subject);
        if (alacResult) {
          result.alacModelAnswer      = alacResult.components;
          result.modelAnswerFormatted = alacResult.formatted;
          result.modelAnswer          = alacResult.formatted;
          if (!hasAlternatives) _needsAlacCache = true;
        }
      }
    }

    // ── Write cache to Supabase (fire-and-forget) ─────────────
    if (questionId && (_needsAltCache || _needsAlacCache)) {
      const cacheUpdate = {};
      if (_needsAltCache)  cacheUpdate.alternative_answers = alternatives;
      if (_needsAlacCache) cacheUpdate.model_answer_alac   = result.alacModelAnswer;
      supabase.from('questions').update(cacheUpdate).eq('id', questionId)
        .then(({ error: ce }) => { if (ce) console.warn('[cache-write] /api/evaluate failed:', ce.message); });
    }

    res.json(result);
  } catch(err) {
    console.error(`[evaluate] threw: ${err.message} (${err.name}) qtype=${qtype} answerLen=${answer?.length}`);
    res.status(500).json({ error:err.message });
  }
});

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

// ── callClaudeHaikuJSON — haiku-only, semaphore-guarded, for fast batch eval ─
async function callClaudeHaikuJSON(prompt, maxTokens = 400) {
  await aiSemaphore.acquire();
  const JSON_SYSTEM = 'You are a JSON API endpoint. Output ONLY valid JSON. STRICT RULES: (1) Use single quotes inside string values — NEVER double quotes inside strings. (2) No literal newlines inside string values — use \\n if needed. (3) No trailing commas anywhere. (4) Response must start with { and end with }. (5) No markdown, no code fences, no backticks, no explanations. (6) If feedback contains quotes, use single quotes instead.';
  const JSON_SUFFIX = '\n\nCRITICAL: Return ONLY raw JSON. No markdown. No backticks. No fences. Start with { and end with }. Use single quotes inside string values (never double quotes inside strings). No trailing commas. No line breaks inside string values.';
  try {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
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
      if (d.stop_reason === 'max_tokens') console.warn('[callClaudeHaikuJSON] Response truncated! Used:', d.usage?.output_tokens, 'tokens. Increase maxTokens.');
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

// ── Global evaluation queue ────────────────────────────────────────────────────
// Handles 30+ concurrent users fairly: FIFO across users, per-user concurrency cap,
// interleaved so every user gets partial results quickly.
const EvalQueue = {
  queue: [],              // [{ submissionId, userId, item, idx, resolve, reject, enqueuedAt }]
  activeCount: 0,         // currently running API calls
  maxConcurrent: 20,      // matches semaphore — safe for Haiku at scale
  perUserActive: new Map(), // userId → currently-running count for that user
  perUserMax: 5,          // fairness cap: one user can't monopolise all 20 slots
  evalTimeSamples: [],    // rolling window of completed eval durations (ms)
  totalProcessed: 0,
  get avgEvalTimeMs() {
    if (!this.evalTimeSamples.length) return 3000;
    return Math.round(this.evalTimeSamples.reduce((a, b) => a + b, 0) / this.evalTimeSamples.length);
  },
  recordTime(ms) {
    this.evalTimeSamples.push(ms);
    if (this.evalTimeSamples.length > 200) this.evalTimeSamples.shift();
  },
};

// Start as many queued jobs as global + per-user limits allow.
// Safe to call multiple times — JavaScript is single-threaded so the while-loop
// is atomic with respect to the async jobs it launches.
function processEvalQueue() {
  while (EvalQueue.activeCount < EvalQueue.maxConcurrent && EvalQueue.queue.length > 0) {
    // Find the first job whose user is under their per-user cap (FIFO within that constraint)
    const jobIdx = EvalQueue.queue.findIndex(j => {
      return (EvalQueue.perUserActive.get(j.userId) || 0) < EvalQueue.perUserMax;
    });
    if (jobIdx === -1) break; // every remaining job belongs to a user at their cap

    const [job] = EvalQueue.queue.splice(jobIdx, 1);
    EvalQueue.activeCount++;
    EvalQueue.perUserActive.set(job.userId, (EvalQueue.perUserActive.get(job.userId) || 0) + 1);

    const startMs = Date.now();
    runEvalJob(job)
      .then(result => job.resolve(result))
      .catch(err   => job.reject(err))
      .finally(() => {
        EvalQueue.activeCount--;
        EvalQueue.perUserActive.set(job.userId, Math.max(0, (EvalQueue.perUserActive.get(job.userId) || 1) - 1));
        EvalQueue.recordTime(Date.now() - startMs);
        EvalQueue.totalProcessed++;
        processEvalQueue(); // unblock next eligible job
      });
  }
}

// Push one evaluation onto the global queue; returns a Promise that resolves with the score.
function enqueueEval(submissionId, userId, item, idx) {
  return new Promise((resolve, reject) => {
    EvalQueue.queue.push({ submissionId, userId, item, idx, resolve, reject, enqueuedAt: Date.now() });
    processEvalQueue();
  });
}

// Core per-question evaluation — called by processEvalQueue, never directly.
async function runEvalJob(job) {
  const { submissionId, item, idx } = job;
  const { question, answer, context, modelAnswer, keyPoints, subject } = item;
  // Cache fields injected by mapQRow (or by evaluate-batch client payload if present)
  const questionId        = item.id || null;
  let   _cachedAlac       = item._cachedAlac        || null;
  let   _needsAltCache    = false;
  let   _needsAlacCache   = false;

  if (!answer || !answer.trim()) {
    const prog = evalProgress.get(submissionId);
    if (prog) { prog.done++; }  // complete set only after evalResults.set() in .then()
    return { score: '0/10', numericScore: 0, grade: 'Not Answered', overallFeedback: 'No answer provided.', keyMissed: [] };
  }

  // Hoist qtype so the catch block can log it even if it's set inside try
  let qtype = 'unknown';
  try {
    const refCtx = KB.references.filter(r => r.subject === subject).slice(0, 1).map(r => r.summary || '').join('');
    qtype = detectQuestionType(question, context, modelAnswer);
    const isSit = qtype === 'situational' || qtype === 'essay' || qtype === 'alac';

    const alternatives    = item._cachedAlternatives || ((_needsAltCache = true), extractAlternativeAnswers(modelAnswer));
    const hasAlternatives = alternatives.length > 1;
    const maSection = hasAlternatives
      ? `SUGGESTED ANSWER HAS ${alternatives.length} VALID ALTERNATIVES — evaluate the student against whichever they most closely answered. Return "matchedAlternative" as the number (1, 2, …) of the best-matching alternative.\n\n${alternatives.map((a, i) => `ALTERNATIVE ${i + 1}:\n${a}`).join('\n\n')}`
      : (modelAnswer ? `Reference Answer: ${modelAnswer}` : '');

    let prompt, maxTok;

    if (isSit) {
      maxTok = 2500;
      prompt = `You are a Philippine Bar Exam examiner. Evaluate using ALAC (Answer 1.5pts, Legal Basis 3pts, Application 4pts, Conclusion 1.5pts). Keep overallFeedback under 200 words and each component feedback under 50 words.
CRITICAL JSON OUTPUT RULES: Use single quotes inside all string values (never double quotes inside strings). No newlines inside string values. No trailing commas. Keep all feedback fields on a single line.
IMPORTANT: Return pure JSON only. Never include { or } characters inside any string value. Write all feedback as plain text sentences only. No code examples, no nested structures, no special characters inside strings.
Question: ${question}
${maSection}
${(keyPoints || []).length ? `Key Points: ${keyPoints.join(', ')}` : ''}
${refCtx ? `Legal Context: ${refCtx.slice(0, 400)}` : ''}
Student Answer: ${answer}
${GRADE_SCALE}
Respond ONLY with valid JSON: {"score":"X/10","numericScore":0,"grade":"...","alac":{"answer":{"score":0,"max":1.5,"feedback":"under 50 words","studentDid":""},"legalBasis":{"score":0,"max":3,"feedback":"under 50 words","studentDid":""},"application":{"score":0,"max":4,"feedback":"under 50 words","studentDid":""},"conclusion":{"score":0,"max":1.5,"feedback":"under 50 words","studentDid":""}},"overallFeedback":"under 200 words","strengths":[],"improvements":[],"keyMissed":[],"matchedAlternative":1,"format":"essay"}`;
    } else {
      maxTok = 2500;
      prompt = `You are a Philippine Bar Exam examiner. Evaluate this conceptual/theoretical answer. Keep overallFeedback under 100 words and each component feedback under 50 words.
CRITICAL JSON OUTPUT RULES: Use single quotes inside all string values (never double quotes inside strings). No newlines inside string values. No trailing commas. Keep all feedback fields on a single line.
IMPORTANT: Return pure JSON only. Never include { or } characters inside any string value. Write all feedback as plain text sentences only. No code examples, no nested structures, no special characters inside strings.
Question: ${question}
${maSection}
${(keyPoints || []).length ? `Key Points: ${keyPoints.join(', ')}` : ''}
Student Answer: ${answer}
Score: Accuracy(4pts) + Completeness(3pts) + Clarity(3pts) = 10.
${GRADE_SCALE}
Respond ONLY with valid JSON: {"score":"X/10","numericScore":0,"grade":"...","breakdown":{"accuracy":{"score":0,"max":4,"feedback":"under 50 words"},"completeness":{"score":0,"max":3,"feedback":"under 50 words"},"clarity":{"score":0,"max":3,"feedback":"under 50 words"}},"overallFeedback":"under 100 words","keyMissed":[],"matchedAlternative":1,"format":"conceptual"}`;
    }

    const result = await callClaudeHaikuJSON(prompt, maxTok);
    if (result) {
      result.format       = qtype;
      result.questionType = qtype;
      if (!result.keyPoints?.length && keyPoints?.length) result.keyPoints = keyPoints;

      if (hasAlternatives) {
        const altIdx = Math.max(0, Math.min((result.matchedAlternative || 1) - 1, alternatives.length - 1));
        result.modelAnswer              = alternatives[altIdx];
        result.modelAnswerOriginal      = modelAnswer;
        result.usedAlternative          = true;
        result.matchedAlternativeNumber = altIdx + 1;
      } else {
        if (!result.modelAnswer && modelAnswer) result.modelAnswer = modelAnswer;
        result.usedAlternative = false;
      }

      if (isSit && result.modelAnswer) {
        // Use cached ALAC only for single-answer questions (multi-alternative ALAC varies per match)
        if (_cachedAlac && !hasAlternatives) {
          result.alacModelAnswer      = _cachedAlac;
          result.modelAnswerFormatted = [
            `ANSWER: ${_cachedAlac.answer}`,
            `LEGAL BASIS: ${_cachedAlac.legalBasis}`,
            `APPLICATION: ${_cachedAlac.application}`,
            `CONCLUSION: ${_cachedAlac.conclusion}`,
          ].filter(s => !s.match(/:\s*$/)).join('\n\n');
          result.modelAnswer = result.modelAnswerFormatted;
        } else {
          const alacResult = await generateALACModelAnswer(question, context, result.modelAnswer, subject);
          if (alacResult) {
            result.alacModelAnswer      = alacResult.components;
            result.modelAnswerFormatted = alacResult.formatted;
            result.modelAnswer          = alacResult.formatted;
            if (!hasAlternatives) _needsAlacCache = true;
          }
        }
      }

      // ── Write cache to Supabase (fire-and-forget) ───────────
      if (questionId && (_needsAltCache || _needsAlacCache)) {
        const cacheUpdate = {};
        if (_needsAltCache)  cacheUpdate.alternative_answers = alternatives;
        if (_needsAlacCache) cacheUpdate.model_answer_alac   = result.alacModelAnswer;
        supabase.from('questions').update(cacheUpdate).eq('id', questionId)
          .then(({ error: ce }) => { if (ce) console.warn(`[cache-write] Q${idx + 1} failed:`, ce.message); });
      }

      // ── Spaced repetition upsert (fire-and-forget) ───────────
      if (questionId && job.userId && !result._evalError) {
        const al = result.alac || {};
        const srScore = (al.answer?.score != null)
          ? Number(((al.answer.score||0)+(al.legalBasis?.score||0)+(al.application?.score||0)+(al.conclusion?.score||0)).toFixed(2))
          : (result.numericScore || 0);
        const reviewDays = srScore < 5 ? 3 : srScore < 7 ? 7 : srScore < 8 ? 14 : null;
        const mastered   = srScore >= 8;
        const nextReviewAt = reviewDays ? new Date(Date.now() + reviewDays * 86400000).toISOString() : null;
        const srId = `sr_${job.userId}_${questionId}`;
        supabase.from('spaced_repetition').select('review_count, mastered').eq('id', srId).single()
          .then(({ data: ex }) => {
            const wasAlreadyMastered = ex?.mastered || false;
            return supabase.from('spaced_repetition').upsert({
              id: srId, user_id: job.userId, question_id: questionId, subject,
              last_score: srScore, last_attempted_at: new Date().toISOString(),
              next_review_at: nextReviewAt, review_count: (ex?.review_count || 0) + 1, mastered,
            }, { onConflict: 'user_id,question_id' })
              .then(({ error: e }) => {
                if (e) { console.warn('[sr-upsert]', e.message); return; }
                // Award XP the first time a question is mastered
                if (mastered && !wasAlreadyMastered) {
                  awardXP(job.userId, 'MASTER_SPACED_REP', `Mastered question: ${questionId}`).catch(() => {});
                }
              });
          })
          .catch(e => console.warn('[sr-upsert]', e.message));
      }
    }

    if (!result) {
      console.error(`[evaluate-batch] Q${idx + 1} failed: callClaudeHaikuJSON returned null (all JSON parse retries exhausted). qtype=${qtype} answerLen=${answer?.length}`);
    }
    return result || { score: '0/10', numericScore: 0, grade: 'Error', overallFeedback: 'Evaluation failed — please retry.', keyMissed: [], _evalError: true };
  } catch (e) {
    console.error(`[evaluate-batch] Q${idx + 1} threw: ${e.message} (${e.name}) qtype=${qtype} answerLen=${answer?.length}`);
    return { score: '0/10', numericScore: 0, grade: 'Error', overallFeedback: 'Evaluation temporarily unavailable.', keyMissed: [], _evalError: true };
  } finally {
    const prog = evalProgress.get(submissionId);
    // Increment done counter. Do NOT set complete here — complete is set only after
    // evalResults.set() in the Promise.all .then() handler to close the race window.
    if (prog) { prog.done++; }
  }
}

// ── EVAL PROGRESS polling (enhanced with queue info) ──────────
app.get('/api/eval-progress/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const progress = evalProgress.get(id) || { total: 0, done: 0, complete: false };
  const thisQueued  = EvalQueue.queue.filter(j => j.submissionId === id).length;
  const otherQueued = EvalQueue.queue.length - thisQueued;
  const estimatedWaitSec = thisQueued > 0
    ? Math.ceil((thisQueued * EvalQueue.avgEvalTimeMs) / (EvalQueue.maxConcurrent * 1000))
    : 0;
  res.json({
    ...progress,
    queuePosition:    Math.max(0, otherQueued),
    estimatedWaitSec,
    semaphoreActive:  EvalQueue.activeCount,
  });
});

// ── EVAL QUEUE STATUS — SSE for real-time queue position ───────
app.get('/api/eval-queue-status/:submissionId', requireAuth, (req, res) => {
  const { submissionId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  function sendUpdate() {
    const prog = evalProgress.get(submissionId);
    if (!prog) {
      res.write(`data: ${JSON.stringify({ error: 'submission not found' })}\n\n`);
      return true; // done — close stream
    }
    const thisQueued  = EvalQueue.queue.filter(j => j.submissionId === submissionId).length;
    const otherQueued = EvalQueue.queue.length - thisQueued;
    const estimatedSecondsRemaining = thisQueued > 0
      ? Math.ceil((thisQueued * EvalQueue.avgEvalTimeMs) / (EvalQueue.maxConcurrent * 1000))
      : 0;
    res.write(`data: ${JSON.stringify({
      position: otherQueued,
      done: prog.done,
      total: prog.total,
      estimatedSecondsRemaining,
      semaphoreActive: EvalQueue.activeCount,
      complete: prog.complete,
    })}\n\n`);
    return prog.complete;
  }

  if (sendUpdate()) { res.end(); return; }
  const interval = setInterval(() => {
    if (sendUpdate()) { clearInterval(interval); res.end(); }
  }, 2000);
  req.on('close', () => clearInterval(interval));
});

// ── EVALUATE BATCH — fire-and-forget; client polls for progress ─
app.post('/api/evaluate-batch', requireAuth, async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'API key not set' });
  const { questions, submissionId: clientId, resultId, sessionType, subject } = req.body;
  if (!Array.isArray(questions) || !questions.length)
    return res.status(400).json({ error: 'questions array required' });

  const submissionId = (clientId && /^[a-zA-Z0-9_-]{5,50}$/.test(clientId))
    ? clientId
    : 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  evalProgress.set(submissionId, { total: questions.length, done: 0, complete: false });

  // Capture before res.json() releases the HTTP connection
  const userId = req.userId;

  // Return immediately — HTTP connection released, client polls /api/eval-progress/:id
  res.json({ submissionId, total: questions.length });

  // Run evaluations in the background; store results when all finish
  Promise.all(questions.map((q, i) => enqueueEval(submissionId, userId, q, i)))
    .then(async scores => {
      evalResults.set(submissionId, scores);
      // evalProgress.complete is already set true by the last runEvalJob finally-block,
      // but we set it again here as a safety net in case of any race.
      const prog = evalProgress.get(submissionId);
      if (prog) prog.complete = true;
      // Clean up all maps after 10 minutes
      setTimeout(() => { evalProgress.delete(submissionId); evalResults.delete(submissionId); xpResults.delete(submissionId); }, 10 * 60 * 1000);

      // ── Post-eval: update result record + award XP ───────────
      // review_session XP is awarded at save time; skip here
      if (!resultId || !sessionType || sessionType === 'review_session') return;
      try {
        const totalQuestions = scores.length;
        const successfulEvals = scores.filter(s => !s._evalError && s.grade !== 'Error').length;

        // Compute final total score from actual evaluated components
        const computedTotal = scores.reduce((sum, s) => {
          if (s._evalError || s.grade === 'Error') return sum;
          if (s.alac) {
            return sum + (s.alac.answer?.score || 0) + (s.alac.legalBasis?.score || 0)
                       + (s.alac.application?.score || 0) + (s.alac.conclusion?.score || 0);
          }
          return sum + (s.numericScore || 0);
        }, 0);

        // Update result record with final evaluated scores
        const { error: updateErr } = await supabase.from('results').update({
          evaluations: scores,
          score: parseFloat(computedTotal.toFixed(2)),
          passed: totalQuestions > 0 && computedTotal / (totalQuestions * 10) >= 0.7,
          last_updated_at: new Date().toISOString(),
        }).eq('id', resultId);
        if (updateErr) console.error('[evaluate-batch] result update error:', updateErr.message);

        // Award XP only if >= 80% of questions evaluated successfully
        const evalSuccessRate = successfulEvals / totalQuestions;
        if (evalSuccessRate < 0.8) {
          console.log(`[xp] Skipped — only ${successfulEvals}/${totalQuestions} questions evaluated successfully`);
          return;
        }

        const VALID_SUBJ_KEYS = ['civil','criminal','political','labor','commercial','taxation','remedial','ethics','custom'];
        const subjectKey = VALID_SUBJ_KEYS.includes(subject) ? subject : (subject || 'mixed');

        const highScoreCount = scores.filter(s => {
          if (s._evalError || s.grade === 'Error') return false;
          const qScore = s.alac
            ? (s.alac.answer?.score || 0) + (s.alac.legalBasis?.score || 0)
              + (s.alac.application?.score || 0) + (s.alac.conclusion?.score || 0)
            : (s.numericScore || 0);
          return qScore >= 8.0;
        }).length;
        const bonusXP = highScoreCount * XP_VALUES.HIGH_SCORE_BONUS;

        let xpData = null;
        if (sessionType === 'speed_drill') {
          xpData = await awardXP(userId, 'COMPLETE_SPEED_DRILL', `Completed Speed Drill — ${subjectKey}`, bonusXP);
        } else {
          const isFullSession = totalQuestions === 20;
          const baseXP = isFullSession
            ? XP_VALUES.MOCK_BAR_FULL_BONUS
            : totalQuestions * XP_VALUES.MOCK_BAR_PER_QUESTION;
          xpData = await awardXP(
            userId,
            isFullSession ? 'MOCK_BAR_FULL' : 'MOCK_BAR_PARTIAL',
            `Completed Mock Bar — ${subjectKey} (${totalQuestions} question${totalQuestions !== 1 ? 's' : ''})`,
            baseXP + bonusXP
          );
        }
        if (xpData) {
          xpData.highScoreCount = highScoreCount;
          xpData.highScoreBonus = bonusXP;
          xpResults.set(submissionId, xpData);
        }
      } catch (xpErr) {
        console.error('[xp] evaluate-batch completion error:', xpErr.message);
      }
    })
    .catch(err => {
      console.error('[evaluate-batch] background error:', err.message);
      evalProgress.delete(submissionId);
      evalResults.delete(submissionId);
    });
});

// ── FETCH COMPLETED RESULTS — called by client once polling sees complete:true ─
app.get('/api/eval-results/:submissionId', requireAuth, (req, res) => {
  const { submissionId } = req.params;
  const prog = evalProgress.get(submissionId);
  if (!prog) return res.status(404).json({ error: 'Submission not found or expired' });
  // Guard against the brief window where complete=true but evalResults isn't stored yet
  if (!prog.complete || !evalResults.has(submissionId)) {
    return res.status(202).json({ complete: false, waiting: true, done: prog.done, total: prog.total });
  }
  res.json({ complete: true, scores: evalResults.get(submissionId), xpData: xpResults.get(submissionId) || null });
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
app.post('/api/admin/pastbar/manual', adminOnly, async (req, res) => {
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
      const raw = sanitizeAIResponse(await callClaude(attempt === 1 ? msgs : [attemptMsgs[0]], maxTokens));
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

// ── Admin: Evaluation queue health ──────────────────────────
app.get('/api/admin/queue-stats', adminOnly, (_req, res) => {
  const globalQueueDepth  = EvalQueue.queue.length;
  const activeSubmissions = new Set(EvalQueue.queue.map(j => j.submissionId)).size;
  const avgMs = EvalQueue.avgEvalTimeMs;
  const estimatedClearTimeSec = globalQueueDepth > 0
    ? Math.ceil((globalQueueDepth * avgMs) / (EvalQueue.maxConcurrent * 1000))
    : 0;
  res.json({
    semaphoreMax:          EvalQueue.maxConcurrent,
    semaphoreActive:       EvalQueue.activeCount,
    globalQueueDepth,
    activeSubmissions,
    estimatedClearTimeSec,
    avgEvalTimeMs:         Math.round(avgMs),
    totalProcessed:        EvalQueue.totalProcessed,
    perUserActive:         Object.fromEntries(EvalQueue.perUserActive),
  });
});

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

// CONTENT is kept in-memory only (regenerable from KB); no disk persistence needed
function saveContent() { /* no-op — CONTENT is in-memory only */ }

app.get('/robots.txt', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
  await supabase.from('users').update({ status: 'active' }).is('status', null).catch(() => {});
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
