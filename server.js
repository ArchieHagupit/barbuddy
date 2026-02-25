const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const app       = express();
const PORT      = process.env.PORT || 3000;
const API_KEY   = process.env.ANTHROPIC_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY || 'barbuddy-admin-2025';

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
const UPLOADS_DIR  = path.join(__dirname, 'uploads');
const KB_PATH      = path.join(UPLOADS_DIR, 'kb.json');
const CONTENT_PATH = path.join(UPLOADS_DIR, 'content.json');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Knowledge Base — syllabus + references + past bar
const KB = {
  syllabus:   null,   // { name, rawText, topics:[{key,name,topics:[{name,subtopics:[]}]}], uploadedAt }
  references: [],     // [{ id, name, subject, type, text, summary, size, uploadedAt }]
  pastBar:    [],     // [{ id, name, subject, year, questions:[{q,modelAnswer,keyPoints}], uploadedAt }]
};

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
  try {
    if (fs.existsSync(KB_PATH))      Object.assign(KB, JSON.parse(fs.readFileSync(KB_PATH, 'utf8')));
    if (fs.existsSync(CONTENT_PATH)) CONTENT = JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'));
    const n = Object.values(CONTENT).reduce((a,s) => a+Object.keys(s).length, 0);
    console.log(`KB loaded: syllabus=${!!KB.syllabus}, refs=${KB.references.length}, pastBar=${KB.pastBar.length}, content=${n} topics`);
  } catch(e) { console.error('Load error:', e.message); }
}
function saveKB()      { try { fs.writeFileSync(KB_PATH, JSON.stringify(KB)); } catch(e) { console.error('KB save:', e.message); } }
function saveContent() { try { fs.writeFileSync(CONTENT_PATH, JSON.stringify(CONTENT)); } catch(e) { console.error('Content save:', e.message); } }
loadData();

// ── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '80mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function adminOnly(req, res, next) {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

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
  });
});

// ── GET pre-generated content for one topic ─────────────────
app.get('/api/content/:subject/:topic', (req, res) => {
  const data = CONTENT[req.params.subject]?.[decodeURIComponent(req.params.topic)];
  if (data) return res.json({ found:true, ...data });
  res.json({ found:false });
});

// ── GET full content dump (browser caches on load) ──────────
app.get('/api/content', (req, res) => res.json(CONTENT));

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
    res.json({ success:true, subjects:subjects.length, totalTopics });
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
  KB.syllabus.topics.forEach(subj =>
    (subj.topics||[]).forEach(t => queue.push({ subjKey:subj.key, subjName:subj.name, topicName:t.name, subtopics:t.subtopics||[] }))
  );
  if (!queue.length) return;
  await runGenQueue(queue);
}

async function triggerPreGenerationForSubject(subjKey) {
  if (GEN.running || !KB.syllabus) return;
  const subj = KB.syllabus.topics.find(s => s.key === subjKey);
  if (!subj) return;
  delete CONTENT[subjKey];
  const queue = (subj.topics||[]).map(t => ({ subjKey, subjName:subj.name, topicName:t.name, subtopics:t.subtopics||[] }));
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
  // a) Skip entirely if no reference materials exist for this subject
  const refs = KB.references.filter(r => r.subject===subjKey || r.subject==='general');
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

// ── MAIN CHAT PROXY ─────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error:{ message:'ANTHROPIC_API_KEY not set.' } });
  const { messages, max_tokens=2000, system, subject, topicName, mode } = req.body;
  if (!messages?.length) return res.status(400).json({ error:{ message:'messages required' } });

  let kbCtx = '';
  if (mode !== 'chat') {
    if (KB.syllabus && subject) {
      const subj = KB.syllabus.topics.find(s => s.key===subject);
      if (subj) {
        kbCtx += `\n\n[Syllabus] Subject: ${subj.name} | Topics: ${subj.topics?.map(t=>t.name).join(', ')}`;
        if (topicName) { const tp=subj.topics?.find(t=>t.name===topicName); if(tp?.subtopics?.length) kbCtx+=`\nSubtopics: ${tp.subtopics.join(', ')}`; }
      }
    }
    const refs = subject ? KB.references.filter(r=>r.subject===subject||r.subject==='general') : KB.references.slice(0,2);
    if (refs.length) kbCtx += `\n\n[References]\n${refs.slice(0,2).map(r=>`--- ${r.name} ---\n${r.summary||r.text.slice(0,500)}`).join('\n\n')}`;
    if (mode==='essay'||mode==='mockbar') {
      const pbs = subject ? KB.pastBar.filter(p=>p.subject===subject||p.subject==='general') : KB.pastBar;
      if (pbs.length) kbCtx += `\n\n[Past bar style]\n${pbs[0]?.questions?.[0]?.q?.slice(0,200)||''}`;
    }
  }

  try {
    const body = { model:'claude-sonnet-4-20250514', max_tokens, messages };
    const finalSystem = STRICT_SYSTEM_PROMPT + '\n\n' + (system||'') + kbCtx;
    if (finalSystem) body.system = finalSystem;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':API_KEY, 'anthropic-version':'2023-06-01' },
      body:JSON.stringify(body),
    });
    const data = await r.json();
    if (r.status === 529 || r.status === 429 || data?.error?.type === 'overloaded_error')
      return res.json({ overloaded: true });
    res.status(r.status).json(data);
  } catch(err) { res.status(500).json({ error:{ message:'Proxy: '+err.message } }); }
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
async function generateMockBar(subjects, count) {
  // STEP 1: Build real past bar pool
  let realPool = [];
  KB.pastBar.forEach(pb => {
    const match = !subjects || subjects.includes('all') || subjects.includes(pb.subject);
    if (match) {
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
        });
      });
    }
  });
  realPool = shuffle(realPool);
  console.log(`[mockbar] realPool size: ${realPool.length}`);

  // STEP 2: Build pre-gen pool
  let preGenPool = [];
  const targetSubjs = (!subjects || subjects.includes('all')) ? Object.keys(CONTENT) : subjects;
  targetSubjs.forEach(subj => {
    Object.entries(CONTENT[subj] || {}).forEach(([, data]) => {
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
  console.log(`[mockbar] preGenPool size: ${preGenPool.length}`);

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

  // STEP 4: Fill remaining gap with AI
  const gap = count - chosen.length;
  console.log(`[mockbar] gap to fill with AI: ${gap}`);

  if (gap > 0) {
    try {
      const aiQuestions = await generateAIQuestions(gap, subjects, KB.syllabus, KB.references);
      console.log(`[mockbar] AI generated: ${aiQuestions.length}`);
      chosen.push(...aiQuestions);
    } catch(e) {
      console.error('[mockbar] AI generation failed:', e.message);
    }
  }

  // STEP 5: Hard slice to exactly count
  const final = chosen.slice(0, count);
  console.log(`[mockbar] FINAL COUNT: ${final.length} / requested: ${count}`);

  if (final.length !== count) {
    console.warn(`[mockbar] WARNING: Could not reach requested count. Had ${realPool.length} real + ${preGenPool.length} pregen, needed ${count}`);
  }

  final.forEach((q, i) => q.number = i + 1);

  return {
    questions: final,
    total: final.length,
    requested: count,
    fromPastBar: final.filter(q => q.isReal).length,
    fromPreGen: final.filter(q => !q.isReal && q.source === 'Pre-generated').length,
    aiGenerated: final.filter(q => !q.isReal && q.source !== 'Pre-generated').length,
  };
}

// ── MOCK BAR GENERATOR ──────────────────────────────────────
app.post('/api/mockbar/generate', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error:'API key not set' });
  const { subjects, count=20 } = req.body;
  console.log(`[mockbar] requested: ${count} questions, subjects: ${JSON.stringify(subjects)}`);
  try {
    const result = await generateMockBar(subjects, count);
    res.json(result);
  } catch(err) {
    console.error('[mockbar] error:', err.message);
    res.status(500).json({ error:err.message });
  }
});

