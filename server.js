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
      { "prompt": "Essay question based on a situation described in the source material", "context": "Additional facts from source (or empty string)", "modelAnswer": "Answer using ONLY information from source materials", "keyPoints": ["Point from source","Point from source"], "source": "Based on: [reference name], [relevant passage]" },
      { "prompt": "...", "context": "", "modelAnswer": "...", "keyPoints": ["...","..."], "source": "..." },
      { "prompt": "...", "context": "", "modelAnswer": "...", "keyPoints": ["...","..."], "source": "..." }
    ]
  }
}`;

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

// ── MOCK BAR GENERATOR ──────────────────────────────────────
app.post('/api/mockbar/generate', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error:'API key not set' });
  const { subjects, count=20 } = req.body;
  try {
    // 1) Real past bar questions
    let real = [];
    KB.pastBar.forEach(pb => {
      if (!subjects||subjects.includes('all')||subjects.includes(pb.subject))
        (pb.questions||[]).forEach(q => real.push({ ...q, source:pb.name, year:pb.year, subject:pb.subject, isReal:true }));
    });
    real = shuffle(real).slice(0, Math.floor(count/2));

    // 2) Pre-generated essay questions
    let preGen = [];
    const targetSubjs = subjects?.includes('all') ? Object.keys(CONTENT) : (subjects||Object.keys(CONTENT));
    targetSubjs.forEach(subj =>
      Object.entries(CONTENT[subj]||{}).forEach(([topic, data]) =>
        (data.essay?.questions||[]).forEach(q => preGen.push({ ...q, subject:subj, topics:[topic], isReal:false, source:'Pre-generated' }))
      )
    );
    preGen = shuffle(preGen).slice(0, Math.ceil((count-real.length)/2));

    // 3) AI-generated from uploaded references only — skip if no references available
    const needed = count - real.length - preGen.length;
    let aiQs = [];
    if (needed > 0) {
      const targetSubjList = (!subjects || subjects.includes('all')) ? null : subjects;
      const refMaterials = KB.references
        .filter(r => !targetSubjList || targetSubjList.includes(r.subject) || r.subject==='general')
        .slice(0, 3)
        .map(r => `[${r.name}]\n${(r.text||'').slice(0,2000)}`)
        .join('\n\n');
      if (refMaterials) {
        const raw = await callClaude([{ role:'user', content:`Below are the ONLY source materials you may use. From these materials only, extract or construct ${needed} bar exam situational questions. Do not use any information not found in the source materials below.

SOURCE MATERIALS:
${refMaterials}

Respond ONLY with valid JSON:
{ "questions": [{ "subject":"civil|criminal|political|labor|commercial|taxation|remedial|ethics", "q":"Situational question based on source material", "modelAnswer":"Answer using only information from source", "keyPoints":["Point from source"], "isReal":false, "source":"[reference name], [passage]" }] }` }], 4000);
        try { aiQs = JSON.parse(raw.replace(/^```json\s*/i,'').replace(/```$/,'').trim()).questions || []; }
        catch(e) { aiQs = []; }
      }
    }

    const usedAI = aiQs.length > 0;
    const all = shuffle([...real, ...preGen, ...aiQs]).slice(0, count);
    all.forEach((q,i) => q.number = i+1);
    res.json({ questions:all, total:all.length, fromPastBar:real.length, fromPreGen:preGen.length, aiGenerated:aiQs.length, usedAI });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── ESSAY EVALUATION ────────────────────────────────────────
app.post('/api/evaluate', async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error:'API key not set' });
  const { question, answer, modelAnswer, keyPoints, subject } = req.body;
  const refCtx = KB.references.filter(r=>r.subject===subject||r.subject==='general').slice(0,1).map(r=>r.summary||'').join('');
  try {
    const raw = await callClaude([{ role:'user', content:`You are a Philippine Bar Exam evaluator.

Question: ${question}
${modelAnswer?`Model Answer: ${modelAnswer}`:''}
${(keyPoints||[]).length?`Key Points: ${keyPoints.join(', ')}`:''}
${refCtx?`\nLegal Reference Context:\n${refCtx}`:''}

Student Answer: ${answer}

Score strictly as a Bar examiner. Respond ONLY with valid JSON:
{ "score":"X/10", "numericScore":7, "grade":"Excellent|Good|Satisfactory|Needs Improvement|Poor", "overallFeedback":"2-3 sentence assessment", "strengths":["..."], "improvements":["missing legal argument with citation"], "keyMissed":["Point with Art./G.R. citation"], "modelAnswer":"Full answer with citations" }` }], 1500);
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
