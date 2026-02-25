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
app.post('/api/admin/syllabus', adminOnly, async (req, res) => {
  const { name, content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  try {
    const subjects = await parseSyllabusLarge(content);
    KB.syllabus = { name:name||'Bar Exam Syllabus', rawText:content.slice(0,60000), topics:subjects, uploadedAt:new Date().toISOString() };
    saveKB();
    const totalTopics = subjects.reduce((a,s) => a+(s.topics?.length||0), 0);
    res.json({ success:true, subjects:subjects.length, totalTopics });
    triggerPreGeneration();   // fire-and-forget
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── ADMIN: Upload Reference ─────────────────────────────────
app.post('/api/admin/reference', adminOnly, async (req, res) => {
  const { name, subject, type, content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const id = `ref_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  try {
    const summary = await summarizeLargeDoc(content, name, subject||'general');
    KB.references.push({ id, name, subject:subject||'general', type:type||'other', text:content.slice(0,30000), summary, size:content.length, uploadedAt:new Date().toISOString() });
    saveKB();
    res.json({ success:true, id, name });
    if (KB.syllabus) triggerPreGenerationForSubject(subject);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── ADMIN: Past Bar — Pass 1: Analyze document structure ────
app.post('/api/admin/pastbar/analyze', adminOnly, async (req, res) => {
  const { content, name, subject, year } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const Q_CHUNK = 12000;
  const chunks = [];
  for (let i = 0; i < content.length && chunks.length < MAX_CHUNKS; i += Q_CHUNK)
    chunks.push(content.slice(i, i + Q_CHUNK));
  console.log(`pastbar/analyze [${name}]: ${content.length} chars, ${chunks.length} chunk(s)`);
  try {
    const analyses = [];
    for (let i = 0; i < chunks.length; i++) {
      const partLabel = chunks.length > 1 ? ` | Part ${i+1} of ${chunks.length}` : '';
      const analysis = await callClaude([{ role:'user', content:
        `Read this document carefully. It contains Philippine Bar Exam content.\nFirst, describe what format the questions are in (numbered, roman numerals, Q&A pairs, essay style, etc). Then identify and list ALL questions you can find — a question is any sentence or paragraph that asks something, poses a legal problem, or presents a situation requiring legal analysis. Also identify any suggested answers or model answers paired with them.\n\nMaterial: ${name||'Unknown'} (${year||'?'}) | Subject: ${subject||'general'}${partLabel}\nContent:\n${chunks[i]}`
      }], 2000);
      analyses.push({ chunk: i, analysis });
      if (i < chunks.length - 1) await sleep(400);
    }
    res.json({ analyses, chunksTotal: chunks.length, totalChars: content.length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── ADMIN: Past Bar — Pass 2: Extract + save ────────────────
app.post('/api/admin/pastbar', adminOnly, async (req, res) => {
  const { name, subject, year, content, analyses } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const id = `pb_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const Q_CHUNK = 12000;
  const chunks = [];
  for (let i = 0; i < content.length && chunks.length < MAX_CHUNKS; i += Q_CHUNK)
    chunks.push(content.slice(i, i + Q_CHUNK));
  console.log(`pastbar/extract [${name}]: ${content.length} chars, ${chunks.length} chunk(s)`);
  try {
    const allQ = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkAnalysis = analyses?.[i]?.analysis || '';
      const partLabel = chunks.length > 1 ? ` | Part ${i+1} of ${chunks.length}` : '';
      const extractPrompt = chunkAnalysis
        ? `Based on your analysis:\n${chunkAnalysis}\n\nNow extract ALL questions and their answers into this exact JSON format. For questions with no answer in the document, write a comprehensive model answer yourself using your knowledge of Philippine law. NEVER return an empty questions array — if you found even one legal question or scenario, extract it.\n\nMaterial: ${name||'Unknown'} (${year||'?'}) | Subject: ${subject||'general'}${partLabel}\nContent:\n${chunks[i]}\n\nRespond ONLY with valid JSON (no markdown fence):\n{ "questions": [{ "q": "Full question text", "modelAnswer": "Comprehensive model answer with legal citations", "keyPoints": ["Point 1", "Point 2"], "topics": ["Topic"] }] }`
        : `Read this Philippine Bar Exam material. Extract ALL questions into JSON. Accept any format (numbered, essay, Q&A, paragraph). For questions without answers write comprehensive model answers using Philippine law knowledge. NEVER return an empty questions array.\n\nMaterial: ${name||'Unknown'} (${year||'?'}) | Subject: ${subject||'general'}${partLabel}\nContent:\n${chunks[i]}\n\nRespond ONLY with valid JSON (no markdown fence):\n{ "questions": [{ "q": "Full question text", "modelAnswer": "Comprehensive model answer with legal citations", "keyPoints": ["Point 1", "Point 2"], "topics": ["Topic"] }] }`;
      let chunkQ = [];
      try {
        const raw = await callClaude([{ role:'user', content: extractPrompt }], 4000);
        chunkQ = JSON.parse(raw.replace(/^```json\s*/i,'').replace(/```$/,'').trim()).questions || [];
      } catch(e) {
        console.warn(`pastbar extract chunk ${i+1}: JSON parse failed (${e.message}) — trying text-only retry`);
        try {
          const textRaw = await callClaude([{ role:'user', content:`List exam questions from this text as JSON. Return ONLY:\n{ "questions": [{ "q": "question text", "modelAnswer": "", "keyPoints": [], "topics": ["${subject||'general'}"] }] }\n\nText:\n${chunks[i].slice(0,6000)}` }], 1500);
          const textParsed = JSON.parse(textRaw.replace(/^```json\s*/i,'').replace(/```$/,'').trim());
          for (const q of (textParsed.questions || [])) {
            if (!q.modelAnswer) {
              q.modelAnswer = await callClaude([{ role:'user', content:`Write a comprehensive Philippine Bar Exam model answer for this question:\n\n${q.q}\n\nSubject: ${subject||'general'}\n\nAnswer with relevant articles, G.R. case numbers, and legal doctrines:` }], 600).catch(() => '');
              await sleep(200);
            }
          }
          chunkQ = textParsed.questions || [];
        } catch(e2) { console.warn(`pastbar extract chunk ${i+1}: all retries failed`); }
      }
      console.log(`pastbar extract chunk ${i+1}/${chunks.length}: found ${chunkQ.length} question(s)`);
      allQ.push(...chunkQ);
      if (i < chunks.length - 1) await sleep(400);
    }
    // Deduplicate by first 100 chars of normalised question text
    const seen = new Set();
    const dedupedQ = allQ.filter(q => {
      const key = (q.q||'').trim().toLowerCase().slice(0,100);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    console.log(`pastbar [${name}]: totalChars=${content.length}, chunks=${chunks.length}, raw=${allQ.length}, deduped=${dedupedQ.length}`);
    if (dedupedQ.length === 0) {
      const desc = analyses?.[0]?.analysis || 'The content did not appear to contain recognizable bar exam questions or legal scenarios.';
      return res.json({ success:false, questionsExtracted:0, description:desc });
    }
    KB.pastBar.push({ id, name, subject:subject||'general', year:year||'Unknown', questions:dedupedQ, rawText:content.slice(0,30000), uploadedAt:new Date().toISOString() });
    saveKB();
    res.json({ success:true, id, name, questionsExtracted:dedupedQ.length, firstQuestion:dedupedQ[0] });
  } catch(err) { res.status(500).json({ error:err.message }); }
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
  const refs   = KB.references.filter(r => r.subject===subjKey||r.subject==='general');
  const refCtx = refs.length ? `\nReference materials (use for accuracy):\n${refs.slice(0,2).map(r=>`[${r.name}]\n${r.summary||r.text.slice(0,600)}`).join('\n\n')}` : '';
  const pbs    = KB.pastBar.filter(p => p.subject===subjKey||p.subject==='general');
  const pbCtx  = pbs.length ? `\nPast bar style example:\n${pbs[0]?.questions?.[0]?.q?.slice(0,200)||''}` : '';

  const prompt = `You are an expert Philippine Bar Exam reviewer.
Subject: ${subjKey} law | Topic: ${topicName}
${subtopics.length?`Subtopics: ${subtopics.join(', ')}`:''}
${refCtx}${pbCtx}

Generate a complete study package. Respond ONLY with valid JSON (no markdown):
{
  "lesson": {
    "pages": [
      { "title": "Page 1: Overview & Key Concepts", "content": "Rich HTML with <p>,<strong>,<em>,<ul>,<li>. MUST include: <div class='definition-box'>doctrine</div> <div class='case-box'><strong>G.R. No. X — Case (Year):</strong> ruling</div> <div class='codal-box'>Art. X, NCC:</div> <div class='rule-box'>RULE:</div> <div class='tip-box'>💡 BAR TIP:</div>" },
      { "title": "Page 2: Applications, Exceptions & Jurisprudence", "content": "More doctrines, cases, exceptions, bar tips." }
    ]
  },
  "mcq": {
    "questions": [
      { "q": "Bar MCQ with fact pattern", "options": ["A.","B.","C.","D."], "answer": 0, "explanation": "Why correct, citing Art./G.R." },
      { "q": "...", "options": ["A.","B.","C.","D."], "answer": 1, "explanation": "..." },
      { "q": "...", "options": ["A.","B.","C.","D."], "answer": 2, "explanation": "..." },
      { "q": "...", "options": ["A.","B.","C.","D."], "answer": 0, "explanation": "..." },
      { "q": "...", "options": ["A.","B.","C.","D."], "answer": 3, "explanation": "..." }
    ]
  },
  "essay": {
    "questions": [
      { "prompt": "Full bar essay/situational question", "context": "Additional facts (or empty string)", "modelAnswer": "Comprehensive answer with citations", "keyPoints": ["Point 1","Point 2","Point 3"] },
      { "prompt": "...", "context": "", "modelAnswer": "...", "keyPoints": ["...","..."] },
      { "prompt": "...", "context": "", "modelAnswer": "...", "keyPoints": ["...","..."] }
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
    const finalSystem = (system||'') + kbCtx;
    if (finalSystem) body.system = finalSystem;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':API_KEY, 'anthropic-version':'2023-06-01' },
      body:JSON.stringify(body),
    });
    const data = await r.json();
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

    // 3) AI-generated for remainder
    const needed = count - real.length - preGen.length;
    let aiQs = [];
    if (needed > 0) {
      const syllCtx = KB.syllabus ? KB.syllabus.topics.map(s=>`${s.name}: ${s.topics?.map(t=>t.name).join(', ')}`).join('\n') : '';
      const raw = await callClaude([{ role:'user', content:`Generate ${needed} Philippine Bar Exam essay/situational questions for a mock bar.

Subjects: ${subjects?.join(', ')||'all 8 bar subjects'}
Syllabus: ${syllCtx}

Authentic bar exam style, distribute across subjects, full fact patterns.

Respond ONLY with valid JSON:
{ "questions": [{ "subject":"civil|criminal|political|labor|commercial|taxation|remedial|ethics", "q":"Full situational question", "modelAnswer":"Comprehensive answer", "keyPoints":["Point 1","Point 2"], "isReal":false }] }` }], 4000);
      aiQs = JSON.parse(raw.replace(/^```json\s*/i,'').replace(/```$/,'').trim()).questions || [];
    }

    const all = shuffle([...real, ...preGen, ...aiQs]).slice(0, count);
    all.forEach((q,i) => q.number = i+1);
    res.json({ questions:all, total:all.length, fromPastBar:real.length, fromPreGen:preGen.length, aiGenerated:aiQs.length });
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

// Parse a syllabus of any size, merging topics by subject key
async function parseSyllabusLarge(content) {
  const S_CHUNK = 14000;
  const chunks = [];
  for (let i = 0; i < content.length && chunks.length < 6; i += S_CHUNK)
    chunks.push(content.slice(i, i + S_CHUNK));

  const subjectMap = {};
  for (let i = 0; i < chunks.length; i++) {
    const raw = await callClaude([{ role:'user', content:`Parse this section of a Philippine Bar Exam Syllabus into structured JSON.\n\nContent (Part ${i+1} of ${chunks.length}):\n${chunks[i]}\n\nRespond ONLY with valid JSON (no markdown):\n{\n  "subjects": [\n    {\n      "key": "civil|criminal|political|labor|commercial|taxation|remedial|ethics",\n      "name": "Full subject name",\n      "topics": [{ "name": "Topic name", "subtopics": ["Sub 1","Sub 2"] }]\n    }\n  ]\n}` }], 4000)
      .catch(() => '{"subjects":[]}');
    try {
      const parsed = JSON.parse(raw.replace(/^```json\s*/i,'').replace(/```$/,'').trim());
      for (const subj of (parsed.subjects || [])) {
        if (!subjectMap[subj.key]) { subjectMap[subj.key] = { ...subj, topics: [...(subj.topics||[])] }; }
        else {
          const seen = new Set(subjectMap[subj.key].topics.map(t => t.name));
          for (const t of (subj.topics || [])) { if (!seen.has(t.name)) subjectMap[subj.key].topics.push(t); }
        }
      }
    } catch(e) {}
    if (i < chunks.length - 1) await sleep(400);
  }
  return Object.values(subjectMap);
}

async function callClaude(messages, max_tokens=2000) {
  const RETRY_WAITS   = [15000, 30000, 45000]; // wait after attempt 0, 1, 2
  const isOverloaded  = (status, body) =>
    status === 529 || status === 429 || body?.error?.type === 'overloaded_error';

  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':API_KEY, 'anthropic-version':'2023-06-01' },
      body:JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens, messages }),
    });
    const d = await r.json();
    if (isOverloaded(r.status, d)) {
      if (attempt < 3) {
        const wait = RETRY_WAITS[attempt];
        console.warn(`Claude overloaded (attempt ${attempt+1}/4) — retrying in ${wait/1000}s`);
        await sleep(wait);
        continue;
      }
      throw new Error('Claude API overloaded — failed after 4 attempts');
    }
    if (d.error) throw new Error(d.error.message);
    return d.content.map(c=>c.text||'').join('');
  }
}
const shuffle = arr => { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; };
const sleep   = ms  => new Promise(r => setTimeout(r, ms));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`BarBuddy v3 on port ${PORT}`));