// ── ESSAY EVALUATION ────────────────────────────────────────
app.post('/api/evaluate', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error:'API key not set' });
  const { question, answer, modelAnswer, keyPoints, subject } = req.body;
  const refCtx = KB.references.filter(r=>r.subject===subject||r.subject==='general').slice(0,1).map(r=>r.summary||'').join('');
  try {
    const raw = await callClaude([{ role:'user', content:`You are a Philippine Bar Exam examiner. Evaluate this student answer using the ALAC method (Answer, Legal Basis, Application, Conclusion) which is the standard format required in the Philippine Bar Exam.

Question: ${question}
${modelAnswer?`Reference Answer: ${modelAnswer}`:''}
${(keyPoints||[]).length?`Key Points to Check: ${keyPoints.join(', ')}`:''}
${refCtx?`\nLegal Reference Context:\n${refCtx}`:''}

Student Answer: ${answer}

Score each ALAC component using these weights which reflect actual Philippine Bar Exam priorities (total = 10 points):

A — Answer (1.5 pts): Direct answer to the question upfront. Worth less because a correct answer without legal basis is incomplete.

L — Legal Basis (3.0 pts): Specific law, article number, codal provision, or G.R. number cited correctly. Heavily weighted because citing exact legal authority is a core bar exam skill. Be strict: only award full points if a specific article number, G.R. number, or statute name is correctly cited. Partial credit for naming the correct law without specific provision. Zero for no citation.

A — Application (4.0 pts): HIGHEST WEIGHT. How well the student applies the law to the specific facts. Only award full points if the student explicitly connects the legal rule to the specific parties and facts in the question. Partial credit for general application. Zero for restating the law without applying it to the facts. This demonstrates actual legal reasoning ability which is the primary skill tested in the bar exam.

C — Conclusion (1.5 pts): Clear restatement of the answer. Shows the student can synthesize their analysis.

Respond ONLY with valid JSON (no markdown):
{
  "score": "X/10",
  "numericScore": 7,
  "grade": "Excellent|Good|Satisfactory|Needs Improvement|Poor",
  "alac": {
    "answer": { "score": 1.2, "max": 1.5, "feedback": "What the student did well or missed for this component", "studentDid": "Quote or describe what the student wrote for the direct answer" },
    "legalBasis": { "score": 2.4, "max": 3.0, "feedback": "...", "studentDid": "..." },
    "application": { "score": 3.2, "max": 4.0, "feedback": "...", "studentDid": "..." },
    "conclusion": { "score": 1.0, "max": 1.5, "feedback": "...", "studentDid": "..." }
  },
  "overallFeedback": "2-3 sentence overall assessment",
  "strengths": ["..."],
  "improvements": ["..."],
  "keyMissed": ["specific law or case they should have cited"],
  "modelAnswer": "ANSWER: [direct answer]\nLEGAL BASIS: [specific article/case]\nAPPLICATION: [how law applies to these facts]\nCONCLUSION: [restatement of answer]"
}` }], 2000);
    res.json(JSON.parse(raw.replace(/^```json\s*/i,'').replace(/```$/,'').trim()));
  } catch(err) { res.status(500).json({ error:err.message }); }
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
            subjectMap[currentKey].topics.push({ name, subtopics:[] });
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
