// ══════════════════════════════════════════════════════════════════════
// TABLE OF CONTENTS — jump to a section with Cmd+F on the label
// ══════════════════════════════════════════════════════════════════════
//   Line    43 — DOM SAFE HELPERS
//   Line    51 — STATE
//   Line   109 — EXAM SESSION AUTO-SAVE
//   Line   418 — LOADING SCREEN
//   Line   468 — INIT
//   Line   604 — LOCAL BROWSER CACHE
//   Line   648 — SERVER STATE
//   Line   703 — SSE — LIVE GENERATION PROGRESS
//   Line   748 — NAVIGATION
//   Line  2154 — SIDEBAR RENDERER
//   Line  2200 — OVERVIEW GRID
//   Line  2287 — SYLLABUS TREE
//   Line  2484 — LESSON VIEWER
//   Line  2725 — PROGRESS TRACKING
//   Line  2774 — BOOKMARKS
//   Line  3036 — QUIZ POOL (from cache)
//   Line  3445 — DASHBOARD
//   Line  3486 — MOCK BAR
//   Line  3496 — MOCK BAR SETUP PANEL
//   Line  4159 — MANUAL QUESTION UPLOAD
//   Line  4247 — PRINT / EMAIL RESULTS
//   Line  4476 — ADMIN
//   Line  4479 — TAB ACCESS CONTROL
//   Line  4747 — SUBJECT OVERVIEW GRID (admin)
//   Line  5304 — UTILS
//   Line  5309 — AUTH STATE
//   Line  5578 — SAVE MOCK BAR RESULTS
//   Line  5611 — ADMIN: USERS
//   Line  5797 — ADMIN: RESULTS
//   Line  6091 — ADMIN: SYLLABUS BUILDER
//   Line  6354 — PER-USER TAB ACCESS CONTROL
//   Line  6522 — ADMIN: IMPROVE ITEMS INSIGHTS
//   Line  6748 — MOCK BAR — Q-MARKER RENDERER (flag-aware)
//   Line  6763 — FEATURE 1 — TEXT HIGHLIGHTING
//   Line  6876 — FEATURE 2 — FLAG QUESTION FOR REVIEW
//   Line  6987 — XP POPUP & LEVEL UP MODAL
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════
// DOM SAFE HELPERS
// ══════════════════════════════════
function safeSetHTML(id, html)         { const el=document.getElementById(id); if(el) el.innerHTML=html; }
function safeSetText(id, text)         { const el=document.getElementById(id); if(el) el.textContent=text; }
function safeSetStyle(id, prop, val)   { const el=document.getElementById(id); if(el) el.style[prop]=val; }
function safeSetDisabled(id, val)      { const el=document.getElementById(id); if(el) el.disabled=val; }

// ══════════════════════════════════
// STATE
// ══════════════════════════════════
let KB = { hasSyllabus:false, syllabusTopics:[], references:[], pastBar:[], contentTopics:0, genState:{} };
let CACHE = {};          // browser-side content cache: { [subj]: { [topic]: {lesson,mcq,essay} } }
const VISITED = [];      // [{subjKey, topicName, title, type}] — recent activity
let totalQDone=0, totalCorrect=0, mockSessions=0;
let curSubj=null, curTopic=null, curPage=0;
let quizPool=[];         // flat list of {type,subject,topic,data} loaded from CACHE for practice panel
let activeQuiz=null, qIdx=0, qScore=0, qMode='essay';
let mockQs=[], mockIdx=0, mockAnswers=[], mockTimer=null, mockLeft=0;
let isSessionActive = false;

function showSessionOverlay() {
  isSessionActive = true;
  document.getElementById('mainSidebar')?.classList.add('session-locked');
  document.querySelector('.topbar')?.classList.add('session-locked');
  if (typeof _attachBeforeUnload === 'function') _attachBeforeUnload();
}
function hideSessionOverlay() {
  isSessionActive = false;
  document.getElementById('mainSidebar')?.classList.remove('session-locked');
  document.querySelector('.topbar')?.classList.remove('session-locked');
  if (typeof _detachBeforeUnload === 'function') _detachBeforeUnload();
}
document.addEventListener('keydown', (e) => {
  if (!isSessionActive) return;
  if (e.key === 'Backspace' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
  }
});
let mockScores=[], mockSubjectsUsed=[], mockSessionDate=null;
let mockTimeLimitSecs=0; // original time limit in seconds (0 = no limit)
let manualBatch=[], manualQNum=1;
let adminKey='', sseSource=null;
let currentSubject = null;  // active subject key ('civil'|'labor'|...|'custom'|null)
let currentMode    = null;  // active mode ('flashcards'|'mockbar'|'speeddrill'|'learn'|'quiz'|null)
// Syllabus builder state
let syllabusBuilderSubject = 'civil';
let syllabusData = {};
// Per-subject syllabus cache for Learn tab
const syllabusCache = {};
let currentTopic = null; // tracks last-clicked syllabus node for PDF retry
let mbCount = 20, mbTimeMins = 0, mbDifficulty = 'balanced';  // mock bar setup state

const SUBJS=[
  {key:'civil',    name:'Civil Law',               cls:'sg-civ',f:'bf-g', color:'#4a9eff'},
  {key:'criminal', name:'Criminal Law',             cls:'sg-cri',f:'bf-r', color:'var(--danger)'},
  {key:'political',name:'Political Law',            cls:'sg-pol',f:'bf-b', color:'#50d090'},
  {key:'labor',    name:'Labor & Social Leg.',      cls:'sg-lab',f:'bf-t', color:'#f0a040'},
  {key:'commercial',name:'Commercial Law',          cls:'sg-com',f:'bf-g', color:'#a070e0'},
  {key:'taxation', name:'Taxation',                 cls:'sg-tax',f:'bf-r', color:'#40c0b0'},
  {key:'remedial', name:'Remedial Law',             cls:'sg-rem',f:'bf-t', color:'#e0c050'},
  {key:'ethics',   name:'Legal Ethics',             cls:'sg-eth',f:'bf-b', color:'#c0a080'},
];
const CUSTOM_SUBJ = {key:'custom', name:'Custom Subject', color:'#8899aa'};
const ALL_SUBJS = [...SUBJS, CUSTOM_SUBJ];

// ══════════════════════════════════
// EXAM SESSION AUTO-SAVE
// ══════════════════════════════════
const ExamSession = {
  _timer: null,
  _saveIndicatorTimer: null,

  // Save to localStorage immediately
  saveLocal(session) {
    if (!session || !currentUser?.id) return;
    try {
      const toSave = { ...session, lastSavedAt: new Date().toISOString() };
      localStorage.setItem('bb_exam_session_' + currentUser.id, JSON.stringify(toSave));
    } catch(e) { console.warn('Exam local save failed:', e); }
  },

  // Sync to server (called every 30 s)
  async saveServer(session) {
    if (!session || !sessionToken) return false;
    try {
      const r = await fetch('/api/exam-session/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ session }),
      });
      return r.ok;
    } catch(e) { console.warn('Exam server save failed:', e); return false; }
  },

  loadLocal() {
    if (!currentUser?.id) return null;
    try {
      const raw = localStorage.getItem('bb_exam_session_' + currentUser.id);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return (s?.status === 'in_progress' && s?.questions?.length > 0) ? s : null;
    } catch(e) { return null; }
  },

  async loadServer() {
    if (!sessionToken) return null;
    try {
      const r = await fetch('/api/exam-session/active', { headers: { 'x-session-token': sessionToken } });
      const d = await r.json();
      return d.session || null;
    } catch(e) { return null; }
  },

  async getBestSession() {
    const local = this.loadLocal();
    const server = await this.loadServer();
    if (!local && !server) return null;
    if (local && !server) return local;
    if (!local && server) return server;
    return new Date(local.lastSavedAt).getTime() >= new Date(server.lastSavedAt).getTime() ? local : server;
  },

  clearLocal() {
    if (!currentUser?.id) return;
    localStorage.removeItem('bb_exam_session_' + currentUser.id);
  },

  async clearServer() {
    try { await fetch('/api/exam-session/clear', { method: 'DELETE', headers: { 'x-session-token': sessionToken || '' } }); } catch(e) {}
  },

  async clearAll() {
    this.clearLocal();
    await this.clearServer();
    window.activeExamSession = null;
  },

  startAutoSave(getSessionFn) {
    this.stopAutoSave();
    this._timer = setInterval(async () => {
      const sess = getSessionFn();
      if (!sess || sess.status !== 'in_progress') return;
      const ok = await this.saveServer(sess);
      this.showSaveIndicator(ok);
    }, 30000);
  },

  stopAutoSave() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  showSaveIndicator(success) {
    const el = document.getElementById('exam-save-indicator');
    if (!el) return;
    el.textContent = success ? '✓ Saved' : '⚠ Saved locally';
    el.style.color  = success ? 'var(--teal)' : 'var(--og)';
    el.style.opacity = '1';
    clearTimeout(this._saveIndicatorTimer);
    this._saveIndicatorTimer = setTimeout(() => { el.style.opacity = '0'; }, 2000);
  }
};

// Safely read a saved answer regardless of storage format:
//   string | {text:'...',savedAt:...} | stored by index or by q.id
function getAnswerText(sessionAnswers, key) {
  if (!sessionAnswers || key === undefined || key === null) return '';
  const ans = sessionAnswers[key] ?? sessionAnswers[String(key)];
  if (!ans) return '';
  if (typeof ans === 'string') return ans;
  if (typeof ans === 'object') return ans.text || '';
  return '';
}
function countAnswered(sessionAnswers) {
  return Object.values(sessionAnswers || {}).filter(a => {
    const t = typeof a === 'string' ? a : a?.text;
    return t?.trim().length > 0;
  }).length;
}

// ── Toast notification ──────────────────────────────────────
function showToast(message, type = 'info') {
  const existing = document.getElementById('bb-toast');
  if (existing) existing.remove();
  const c = { success:{bg:'rgba(20,180,160,.15)',border:'rgba(20,180,160,.3)',color:'var(--teal)'},
               error:  {bg:'rgba(224,80,96,.12)', border:'rgba(224,80,96,.25)', color:'var(--danger-d)'},
               info:   {bg:'rgba(var(--ovl),.07)',border:'var(--bdr2)',        color:'var(--muted)'},
               warning:{bg:'rgba(232,144,74,.12)', border:'rgba(232,144,74,.25)',color:'var(--og)'} }[type] || {bg:'rgba(var(--ovl),.07)',border:'var(--bdr2)',color:'var(--muted)'};
  const toast = document.createElement('div');
  toast.id = 'bb-toast';
  toast.style.cssText = `position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:9999;background:${c.bg};border:1px solid ${c.border};color:${c.color};padding:10px 20px;border-radius:10px;font-size:13px;font-weight:600;font-family:var(--fb);box-shadow:0 4px 16px rgba(0,0,0,.2);animation:slideDown .2s ease;white-space:nowrap;max-width:calc(100vw - 48px);text-align:center;`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity='0'; toast.style.transition='opacity .3s'; setTimeout(() => toast.remove(), 300); }, 3000);
}

// ── Resume banner ───────────────────────────────────────────
async function checkForInterruptedExam() {
  const session = await ExamSession.getBestSession();
  if (!session || session.status !== 'in_progress') return false;

  // Discard sessions older than 24 hours
  const ageMs = Date.now() - new Date(session.lastSavedAt).getTime();
  if (ageMs > 24 * 60 * 60 * 1000) {
    await ExamSession.clearAll();
    return false;
  }

  const minutesAgo = ageMs / 60000;
  const timeStr = minutesAgo < 1 ? 'just now' : minutesAgo < 60 ? `${Math.round(minutesAgo)} minute${Math.round(minutesAgo)>1?'s':''} ago` : `${Math.round(minutesAgo/60)} hour${Math.round(minutesAgo/60)>1?'s':''} ago`;
  const answeredCount = countAnswered(session.answers);

  // Surfaced through the notification bell rather than a floating banner —
  // never auto-resume; let the user decide. It stays in the panel until they
  // explicitly Resume or Discard.
  setInterruptedExamNotice({ session, timeStr, answeredCount });
  return true;
}

// The one place that owns "there is an unfinished exam" state for the bell.
// Pass null to clear it.
function setInterruptedExamNotice(info) {
  window._interruptedExam = info || null;
  refreshNotifications();
}

async function resumeExamSession(sessionArg) {
  closeNotifPanel();
  // Accept a pre-loaded session or fetch the best available one
  const session = sessionArg || await ExamSession.getBestSession();
  if (!session || !session.questions?.length) {
    showToast('Session data not found.', 'error');
    setInterruptedExamNotice(null);   // nothing to resume — drop the notice
    return;
  }
  setInterruptedExamNotice(null);

  // ── Restore global exam state ──────────────────────────────
  window.activeExamSession = session;
  mockQs = session.questions;
  mockIdx = Math.max(0, Math.min(session.currentQuestion || 0, mockQs.length - 1));
  mockTimeLimitSecs = session.timeLimit || 0;
  mockLeft = mockTimeLimitSecs > 0 ? Math.max(0, mockTimeLimitSecs - (session.timeElapsed || 0)) : 0;

  // Rebuild mockAnswers array using INDEX as primary key (matches how saveMock() stores them).
  // Falls back to q.id for sessions saved by older code.
  mockAnswers = mockQs.map((q, i) => {
    return getAnswerText(session.answers, i)      // current format: answers[0], answers[1]…
        || getAnswerText(session.answers, q.id)   // legacy: answers['q_xxx']
        || '';
  });

  // ── Restore highlights and flags ────────────────────────────
  window.examHighlights = session.highlights || {};
  window.flaggedQuestions = session.flagged?.length ? new Set(session.flagged) : new Set();

  // ── Render exam UI ─────────────────────────────────────────
  showPage('mockbar');
  clearSidebarActive();
  document.getElementById('mockConfig').style.display  = 'none';
  document.getElementById('mockResults').style.display = 'none';
  document.getElementById('mockSession').classList.add('on');
  showSessionOverlay();
  document.getElementById('ms-of').textContent = `of ${mockQs.length}`;
  renderQMarkers();
  if (mockTimeLimitSecs > 0) { document.getElementById('ms-timer').style.display = 'flex'; runTimer(); }
  else document.getElementById('ms-timer').style.display = 'none';

  // renderMockQ() reads mockAnswers[mockIdx] to populate the textarea — now correct
  renderMockQ();
  ExamSession.startAutoSave(() => window.activeExamSession);

  // Retry textarea restore — renderMockQ uses innerHTML so the element may not be
  // in the DOM yet if the page transition hasn't completed
  let _restoreAttempts = 0;
  const _retryRestore = () => {
    const textarea = document.getElementById('mockBox');
    if (textarea) {
      const expected = mockAnswers[mockIdx] || '';
      if (expected && !textarea.value) {
        textarea.value = expected;
        console.log('Answer restored on retry:', expected.length, 'chars');
      }
    } else if (_restoreAttempts < 10) {
      _restoreAttempts++;
      setTimeout(_retryRestore, 100);
    }
  };
  setTimeout(_retryRestore, 100);

  const answeredCount = mockAnswers.filter(a => a?.trim()).length;
  showToast(`✓ Exam resumed — ${answeredCount} answer${answeredCount !== 1 ? 's' : ''} restored`, 'success');
}

async function discardExamSession() {
  // Cancelling leaves the notice in place — nothing to restore, since the
  // panel renders from window._interruptedExam rather than a DOM node we
  // just removed.
  if (!confirm('Discard the unfinished exam? Your answers will be lost.')) return;
  await ExamSession.clearAll();
  setInterruptedExamNotice(null);
  showToast('Exam session discarded.', 'info');
}

function confirmAbandonExam() {
  if (window.isSpeedDrill) {
    if (!confirm('Exit Speed Drill? Your current answer will be lost.')) return;
    if (mockTimer) clearInterval(mockTimer);
    ExamSession.stopAutoSave();
    ExamSession.clearAll().catch(() => {});
    const subj = window.activeExamSession?.subject || 'civil';
    window.isSpeedDrill = false;
    window.activeExamSession = null;
    document.getElementById('mockSession').classList.remove('on');
    hideSessionOverlay();
    navToSubject(subj, 'speeddrill');
    return;
  }
  if (!confirm('Exit exam? Your progress is saved and you can resume later.')) return;
  if (window.activeExamSession) {
    ExamSession.saveLocal(window.activeExamSession);
    ExamSession.saveServer(window.activeExamSession).catch(() => {});
  }
  ExamSession.stopAutoSave();
  hideSessionOverlay();
  const subj = window.activeExamSession?.subject || 'civil';
  navToSubject(subj, 'mockbar');
  // Exiting mid-exam saves progress — surface it in the bell so the student
  // can pick it back up.
  setTimeout(async () => {
    const session = ExamSession.loadLocal();
    if (session) {
      const answeredCount = Object.values(session.answers||{}).filter(a=>a.text?.trim()).length;
      setInterruptedExamNotice({ session, timeStr: 'just now', answeredCount });
    }
  }, 500);
}

const BAR_QUOTES = [
  "The law is reason, free from passion. — Aristotle",
  "Justice is the crowning glory of virtues. — Cicero",
  "The good lawyer is not the one who can tell you what the law is. It is the one who can tell you what the law will be.",
  "Every expert was once a beginner. Keep going.",
  "Success is the sum of small efforts, repeated day in and day out.",
  "The bar exam is not just a test of knowledge — it is a test of character and perseverance.",
  "Per aspera ad astra. Through hardship to the stars.",
  "Ang bawat pahina na iyong binabasa ngayon ay isang hakbang patungo sa iyong pangarap.",
  "You are closer than you think. Keep reviewing.",
  "The Philippines needs more great lawyers. Be one of them.",
  "Study hard in silence. Let your results make the noise.",
  "Maging abogado ng mahihirap at ng bansa."
];
function getMotivationalQuote() {
  const today = new Date().toDateString();
  const saved = sessionStorage.getItem('bb_quote');
  const savedDate = sessionStorage.getItem('bb_quote_date');
  if (saved && savedDate === today) return saved;
  const quote = BAR_QUOTES[Math.floor(Math.random() * BAR_QUOTES.length)];
  sessionStorage.setItem('bb_quote', quote);
  sessionStorage.setItem('bb_quote_date', today);
  return quote;
}

// ══════════════════════════════════
// LOADING SCREEN
// ══════════════════════════════════
const BB_LOADING_MESSAGES = [
  'Preparing your review session...',
  'Loading your progress...',
  'Fetching questions...',
  'Checking your access...',
  'Almost ready...',
  'Setting up your dashboard...',
];
let _bbMsgIdx = 0;
let _bbMsgInterval = null;

function startLoadingScreen() {
  const screen = document.getElementById('bb-loading-screen');
  const msg = document.getElementById('bb-loading-msg');
  if (!screen) return;
  screen.style.display = 'flex';
  screen.style.opacity = '1';
  screen.classList.remove('fade-out');
  _bbMsgInterval = setInterval(() => {
    _bbMsgIdx = (_bbMsgIdx + 1) % BB_LOADING_MESSAGES.length;
    if (msg) {
      msg.style.opacity = '0';
      setTimeout(() => {
        msg.textContent = BB_LOADING_MESSAGES[_bbMsgIdx];
        msg.style.opacity = '1';
      }, 200);
    }
  }, 1500);
}

function hideLoadingScreen() {
  const screen = document.getElementById('bb-loading-screen');
  if (!screen) return;
  if (_bbMsgInterval) { clearInterval(_bbMsgInterval); _bbMsgInterval = null; }
  const msg = document.getElementById('bb-loading-msg');
  if (msg) msg.textContent = 'Ready!';
  setTimeout(() => {
    screen.classList.add('fade-out');
    setTimeout(() => { screen.style.display = 'none'; }, 400);
  }, 300);
}

function setLoadingMsg(text) {
  const msg = document.getElementById('bb-loading-msg');
  if (msg) msg.textContent = text;
}

// ══════════════════════════════════
// INIT
// ══════════════════════════════════
async function init() {
  // data-theme is already on <html> from the pre-body script; this only points
  // the toggle's icon and labels at it. No _forceRestyle — nothing changed.
  syncThemeButton();
  loadLocalCache();
  // Show cached sidebar instantly while fresh data loads
  const cachedSB = sessionStorage.getItem('bb_sidebar_cache');
  if (cachedSB) {
    const list = document.getElementById('sbSubjectList');
    if (list) list.innerHTML = cachedSB;
  }
  renderSidebar();
  initSidebarToggleState();
  updateSidebarAdminVisibility();
  renderSubjectTracker();
  await loadKB();
  await applyTabSettings();
  // navToOverview() called by DOMContentLoaded after await init()
  subscribeToProgress();
  checkAPIStatus();
  preloadAllSyllabuses().catch(() => {});
}

async function checkAPIStatus(){
  try{
    const r=await fetch('/api/status');
    const d=await r.json();
    document.getElementById('apiBanner').style.display=d.apiOk?'none':'block';
  }catch(e){}
}
// ── Save exam on tab switch / minimize ─────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (window.activeExamSession?.status === 'in_progress') {
      saveMock(); // capture latest text from textarea
      window.activeExamSession.lastSavedAt = new Date().toISOString();
      ExamSession.saveLocal(window.activeExamSession);
      ExamSession.saveServer(window.activeExamSession).catch(e => console.warn('Server save failed:', e));
    }
  } else {
    // Tab returning — restore current textarea value if it got cleared
    if (window.activeExamSession?.status === 'in_progress' && mockQs.length) {
      setTimeout(() => {
        const textarea = document.getElementById('mockBox');
        if (textarea && mockAnswers[mockIdx] && !textarea.value) {
          textarea.value = mockAnswers[mockIdx];
        }
      }, 150);
    }
  }
});

// ── Warn before leaving page mid-exam ──────────────────────
// Only attach beforeunload when exam is active (prevents BFCache block otherwise)
function _attachBeforeUnload() {
  window.addEventListener('beforeunload', _beforeUnloadHandler);
}
function _detachBeforeUnload() {
  window.removeEventListener('beforeunload', _beforeUnloadHandler);
}
function _beforeUnloadHandler(e) {
  if (window.activeExamSession?.status === 'in_progress') {
    saveMock();
    ExamSession.saveLocal(window.activeExamSession);
    e.preventDefault();
    e.returnValue = 'Your exam is in progress. Your answers have been saved and you can resume when you return.';
    return e.returnValue;
  }
}

// ── pagehide: save state + close connections (BFCache-safe) ──
window.addEventListener('pagehide', () => {
  // Save exam state if active
  if (window.activeExamSession?.status === 'in_progress') {
    saveMock();
    ExamSession.saveLocal(window.activeExamSession);
  }
  // Close SSE connections so they don't block BFCache
  if (sseSource) { sseSource.close(); sseSource = null; }
});

// ── pageshow: restore state when page comes from BFCache ──
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    console.log('[bfcache] Page restored from cache');
    // Re-attach beforeunload if exam is active
    if (window.activeExamSession?.status === 'in_progress') _attachBeforeUnload();
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  startLoadingScreen();
  // Restore admin key from previous session so sidebar admin button shows
  const savedAdminKey = localStorage.getItem('bb_admin_key');
  if (savedAdminKey) {
    window._adminKey = savedAdminKey;
    adminKey = savedAdminKey;
  }
  setLoadingMsg('Verifying your session...');
  const hasSession = await checkExistingSession();
  if (!hasSession) {
    // Auth wall stays visible; fade it in so there's no flash
    hideLoadingScreen();
    const aw = document.getElementById('authWall');
    aw.style.display = 'flex';
    requestAnimationFrame(() => { aw.style.opacity = '1'; });
  }
  // On hard refresh with existing session, kick off the SR fetch concurrently
  // with init(). Without this the notification bell's due count never appears
  // on non-Progress views (onAuthSuccess doesn't run on this path, so
  // checkDueReviews would only fire as a side effect of eventually visiting
  // Progress). It also warms the SR cache the Progress page renders from; the
  // in-flight promise (window._srDueFetchPromise) lets Progress join it
  // rather than refetch.
  if (hasSession) checkDueReviews().catch(() => {});
  if (hasSession) loadFlashcardBundleOnBoot();
  setLoadingMsg('Loading your dashboard...');
  await init();
  // Restore last view or fall back to overview
  if (hasSession) {
    try {
      const lastView = sessionStorage.getItem('bb_last_view');
      const lastSubj = sessionStorage.getItem('bb_last_subject');
      const lastTab  = sessionStorage.getItem('bb_last_tab');
      if (lastView === 'subject' && lastSubj) {
        navToSubject(lastSubj, lastTab || 'flashcards');
      } else if (lastView === 'admin') {
        navToAdmin();
      } else if (lastView === 'progress') {
        navToProgress(lastTab || 'progress');
      } else if (lastView === 'custom') {
        navToCustom();
      } else {
        navToOverview();
      }
    } catch(e) {
      navToOverview();
    }
    hideLoadingScreen();
    checkForInterruptedExam().catch(() => {});
    resumePendingEvaluation().catch(() => {});
  } else {
    navToOverview();
  }
});

// ══════════════════════════════════
// LOCAL BROWSER CACHE
// ══════════════════════════════════
const LS_KEY = 'barbuddy_cache_v3';
const LS_VISITED = 'barbuddy_visited';

function loadLocalCache() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { CACHE = JSON.parse(raw); console.log('Cache loaded:', Object.values(CACHE).reduce((a,s)=>a+Object.keys(s).length,0), 'topics'); }
    const vis = localStorage.getItem(LS_VISITED);
    if (vis) VISITED.splice(0,0,...JSON.parse(vis));
  } catch(e) { console.warn('Cache load:', e.message); }
}

function saveLocalCache() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(CACHE)); } catch(e) { console.warn('Cache save:', e.message); }
}

function saveCacheItem(subj, topic, data) {
  if (!CACHE[subj]) CACHE[subj] = {};
  CACHE[subj][topic] = data;
  saveLocalCache();
}

function getCached(subj, topic) {
  return CACHE[subj]?.[topic] || null;
}

async function syncCacheFromServer(subject) {
  try {
    const url = subject ? `/api/content?subject=${encodeURIComponent(subject)}` : '/api/content';
    const r = await fetch(url);
    const serverContent = await r.json();
    let merged = 0;
    Object.entries(serverContent).forEach(([subj, topics]) => {
      Object.entries(topics).forEach(([topic, data]) => {
        if (!getCached(subj, topic)) { saveCacheItem(subj, topic, data); merged++; }
      });
    });
    if (merged > 0) { console.log('Synced', merged, 'topics from server'); buildQuizPool(subject||null); if (!subject) renderSyllabusTree(); }
  } catch(e) { console.warn('Sync:', e.message); }
}

// ══════════════════════════════════
// SERVER STATE
// ══════════════════════════════════
async function loadKB() {
  try {
    const r = await fetch('/api/kb');
    const kbData = await r.json();
    kbData._loaded = true;
    KB = kbData;
    window.kbState = KB; // keep window.kbState in sync
    updateKBIndicator();
    renderSyllabusTree();
    buildQuizPool();
    updateDash();
    renderPastBarList();
    refreshSidebarDots();
    // Sync any server content not in local cache
    if (KB.contentTopics > 0) syncCacheFromServer();
  } catch(e) { console.warn('KB load:', e.message); }
}

async function refreshKBState() {
  try {
    const r = await fetch('/api/kb', { headers: { 'x-session-token': sessionToken || '' } });
    if (!r.ok) { window.kbState = { pastBar: [], references: [], totalQuestions: 0 }; return; }
    const data = await r.json();
    data._loaded = true;
    KB = data;
    window.kbState = data;
    updateKBIndicator();
    refreshSidebarDots();
  } catch(e) {
    console.warn('refreshKBState failed:', e.message);
    if (!window.kbState) window.kbState = { pastBar: [], references: [], totalQuestions: 0 };
  }
}

// Previously also drove the topbar "Generating…" pill (#kbInd), which has been
// removed. KB.genState itself is untouched and still consumed by the pre-gen
// banner, the admin generation panel (updateGenProgressUI) and the syllabus
// tree's per-topic "generating now" marker — so nothing here unwinds that.
function updateKBIndicator() {
  // Mock source stats (null-safe — elements may not exist in new overview layout)
  const pbTotal = KB.pastBar?.reduce((a,p)=>a+(p.qCount||0),0)||0;
  const pgTotal = Object.values(CACHE).reduce((a,s)=>a+Object.keys(s).length,0);
  const mss = document.getElementById('mockSourceStats');
  if (mss) mss.innerHTML = `<span class="src-badge sb-real">📜 ${pbTotal} Past Bar Qs</span>`;
}

// ══════════════════════════════════
// SSE — LIVE GENERATION PROGRESS
// ══════════════════════════════════
function subscribeToProgress() {
  if (sseSource) sseSource.close();
  sseSource = new EventSource('/api/gen/progress');
  sseSource.onmessage = e => {
    const d = JSON.parse(e.data);
    updateGenProgressUI(d);
    if (d.finished || (!d.running && d.done > 0)) {
      // Generation done — sync cache
      setTimeout(() => syncCacheFromServer(), 1000);
      KB.genState = d;
      updateKBIndicator();
    }
  };
  sseSource.onerror = () => { sseSource.close(); setTimeout(subscribeToProgress, 5000); };
}

// Drives the sticky pre-generation banner + the admin generation panel from
// the /api/gen/progress SSE stream. Named for the generation pipeline
// specifically: an earlier `updateProgressUI(subject)` for subject progress
// bars shadowed this one, silently disabling the banner.
function updateGenProgressUI(d) {
  const banner = document.getElementById('pregenBanner');
  const adminPanel = document.getElementById('adminGenPanel');
  const adminDone  = document.getElementById('adminGenDone');

  if (d.running) {
    const pct = d.total ? Math.round(d.done/d.total*100) : 0;
    banner.classList.add('on');
    document.getElementById('pbFill').style.width = pct + '%';
    document.getElementById('pbDone').textContent = d.done;
    document.getElementById('pbTotal').textContent = d.total;
    document.getElementById('pbCur').textContent = d.current || '';
    if (adminPanel) { adminPanel.style.display='block'; adminDone.style.display='none'; }
    document.getElementById('gppFill').style.width = pct + '%';
    document.getElementById('gppDone').textContent = d.done;
    document.getElementById('gppTotal').textContent = d.total;
    document.getElementById('gppCur').textContent = d.current || '';
  } else {
    banner.classList.remove('on');
    if (d.finished) {
      if (adminPanel) { adminPanel.style.display='none'; adminDone.style.display='block'; }
      document.getElementById('adminGenDoneMeta').textContent = `${d.done} topics generated. ${d.errors || 0} errors.`;
    }
  }
}

// ══════════════════════════════════
// NAVIGATION
// ══════════════════════════════════

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('on'));
  document.getElementById('page-' + id)?.classList.add('on');
}

function clearSidebarActive() {
  document.querySelectorAll('.sb-overview-btn,.sb-subject,.sb-sub-item').forEach(el => el.classList.remove('active'));
  // Every top-level nav (Overview/Progress/Admin/Custom/subject) routes
  // through here, so this is the one place that reliably sees the user
  // leave Flashcards — reset their opt-out of sidebar auto-expand.
  _fcSidebarUserCollapsed = false;
  // Same reasoning for Progress teardown: only navToOverview used to stop the
  // countdown, so navigating to a subject or Admin left a 1s interval ticking
  // against hidden DOM and a Chart.js instance holding a detached canvas.
  // navToProgress re-starts both after this runs.
  _stopCountdown();
  _destroyProgressChart();
}

function updateBreadcrumb(subj, mode) {
  const bc = document.getElementById('breadcrumb');
  if (!bc) return;
  if (!subj) { bc.innerHTML = ''; return; }
  const subjInfo = ALL_SUBJS.find(s => s.key === subj);
  const subjName = subjInfo?.name || subj;
  const modeLabel = mode === 'learn' ? '📖 Learn' : mode === 'quiz' ? '✏️ Quiz' : mode === 'mockbar' ? '⏱ Mock Bar' : mode === 'speeddrill' ? '⚡ Speed Drill' : '';
  bc.innerHTML = `<span class="tb-bc-subj">${h(subjName)}</span>
    ${modeLabel ? `<span class="tb-bc-sep">›</span><span class="tb-bc-mode">${modeLabel}</span>` : ''}`;
}

function navToOverview() {
  currentSubject = null; currentMode = null;
  clearSidebarActive();   // stops the countdown + tears down the chart
  document.getElementById('sb-overview')?.classList.add('active');
  showPage('dashboard');
  updateBreadcrumb(null, null);
  renderOverview();
  sessionStorage.setItem('bb_last_view', 'overview');
  sessionStorage.removeItem('bb_last_subject');
  sessionStorage.removeItem('bb_last_tab');
}

function navToAdmin() {
  currentSubject = null; currentMode = null;
  clearSidebarActive();
  document.getElementById('sb-admin')?.classList.add('active');
  showPage('admin');
  updateBreadcrumb(null, null);
  sessionStorage.setItem('bb_last_view', 'admin');
  sessionStorage.removeItem('bb_last_subject');
  sessionStorage.removeItem('bb_last_tab');
  // Auto-unlock admin panel for users with server-granted isAdmin flag
  if (currentUser?.isAdmin && document.getElementById('adminLocked')?.style.display !== 'none') {
    autoUnlockAdminUI();
  }
}

function showAdminTab(tabName) {
  const panelMap = {
    overview:  'adminOverviewPanel',
    tabaccess: 'tabAccessControlPanel',
    syllabus:  'syllabusBuilderPanel',
    pastbar:   'adminPastBarPanel',
    kb:        'adminKbPanel',
    users:     'adminUserPanel',
    results:   'adminResultsPanel',
    questions: 'adminQuestionsPanel',
    sources:   'adminSourcesPanel',
    insights:  'adminInsightsPanel',
    flashcards:'adminFlashcardsPanel',
  };
  Object.values(panelMap).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const target = document.getElementById(panelMap[tabName]);
  if (target) target.style.display = 'block';
  document.querySelectorAll('.admin-tab-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.getElementById('adminTab-' + tabName);
  if (activeBtn) activeBtn.classList.add('active');
  if (tabName === 'users')     loadAdminUsers();
  if (tabName === 'results')   loadAdminResults();
  if (tabName === 'questions') loadAdminQuestions();
  if (tabName === 'sources')   loadAdminSources();
  if (tabName === 'syllabus')  loadSyllabusBuilder();
  if (tabName === 'kb')        refreshAdminKB();
  if (tabName === 'tabaccess') initTabControls();
  if (tabName === 'insights')  loadImproveItems();
  if (tabName === 'flashcards') loadFlashcardsAdmin();
  if (tabName === 'overview') {
    updateSyllabusStatus();
    const sovGrid = document.getElementById('subjectOverviewGrid');
    if (sovGrid) { sovGrid.style.display = ''; renderSubjectOverview(); }
    if (KB.genState?.running) { const p = document.getElementById('adminGenPanel'); if(p) p.style.display='block'; }
    else if (KB.genState?.finishedAt) { const d = document.getElementById('adminGenDone'); if(d) d.style.display='block'; }
    // Populate bar exam date card
    fetch('/api/settings').then(r => r.json()).then(s => {
      const dateVal = s.barExamDate || '2026-09-06';
      if (s.barExamDate) window._barExamDate = s.barExamDate;
      const inp = document.getElementById('adminBarExamDateInput');
      const disp = document.getElementById('adminBarExamDateDisplay');
      if (inp)  inp.value = dateVal;
      if (disp) disp.textContent = 'Current: ' + new Date(dateVal + 'T00:00:00+08:00').toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' });
    }).catch(() => {});
  }
}

function autoUnlockAdminUI() {
  const locked   = document.getElementById('adminLocked');
  const unlocked = document.getElementById('adminUnlocked');
  const status   = document.getElementById('adminStatus');
  if (locked)   locked.style.display   = 'none';
  if (unlocked) unlocked.style.display = 'block';
  if (status)   status.textContent     = '✓ Admin Access';
  refreshAdminKB();
  updateSidebarAdminVisibility();
  fetch('/api/settings').then(r => r.json()).then(s => {
    const btn = document.getElementById('regToggleBtn');
    if (btn) btn.textContent = s.registrationOpen ? 'Close Registration' : 'Open Registration';
  }).catch(() => {});
  showAdminTab('overview');
}

// ── Admin Flashcards tab (Session 2.2: .txt import authoring) ──
let _fcAdminSubject = 'civil';
let _fcTopicsCache  = [];
let _fcImportCards  = null; // cards array from last preview (for commit)

async function loadFlashcardsAdmin() {
  const subj = (document.getElementById('fc-subject-select')?.value) || _fcAdminSubject;
  _fcAdminSubject = subj;
  const topicsEl = document.getElementById('fc-topics-list');
  const sumEl    = document.getElementById('fc-topic-summary');
  if (topicsEl) topicsEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);font-size:13px;">Loading topics…</div>';

  try {
    const resp = await fetch('/api/admin/flashcards/status/' + encodeURIComponent(subj), {
      headers: { 'x-admin-key': window._adminKey || '' }
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Load failed');
    _fcTopicsCache = data.topics || [];
    renderFlashcardTopics();
    if (sumEl) {
      const n = data.totalSyllabusTopics || 0;
      const c = data.totalCards || 0;
      sumEl.textContent = `${n} leaf topic${n !== 1 ? 's' : ''} · ${c} total card${c !== 1 ? 's' : ''}`;
    }
  } catch(e) {
    if (topicsEl) topicsEl.innerHTML = `<div style="color:var(--danger);padding:20px;">Error: ${h(e.message)}</div>`;
  }
}

function renderFlashcardTopics() {
  const el = document.getElementById('fc-topics-list');
  if (!el) return;
  if (!_fcTopicsCache.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);font-size:13px;">No leaf topics found in this subject\'s syllabus. Add topics in the Syllabus Builder first.</div>';
    return;
  }
  el.innerHTML = _fcTopicsCache.map(t => {
    const count = t.cardCount || 0;
    const status = count > 0
      ? `<span style="color:var(--teal);">✓ ${count} card${count !== 1 ? 's' : ''}</span>`
      : `<span style="color:var(--muted);">no cards yet</span>`;
    const titleEsc = h(t.title).replace(/'/g, "&#39;");
    const pathEsc  = h(t.pathLabel || '').replace(/'/g, "&#39;");
    return `<div class="fc-topic-row fc-topic-row-clickable" onclick="openCardReview('${h(t.nodeId)}','${titleEsc}','${pathEsc}')">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:12px;">${h(t.title)}</div>
        <div style="font-size:10px;color:var(--muted);">${h(t.pathLabel || '')}</div>
      </div>
      <div style="font-size:11px;white-space:nowrap;margin-left:12px;">${status}</div>
    </div>`;
  }).join('');
}

// ── Card review panel (list/edit/delete — no inline add form) ───
let _fcReviewCards  = [];
let _fcReviewNodeId = null;

async function openCardReview(nodeId, topicTitle, pathLabel) {
  _fcReviewNodeId = nodeId;
  const panel   = document.getElementById('fc-review-panel');
  const titleEl = document.getElementById('fc-review-title');
  const subEl   = document.getElementById('fc-review-subtitle');
  const listEl  = document.getElementById('fc-review-cards');
  if (panel)   panel.style.display = '';
  if (titleEl) titleEl.textContent = 'Managing cards for: ' + topicTitle;
  if (subEl)   subEl.textContent   = pathLabel;
  if (listEl)  listEl.innerHTML    = '<div style="text-align:center;padding:40px;color:var(--muted);">Loading cards…</div>';

  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const resp = await fetch('/api/admin/flashcards/cards/' + encodeURIComponent(_fcAdminSubject) + '/' + encodeURIComponent(nodeId), {
      headers: { 'x-admin-key': window._adminKey || '' },
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Load failed');
    _fcReviewCards = data.cards || [];
    renderCardReview();
  } catch(e) {
    if (listEl) listEl.innerHTML = `<div style="color:var(--danger);padding:20px;">Error: ${h(e.message)}</div>`;
  }
}

function renderCardReview() {
  const listEl = document.getElementById('fc-review-cards');
  if (!listEl) return;
  if (!_fcReviewCards.length) {
    listEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);font-size:12px;">No cards for this topic yet. Import a .txt file to add cards.</div>';
    return;
  }
  listEl.innerHTML = _fcReviewCards.map(c => {
    const typeBadge = {
      definition:  '📖 Definition',
      elements:    '🔢 Elements',
      distinction: '⚖️ Distinction',
    }[c.card_type] || c.card_type;
    return `<div class="fc-review-card" data-card-id="${h(c.id)}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;">${typeBadge}</div>
      </div>
      <div style="margin-bottom:8px;">
        <div style="font-size:10px;color:var(--muted);margin-bottom:2px;">FRONT</div>
        <textarea class="fc-review-front" rows="2" style="width:100%;font-size:13px;padding:6px 8px;background:rgba(0,0,0,.2);border:1px solid var(--bdr2);border-radius:6px;color:var(--white);resize:vertical;box-sizing:border-box;">${h(c.front)}</textarea>
      </div>
      <div style="margin-bottom:8px;">
        <div style="font-size:10px;color:var(--muted);margin-bottom:2px;">BACK</div>
        <textarea class="fc-review-back" rows="4" style="width:100%;font-size:13px;padding:6px 8px;background:rgba(0,0,0,.2);border:1px solid var(--bdr2);border-radius:6px;color:var(--white);resize:vertical;box-sizing:border-box;">${h(c.back)}</textarea>
      </div>
      ${c.source_snippet ? `<div style="font-size:10px;color:var(--muted);margin-bottom:8px;padding:6px 8px;background:rgba(201,168,76,.06);border-left:2px solid var(--gold-l);">SOURCE: ${h(c.source_snippet)}</div>` : ''}
      <div style="display:flex;gap:6px;justify-content:flex-end;">
        <button class="btn-og" style="font-size:11px;padding:5px 10px;" onclick="saveReviewCard('${h(c.id)}')">💾 Save Edits</button>
        <button class="btn-og" style="font-size:11px;padding:5px 10px;background:rgba(224,112,128,.15);" onclick="rejectReviewCard('${h(c.id)}')">🗑️ Delete</button>
      </div>
    </div>`;
  }).join('');
}

async function saveReviewCard(cardId) {
  const card = document.querySelector(`[data-card-id="${cardId}"]`);
  if (!card) return;
  const front = card.querySelector('.fc-review-front').value;
  const back  = card.querySelector('.fc-review-back').value;
  try {
    const resp = await fetch('/api/admin/flashcards/card/' + encodeURIComponent(cardId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': window._adminKey || '' },
      body: JSON.stringify({ front, back }),
    });
    if (!resp.ok) throw new Error('Save failed');
    const c = _fcReviewCards.find(x => x.id === cardId);
    if (c) { c.front = front; c.back = back; }
    showToast('Saved', 'success');
  } catch(e) {
    showToast('Save error: ' + e.message, 'error');
  }
}

async function rejectReviewCard(cardId) {
  if (!confirm('Delete this card? This cannot be undone.')) return;
  try {
    const resp = await fetch('/api/admin/flashcards/card/' + encodeURIComponent(cardId), {
      method: 'DELETE',
      headers: { 'x-admin-key': window._adminKey || '' },
    });
    if (!resp.ok) throw new Error('Delete failed');
    showToast('Deleted', 'success');
    _fcReviewCards = _fcReviewCards.filter(c => c.id !== cardId);
    renderCardReview();
  } catch(e) {
    showToast('Delete error: ' + e.message, 'error');
  }
}

function closeCardReview() {
  const panel = document.getElementById('fc-review-panel');
  if (panel) panel.style.display = 'none';
  _fcReviewCards  = [];
  _fcReviewNodeId = null;
  loadFlashcardsAdmin(); // refresh status counts
}

// ── Flashcard .txt import (Session 2.2) ──────────────────────
async function downloadFlashcardTemplate() {
  const subj = _fcAdminSubject || document.getElementById('fc-subject-select')?.value;
  if (!subj) { showToast('Select a subject first', 'error'); return; }
  try {
    const url = '/api/admin/flashcards/template/' + encodeURIComponent(subj);
    const resp = await fetch(url, { headers: { 'x-admin-key': window._adminKey || '' } });
    if (!resp.ok) throw new Error('Template fetch failed: ' + resp.status);
    const blob = await resp.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `flashcards-${subj}-template.txt`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch(e) {
    showToast('Template error: ' + e.message, 'error');
  }
}

async function previewFlashcardTxt(event) {
  const file = event.target.files?.[0];
  event.target.value = ''; // allow re-upload of same file
  if (!file) return;
  const subj = _fcAdminSubject;
  if (!subj) { showToast('Select a subject first', 'error'); return; }

  const fd = new FormData();
  fd.append('txt', file);

  showToast('Uploading and parsing…', 'info');
  try {
    const resp = await fetch('/api/admin/flashcards/import/' + encodeURIComponent(subj), {
      method: 'POST',
      headers: { 'x-admin-key': window._adminKey || '' },
      body: fd,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Parse failed');

    _fcImportCards = data.cards || [];
    openFcImportModal(data);
  } catch(e) {
    showToast('Import parse failed: ' + e.message, 'error');
  }
}

function openFcImportModal(preview) {
  const modal = document.getElementById('fc-import-modal');
  if (!modal) return;

  const summaryEl = document.getElementById('fc-import-summary');
  const errorsEl = document.getElementById('fc-import-errors');
  const cardsEl = document.getElementById('fc-import-cards');
  const commitBtn = document.getElementById('fc-import-commit-btn');

  const hasFatal = (preview.errors || []).some(e => e.severity === 'fatal');
  const warningCount = (preview.errors || []).filter(e => e.severity === 'warning').length;
  const errorCount = (preview.errors || []).filter(e => e.severity === 'error').length;
  const fatalCount = (preview.errors || []).filter(e => e.severity === 'fatal').length;

  summaryEl.innerHTML = `
    <div><strong>${h(preview.filename)}</strong> (${_fcFmtBytes(preview.sizeBytes)})</div>
    <div style="margin-top:6px;">
      ${preview.stats.totalCards} valid card${preview.stats.totalCards !== 1 ? 's' : ''} ready to import ·
      ${preview.stats.topicsCovered} topic${preview.stats.topicsCovered !== 1 ? 's' : ''} matched ·
      ${preview.stats.topicsUnmatched > 0 ? `<span style="color:var(--danger);">${preview.stats.topicsUnmatched} topic path${preview.stats.topicsUnmatched !== 1 ? 's' : ''} unmatched</span>` : '0 unmatched'}
    </div>
    ${fatalCount > 0 ? `<div style="color:var(--danger);margin-top:6px;"><strong>⚠ ${fatalCount} fatal error${fatalCount !== 1 ? 's' : ''}</strong> — fix and re-upload.</div>` : ''}
    ${errorCount > 0 ? `<div style="color:#d4a843;margin-top:4px;">⚠ ${errorCount} error${errorCount !== 1 ? 's' : ''} (affected cards are skipped).</div>` : ''}
    ${warningCount > 0 ? `<div style="color:var(--muted);margin-top:4px;">${warningCount} warning${warningCount !== 1 ? 's' : ''}.</div>` : ''}
  `;

  if ((preview.errors || []).length) {
    errorsEl.style.display = '';
    errorsEl.innerHTML = preview.errors.map(e => {
      const color = e.severity === 'fatal' ? 'var(--danger)' : e.severity === 'error' ? '#d4a843' : 'var(--muted)';
      const label = e.severity === 'fatal' ? 'FATAL' : e.severity.toUpperCase();
      return `<div style="margin-bottom:4px;"><span style="color:${color};font-weight:700;">[${label}]</span> <span style="color:var(--muted);">line ${e.line}:</span> ${h(e.message)}</div>`;
    }).join('');
  } else {
    errorsEl.style.display = 'none';
    errorsEl.innerHTML = '';
  }

  if (_fcImportCards && _fcImportCards.length) {
    const byTopic = {};
    for (const c of _fcImportCards) {
      if (!byTopic[c.nodeId]) byTopic[c.nodeId] = { path: c.nodePath, cards: [] };
      byTopic[c.nodeId].cards.push(c);
    }
    cardsEl.innerHTML = Object.entries(byTopic).map(([nodeId, grp]) => `
      <div style="margin-bottom:10px;">
        <div style="font-size:11px;font-weight:700;color:var(--gold-l);margin-bottom:3px;">${h(grp.path)} <span style="color:var(--muted);font-weight:400;">(${grp.cards.length})</span></div>
        ${grp.cards.map(c => `<div style="font-size:11px;color:var(--muted);margin-left:10px;margin-bottom:2px;">• <span style="color:var(--white);">${h(c.card_type)}</span>: ${h(c.front.slice(0, 80))}${c.front.length > 80 ? '…' : ''}</div>`).join('')}
      </div>
    `).join('');
  } else {
    cardsEl.innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px;font-size:12px;">No valid cards found.</div>';
  }

  if (hasFatal || !preview.stats.totalCards) {
    commitBtn.disabled = true;
    commitBtn.style.opacity = '0.4';
    commitBtn.style.cursor = 'not-allowed';
  } else {
    commitBtn.disabled = false;
    commitBtn.style.opacity = '';
    commitBtn.style.cursor = '';
  }

  modal.style.display = 'flex';
}

function closeFcImportModal() {
  const modal = document.getElementById('fc-import-modal');
  if (modal) modal.style.display = 'none';
  _fcImportCards = null;
}

async function commitFlashcardImport() {
  if (!_fcImportCards || !_fcImportCards.length) {
    showToast('No cards to import', 'error');
    return;
  }
  const subj = _fcAdminSubject;
  const modeEl = document.querySelector('input[name="fc-import-mode"]:checked');
  const mode = modeEl ? modeEl.value : 'append';

  // Confirm destructive modes
  if (mode === 'full_replace') {
    if (!confirm(`⚠️ FULL REPLACE will delete ALL existing flashcards for ${subj} and import ${_fcImportCards.length} new cards. Continue?`)) return;
  } else if (mode === 'replace_per_topic') {
    const touchedTopics = new Set(_fcImportCards.map(c => c.nodeId)).size;
    if (!confirm(`Replace cards for ${touchedTopics} topic${touchedTopics !== 1 ? 's' : ''} in this file (delete existing, insert new)? Topics not in the file are untouched.`)) return;
  }

  const btn = document.getElementById('fc-import-commit-btn');
  btn.disabled = true;
  btn.textContent = 'Importing…';
  try {
    const resp = await fetch('/api/admin/flashcards/import/' + encodeURIComponent(subj) + '/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': window._adminKey || '' },
      body: JSON.stringify({ cards: _fcImportCards, mode }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Commit failed');

    if (data.insertErrors && data.insertErrors.length) {
      showToast(`Imported ${data.inserted} (${data.insertErrors.length} chunk failures)`, 'info');
    } else {
      const extras = [];
      if (data.deleted) extras.push(`${data.deleted} deleted`);
      showToast(`Imported ${data.inserted} card${data.inserted !== 1 ? 's' : ''}${extras.length ? ' · ' + extras.join(' · ') : ''}`, 'success');
    }
    closeFcImportModal();
    loadFlashcardsAdmin(); // refresh topic card counts
  } catch(e) {
    showToast('Commit failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✅ Commit Import';
  }
}

// Minimal byte formatter for preview modal
function _fcFmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

// ── Bar Exam Countdown ─────────────────────────────────────────
const _CD_QUOTES = [
  "Every day counts. Stay consistent.",
  "The bar exam rewards preparation, not cramming.",
  "One question at a time. One day at a time.",
  "Your future clients are counting on you.",
  "Discipline today, celebration in November.",
  "The hard work you do now is the answer you write then.",
  "Pass the bar. Change lives — starting with yours.",
];
let _countdownTimer = null;

function _getBarExamDate() {
  const d = window._barExamDate || '2026-09-06';
  return new Date(d + 'T00:00:00+08:00');
}

function _startCountdown() {
  if (_countdownTimer) clearInterval(_countdownTimer);
  function _tick() {
    const diff = _getBarExamDate().getTime() - Date.now();
    const dEl = document.getElementById('cd-days');
    const hEl = document.getElementById('cd-hours');
    const mEl = document.getElementById('cd-mins');
    const sEl = document.getElementById('cd-secs');
    if (!dEl) { clearInterval(_countdownTimer); _countdownTimer = null; return; }
    if (diff <= 0) {
      clearInterval(_countdownTimer); _countdownTimer = null;
      const wrap = document.getElementById('countdown-section');
      if (wrap) wrap.innerHTML = '<div style="text-align:center;padding:16px;font-size:14px;color:var(--teal);">🎉 The Bar Exam has concluded. Results will be announced soon. You\'ve done your best!</div>';
      return;
    }
    const days  = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const mins  = Math.floor((diff % 3600000)  / 60000);
    const secs  = Math.floor((diff % 60000)    / 1000);
    dEl.textContent = days;
    hEl.textContent = String(hours).padStart(2, '0');
    mEl.textContent = String(mins).padStart(2, '0');
    sEl.textContent = String(secs).padStart(2, '0');
  }
  _tick();
  _countdownTimer = setInterval(_tick, 1000);
}

function _stopCountdown() {
  if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
}

function _renderCountdownWidget() {
  const diff = _getBarExamDate().getTime() - Date.now();
  if (diff <= 0) {
    return `<div class="prog-section" id="countdown-section" style="text-align:center;">
      <div style="font-size:14px;color:var(--teal);">🎉 The Bar Exam has concluded. Results will be announced soon. You've done your best!</div>
    </div>`;
  }
  const quote = _CD_QUOTES[Math.floor(Date.now() / 86400000) % _CD_QUOTES.length];
  return `<div class="prog-section cd-widget" id="countdown-section">
    <div class="cd-title">⚖️ Philippine Bar Exam 2026</div>
    <div class="cd-grid">
      <div class="cd-unit"><div class="cd-num" id="cd-days">--</div><div class="cd-lbl">DAYS</div></div>
      <div class="cd-sep">:</div>
      <div class="cd-unit"><div class="cd-num" id="cd-hours">--</div><div class="cd-lbl">HRS</div></div>
      <div class="cd-sep">:</div>
      <div class="cd-unit"><div class="cd-num" id="cd-mins">--</div><div class="cd-lbl">MINS</div></div>
      <div class="cd-sep">:</div>
      <div class="cd-unit"><div class="cd-num" id="cd-secs">--</div><div class="cd-lbl">SECS</div></div>
    </div>
    <div class="cd-quote">"${h(quote)}"</div>
  </div>`;
}

async function saveBarExamDate() {
  const input  = document.getElementById('adminBarExamDateInput');
  const status = document.getElementById('adminBarExamDateStatus');
  const dateVal = input?.value;
  if (!dateVal) { if (status) status.innerHTML = '<span style="color:var(--danger);">⚠️ Please select a date.</span>'; return; }
  if (status) status.innerHTML = '<span style="color:var(--muted);">Saving…</span>';
  try {
    const r = await fetch('/api/admin/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey, 'x-session-token': sessionToken || '' },
      body: JSON.stringify({ key: 'bar_exam_date', value: dateVal }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Failed to save');
    window._barExamDate = dateVal;
    const fmt = new Date(dateVal + 'T00:00:00+08:00').toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' });
    const display = document.getElementById('adminBarExamDateDisplay');
    if (display) display.textContent = 'Current: ' + fmt;
    if (status) status.innerHTML = '<span style="color:var(--teal);">✅ Bar exam date updated.</span>';
    setTimeout(() => { if (status) status.innerHTML = ''; }, 4000);
  } catch(e) {
    if (status) status.innerHTML = `<span style="color:var(--danger);">⚠️ ${h(e.message)}</span>`;
  }
}

// ── Spaced Repetition helpers ─────────────────────────────────
function isSREnabled() {
  const globalOk = window.TAB_SETTINGS?.spaced_repetition !== false;
  const userOk = currentUser?.spacedRepEnabled !== false;
  return globalOk && userOk;
}
function isCustomSubjectEnabled() {
  const globalOk = window.TAB_SETTINGS?.subjects?.custom?.mockbar !== false;
  const userOk = currentUser?.customSubjectEnabled !== false;
  return globalOk && userOk;
}
const _SR_SUBJ_NAMES = {civil:'Civil Law',criminal:'Criminal Law',political:'Political Law',
  labor:'Labor Law',commercial:'Commercial Law',taxation:'Taxation Law',
  remedial:'Remedial Law',ethics:'Legal Ethics',custom:'Custom',mixed:'Mixed'};

// Due counts grouped by subject, ordered most-urgent first (overdue, then
// volume). The single source for every per-subject due breakdown — the
// notification panel and the Progress widget both render from this.
function _srDueBySubject(dueItems) {
  const map = {};
  (Array.isArray(dueItems) ? dueItems : []).forEach(i => {
    const key = i.subject || 'mixed';
    if (!map[key]) map[key] = { subject: key, total: 0, overdue: 0 };
    map[key].total++;
    if ((i.daysOverdue || 0) > 0) map[key].overdue++;
  });
  return Object.values(map).sort((a, b) => b.overdue - a.overdue || b.total - a.total);
}

const _SR_SUBJ_COLORS = {civil:'var(--c-civil)',criminal:'var(--c-criminal)',political:'var(--c-political)',
  labor:'var(--c-labor)',commercial:'var(--c-commercial)',taxation:'var(--c-taxation)',
  remedial:'var(--c-remedial)',ethics:'var(--c-ethics)',custom:'var(--c-custom)',mixed:'var(--muted)'};

// One tappable row per subject: name, due count, overdue count, and a review
// affordance. Replaces both the sidebar "X due" badges and the single
// all-subjects "Start Review Session" button.
function _renderSRSubjectRows(dueItems) {
  return _srDueBySubject(dueItems).map(({ subject, total, overdue }) => `
    <button class="sr-subj-row" data-sr-review="${h(subject)}"
            onclick="startReviewSession('${h(subject)}')"
            title="Review ${total} due question${total!==1?'s':''} in ${h(_SR_SUBJ_NAMES[subject] || subject)}">
      <span class="sr-subj-dot" style="background:${_SR_SUBJ_COLORS[subject] || 'var(--muted)'}"></span>
      <span class="sr-subj-name">${h(_SR_SUBJ_NAMES[subject] || subject)}</span>
      <span class="sr-subj-counts">
        <span class="sr-subj-due">${total} due</span>
        ${overdue > 0 ? `<span class="sr-subj-overdue">${overdue} overdue</span>` : ''}
      </span>
      <span class="sr-subj-go" aria-hidden="true">→</span>
    </button>`).join('');
}

// ── Notification bell ─────────────────────────────────────────
// Replaces the old full-width #sr-review-banner. The bell carries a count
// badge; the panel holds the actual notifications plus the student's reminder
// toggle. Nothing overlays the page and the count persists until the reviews
// are actually done, instead of vanishing on a one-time Dismiss.

// ── Theme ─────────────────────────────────────────────────────
// Resolves a CSS custom property to its computed value. Canvas (Chart.js)
// can't consume var() — it needs a real colour string at construction.
function _cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

// data-theme is set on <html> pre-body (see #sidebar-state in index.html) so
// the first paint is already correct. This only handles the runtime switch.
// Stored per device in localStorage; with nothing stored we follow the OS.
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

// Point the button at whatever theme is actually active. Called at boot too:
// the pre-body script sets data-theme before any JS runs, so without this the
// button keeps the icon hardcoded in the markup and can contradict the page.
function syncThemeButton() {
  const light = currentTheme() === 'light';
  const btn = document.getElementById('themeToggle');
  const ic  = document.getElementById('themeToggleIc');
  // The icon shows the theme you're currently in, the tooltip what you'd get.
  if (ic)  ic.textContent = light ? '☀️' : '🌙';
  if (btn) {
    btn.setAttribute('aria-checked', String(light));
    btn.title = light ? 'Switch to night mode' : 'Switch to light mode';
    btn.setAttribute('aria-label', btn.title);
  }
}

function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  syncThemeButton();
  _forceRestyle();
  // Chart.js bakes colours in at construction, so an open chart has to be
  // rebuilt to pick up the new palette.
  if (_progScoreChart && document.getElementById('page-progress')?.classList.contains('on')) {
    renderProgressPage();
  }
}

// Blink does not re-resolve a var()-dependent property on an element that
// carries its own inline custom property when an *inherited* custom property
// changes further up. The sidebar buttons set --subject-color inline and the
// overview cards set --subj-color, so on a theme switch their --txt2-rgb
// updated but the color built from it kept its old value — dark text left on
// the dark sidebar. Detaching the root from the render tree and reattaching
// forces a clean recompute. Only runs on an explicit toggle, so the reflow
// cost is irrelevant.
function _forceRestyle() {
  const el = document.documentElement;
  const prev = el.style.display;
  el.style.display = 'none';
  void el.offsetHeight;            // flush
  el.style.display = prev;
}

function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('bb_theme', next); } catch(_) {}
  applyTheme(next);
}

// No prefers-color-scheme listener: night mode is the product default and
// light is opt-in, so the OS switching themes must not move the app off dark
// for someone who never chose light.

function remindersEnabled() {
  return currentUser?.reviewRemindersEnabled !== false;
}

// The set of notifications is derived, not stored — currently an unfinished
// exam and due reviews. Add cases here as new notification kinds appear.
function _collectNotifications() {
  const out = [];

  // Unfinished exam first — it's time-boxed (sessions expire after 24h) and
  // represents work already done, so it outranks anything else in the panel.
  // Deliberately NOT gated by remindersEnabled(): that toggle is scoped to
  // due-review reminders, and silencing those must never hide unsaved work.
  const ex = window._interruptedExam;
  if (ex?.session) {
    const total = ex.session.totalQuestions || ex.session.questions?.length || 0;
    const pct = total > 0 ? Math.round(ex.answeredCount / total * 100) : 0;
    out.push({
      id: 'exam-resume', icon: '⚡', weight: 1,
      msg: `Unfinished <strong style="color:var(--gold-l);">${h(ex.session.subjectName || ex.session.subject || 'exam')}</strong> exam.`,
      sub: `${ex.answeredCount}/${total} answered · interrupted ${ex.timeStr}`,
      bar: pct,
      buttons: [
        { label: '▶ Resume', cls: 'notif-btn-primary', fn: 'resumeExamSession()' },
        { label: 'Discard',  cls: 'notif-btn-ghost',   fn: 'discardExamSession()' },
      ],
    });
  }

  const due = Array.isArray(window._srDueItems) ? window._srDueItems : [];
  if (isSREnabled() && remindersEnabled() && due.length) {
    const overdue = due.filter(i => (i.daysOverdue || 0) > 0).length;
    out.push({
      id: 'sr-due', icon: '🧠',
      msg: `<strong style="color:var(--gold-l);">${due.length}</strong> question${due.length!==1?'s':''} due for review.`,
      sub: overdue > 0 ? `${overdue} overdue · pick a subject to start` : 'Pick a subject to start',
      // Per-subject rows instead of one all-subjects button, so a student can
      // clear Civil Law without being handed every other subject too.
      rows: _renderSRSubjectRows(due),
    });
  }
  return out;
}

function refreshNotifications() {
  const wrap  = document.getElementById('notifWrap');
  const bell  = document.getElementById('notifBell');
  const badge = document.getElementById('notifBadge');
  if (!wrap || !bell || !badge) return;
  // Bell only exists for signed-in users
  wrap.style.display = (sessionToken && currentUser) ? '' : 'none';

  const items = _collectNotifications();
  // Due reviews count as their question total (the number a student cares
  // about); everything else counts as one item.
  const count = items.reduce((n, i) => n + (i.id === 'sr-due' ? (window._srDueItems?.length || 0) : 1), 0);
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.style.display = '';
    bell.classList.add('has-unread');
    bell.title = `${count} item${count !== 1 ? 's' : ''} need${count === 1 ? 's' : ''} your attention`;
  } else {
    badge.style.display = 'none';
    bell.classList.remove('has-unread');
    bell.title = 'Notifications';
  }
  if (document.getElementById('notifPanel')?.classList.contains('open')) renderNotifPanel();
}

function renderNotifPanel() {
  const panel = document.getElementById('notifPanel');
  if (!panel) return;
  const items = _collectNotifications();
  const on = remindersEnabled();

  const body = items.length
    ? items.map(i => `
        <div class="notif-item">
          <div class="notif-ic">${i.icon}</div>
          <div class="notif-txt">
            <div class="notif-msg">${i.msg}</div>
            ${i.sub ? `<div class="notif-sub">${h(i.sub)}</div>` : ''}
            ${typeof i.bar === 'number'
              ? `<div class="notif-bar"><div class="notif-bar-fill" style="width:${i.bar}%"></div></div>` : ''}
            ${i.rows ? `<div class="sr-subj-list">${i.rows}</div>` : ''}
            ${i.buttons
              ? `<div class="notif-btn-row">${i.buttons.map(b =>
                  // stopPropagation: Discard re-renders this panel, detaching
                  // the clicked button — without it the bubbled click reaches
                  // _notifOutsideClick with a target that has no ancestors and
                  // reads as an outside click.
                  `<button class="${b.cls}" onclick="event.stopPropagation();${b.fn}">${b.label}</button>`).join('')}</div>` : ''}
            ${i.action ? `<button class="notif-act" onclick="closeNotifPanel();${i.action.fn}">${i.action.label}</button>` : ''}
          </div>
        </div>`).join('')
    : `<div class="notif-empty">
         <div class="notif-empty-ic">${on ? '✅' : '🔕'}</div>
         ${on ? "You're all caught up — no reviews due today."
              : 'Review reminders are off. Turn them back on below to be notified when questions are due.'}
       </div>`;

  panel.innerHTML = `
    <div class="notif-head"><div class="notif-title">Notifications</div></div>
    <div class="notif-body">${body}</div>
    <div class="notif-foot">
      <div class="notif-foot-lbl">Review reminders<br><span style="opacity:.92;">Notify me when questions are due</span></div>
      <button class="notif-switch" id="notifReminderSwitch" role="switch"
              aria-checked="${on}" aria-label="Review reminders"
              onclick="toggleReviewReminders(event)"></button>
    </div>`;
  // Content height changes with the notification count — re-anchor so the
  // panel doesn't drift off the bell after a re-render.
  if (panel.classList.contains('open')) _positionNotifPanel();
}

// The panel is body-level and fixed, so it has to be positioned under the bell
// manually. Right-aligned to the bell, clamped to stay on screen.
function _positionNotifPanel() {
  const panel = document.getElementById('notifPanel');
  const bell  = document.getElementById('notifBell');
  if (!panel || !bell) return;
  const b = bell.getBoundingClientRect();
  const w = panel.offsetWidth || 330;
  const left = Math.max(10, Math.min(b.right - w, window.innerWidth - w - 10));
  panel.style.left = left + 'px';
  panel.style.top  = (b.bottom + 9) + 'px';
}

function toggleNotifPanel(ev) {
  ev?.stopPropagation();
  const panel = document.getElementById('notifPanel');
  if (!panel) return;
  if (panel.classList.contains('open')) { closeNotifPanel(); return; }
  renderNotifPanel();
  panel.classList.add('open');
  _positionNotifPanel();
  document.getElementById('notifBell')?.setAttribute('aria-expanded', 'true');
  // Close on outside click / Escape. Registered late so this click doesn't
  // immediately close the panel it just opened.
  setTimeout(() => {
    document.addEventListener('click', _notifOutsideClick);
    document.addEventListener('keydown', _notifEscape);
    window.addEventListener('resize', _positionNotifPanel);
  }, 0);
}

function closeNotifPanel() {
  const panel = document.getElementById('notifPanel');
  if (!panel) return;
  panel.classList.remove('open');
  document.getElementById('notifBell')?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', _notifOutsideClick);
  document.removeEventListener('keydown', _notifEscape);
  window.removeEventListener('resize', _positionNotifPanel);
}

function _notifOutsideClick(e) {
  // Both targets matter: the panel is body-level, not a descendant of the
  // wrap, so clicks inside it (e.g. the reminders switch) would otherwise
  // read as "outside" and close the panel out from under the user.
  if (!e.target.closest('#notifWrap') && !e.target.closest('#notifPanel')) closeNotifPanel();
}
function _notifEscape(e) {
  if (e.key === 'Escape') closeNotifPanel();
}

async function toggleReviewReminders(ev) {
  // Must stop here: renderNotifPanel() below replaces the panel's innerHTML,
  // detaching this very button. By the time the click reaches the document,
  // e.target has no ancestors, so _notifOutsideClick's closest('#notifPanel')
  // returns null and the panel closes out from under the user.
  ev?.stopPropagation();
  const sw = document.getElementById('notifReminderSwitch');
  const next = !remindersEnabled();
  // Optimistic: flip immediately, roll back if the save fails.
  if (currentUser) currentUser.reviewRemindersEnabled = next;
  if (sw) { sw.setAttribute('aria-checked', String(next)); sw.disabled = true; }
  renderNotifPanel();
  refreshNotifications();
  try {
    const r = await fetch('/api/user/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify({ reviewRemindersEnabled: next }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'save failed');
    try {
      const cached = JSON.parse(localStorage.getItem('bb_user') || 'null');
      if (cached) { cached.reviewRemindersEnabled = next; localStorage.setItem('bb_user', JSON.stringify(cached)); }
    } catch(_) {}
    showToast(next ? 'Review reminders on' : 'Review reminders off', 'success');
  } catch(e) {
    if (currentUser) currentUser.reviewRemindersEnabled = !next;   // roll back
    renderNotifPanel();
    refreshNotifications();
    showToast('Could not save that preference — please try again', 'error');
  } finally {
    const sw2 = document.getElementById('notifReminderSwitch');
    if (sw2) sw2.disabled = false;
  }
}

// How long a cached SR due/stats payload is considered fresh enough to render
// without a background refetch. SR state only changes when the user finishes a
// session, and endMockSession() invalidates explicitly, so this can be generous.
const SR_CACHE_TTL_MS = 60000;

function _srCacheIsFresh() {
  return Array.isArray(window._srDueItems)
    && window._srStats
    && (Date.now() - (window._srCacheAt || 0)) < SR_CACHE_TTL_MS;
}

// Drop the SR cache so the next read refetches. Called after a session changes
// spaced-repetition state.
function invalidateSRCache() {
  window._srCacheAt = 0;
}

async function checkDueReviews() {
  if (!sessionToken) return;
  // Share the in-flight fetch so concurrent callers (e.g. the Progress page
  // rendering on first load) can await the same promise instead of firing a
  // duplicate network round-trip.
  if (window._srDueFetchPromise) return window._srDueFetchPromise;
  window._srDueFetchPromise = (async () => {
    try {
      // summary=1 — the badges, banner and Progress due widget only read
      // subject/lastScore/daysOverdue. The full payload (question text, model
      // answers, 5 alternatives + their ALAC blobs per row) is fetched lazily
      // by startReviewSession() when the user actually starts reviewing.
      const [dueResp, statsResp] = await Promise.all([
        fetch('/api/spaced-repetition/due?summary=1', { headers: { 'x-session-token': sessionToken } }),
        fetch('/api/spaced-repetition/stats',         { headers: { 'x-session-token': sessionToken } }),
      ]);
      const dueItems = dueResp.ok   ? await dueResp.json()   : [];
      // Keep the stats body — the Progress page reads this cache instead of
      // firing its own duplicate round-trip.
      const srStats  = statsResp.ok ? await statsResp.json() : null;
      window._srDueItems = dueItems;
      window._srStats    = srStats;
      window._srCacheAt  = Date.now();
      // Per-subject counts are derived on demand by _srDueBySubject now that
      // the sidebar badges are gone — no separate _srDueCounts map to keep
      // in sync.
      refreshNotifications();
    } catch(e) { /* non-critical */ }
    finally {
      // Leave cache populated but allow subsequent explicit calls to refetch
      window._srDueFetchPromise = null;
    }
  })();
  return window._srDueFetchPromise;
}

// Fetch the full due payload (with question bodies). The cached list from
// checkDueReviews is summary-only, so this runs when the user starts a review.
async function _fetchFullDueItems() {
  const r = await fetch('/api/spaced-repetition/due', { headers: { 'x-session-token': sessionToken } });
  if (!r.ok) throw new Error('Failed to load review questions');
  const items = await r.json();
  return Array.isArray(items) ? items : [];
}

// `subject` scopes the session to one subject's due questions. Omit it to
// review everything that's due (kept for any caller that wants the old
// behaviour; the UI now always passes a subject).
async function startReviewSession(subject) {
  if (!isSREnabled()) { showToast('Spaced Repetition is currently disabled', 'info'); return; }
  let dueItems = window._srDueItems || [];
  const inScope = it => !subject || it.subject === subject;
  const subjLabel = subject ? (_SR_SUBJ_NAMES[subject] || subject) : '';

  if (!dueItems.filter(inScope).length) {
    showToast(subject ? `No ${subjLabel} reviews due right now` : 'No reviews due right now', 'info');
    return;
  }

  // The cached list is metadata-only — pull the real questions now. Disable
  // every review row while it's in flight so a double-click can't launch two
  // sessions, and show the spinner on the row that was actually clicked.
  if (!dueItems.some(item => item.question?.q)) {
    if (window._srFullFetchInFlight) return;
    window._srFullFetchInFlight = true;
    const rows = [...document.querySelectorAll('[data-sr-review]')];
    const clicked = rows.find(b => b.dataset.srReview === subject);
    const clickedHtml = clicked?.innerHTML;
    rows.forEach(b => { b.disabled = true; });
    if (clicked) clicked.innerHTML = '<span class="sr-subj-loading">⏳ Loading questions…</span>';
    try {
      dueItems = await _fetchFullDueItems();
      window._srDueItems = dueItems;
    } catch(e) {
      showToast('Could not load review questions — please try again', 'error');
      return;
    } finally {
      window._srFullFetchInFlight = false;
      rows.forEach(b => { b.disabled = false; });
      if (clicked && clickedHtml) clicked.innerHTML = clickedHtml;
    }
    if (!dueItems.filter(inScope).length) {
      showToast(subject ? `No ${subjLabel} reviews due right now` : 'No reviews due right now', 'info');
      return;
    }
  }

  const scoped = dueItems.filter(inScope);
  const questions = scoped.map(item => item.question).filter(q => q?.q);
  if (!questions.length) { showToast('Question data unavailable', 'error'); return; }
  // Store previous scores for comparison in results display
  window._srReviewData = {};
  scoped.forEach(item => {
    if (item.question?.id) window._srReviewData[item.question.id] = item.lastScore || 0;
  });
  // Lets the results screen name the subject that was reviewed.
  window._srReviewSubject = subject || null;
  window.isReviewSession = true;
  window.isSpeedDrill    = false;
  closeNotifPanel();
  clearSidebarActive();
  document.getElementById('sb-progress')?.classList.add('active');
  showPage('mockbar');
  updateBreadcrumb(null, null);
  startMockSession(questions, 0, null); // 0 = no time limit
}

function _renderSRDueWidget(dueItems) {
  if (!isSREnabled()) {
    return `<div class="prog-section sr-due-widget">
      <div class="prog-section-title">🧠 Spaced Repetition Review</div>
      <div style="text-align:center;padding:20px;color:var(--muted);font-size:13px;line-height:1.6;">
        🔒 Spaced Repetition Review is currently unavailable. Check back later.
      </div>
    </div>`;
  }
  if (!dueItems.length) {
    return `<div class="prog-section">
      <div class="prog-section-title">🧠 Questions Due for Review</div>
      <div style="font-size:13px;color:var(--teal-l);">✅ You're all caught up! No reviews due today.</div>
    </div>`;
  }
  const overdue = dueItems.filter(i => (i.daysOverdue || 0) > 0).length;
  // Same per-subject rows as the notification panel — one entry point per
  // subject rather than a single button that hands over every due question.
  return `<div class="prog-section sr-due-widget">
    <div class="prog-section-title">🧠 Questions Due for Review</div>
    <div style="font-size:13px;color:var(--gold-l);margin-bottom:12px;">You have <strong>${dueItems.length}</strong> question${dueItems.length!==1?'s':''} to revisit${overdue > 0 ? ` · <span style="color:var(--danger);">${overdue} overdue</span>` : ''}</div>
    <div class="sr-subj-list">${_renderSRSubjectRows(dueItems)}</div>
  </div>`;
}

function _renderSRStats(srStats) {
  if (!isSREnabled()) return '';
  const { total=0, mastered=0, dueNow=0, upcomingThisWeek=0 } = srStats;
  const pct = total > 0 ? Math.round(mastered / total * 100) : 0;
  return `<div class="prog-section">
    <div class="prog-section-title">📊 Spaced Repetition Stats</div>
    <div class="prog-summary-row" style="margin-bottom:${total>0?'14px':'0'};">
      <div class="prog-stat-card"><div class="prog-stat-value">${total}</div><div class="prog-stat-label">Total Tracked</div></div>
      <div class="prog-stat-card"><div class="prog-stat-value" style="color:var(--teal);">${mastered}</div><div class="prog-stat-label">Mastered</div></div>
      <div class="prog-stat-card"><div class="prog-stat-value" style="color:${dueNow>0?'var(--danger)':'var(--gold-l)'};">${dueNow}</div><div class="prog-stat-label">Due Now</div></div>
      <div class="prog-stat-card"><div class="prog-stat-value" style="color:var(--gold-l);">${upcomingThisWeek}</div><div class="prog-stat-label">Due This Week</div></div>
    </div>
    ${total > 0 ? `
    <div class="prog-subj-bar-wrap" style="height:12px;margin-bottom:8px;">
      <div class="prog-subj-bar" style="width:${pct}%;background:linear-gradient(90deg,var(--teal),var(--teal-l));"></div>
    </div>
    <div style="font-size:12px;color:var(--muted);">You have mastered ${pct}% of your attempted questions (${mastered}/${total})</div>
    ` : `<div style="font-size:13px;color:var(--muted);">Complete your first Mock Bar or Speed Drill to start tracking mastery.</div>`}
  </div>`;
}

// ── My Progress ────────────────────────────────────────────────
let _progressActiveTab = 'progress'; // 'progress' | 'xp'

function navToProgress(tab) {
  currentSubject = null; currentMode = null;
  clearSidebarActive();
  document.getElementById('sb-progress')?.classList.add('active');
  showPage('progress');
  updateBreadcrumb(null, null);
  if (tab) _progressActiveTab = tab;
  renderProgressPage();
  sessionStorage.setItem('bb_last_view', 'progress');
  sessionStorage.removeItem('bb_last_subject');
  sessionStorage.setItem('bb_last_tab', tab || 'progress');
}

function switchProgressTab(tab) {
  if (_progressActiveTab === tab) return;
  _progressActiveTab = tab;
  sessionStorage.setItem('bb_last_tab', tab);
  renderProgressPage();
}

// Monotonic token — every render bumps it. Async continuations compare their
// captured token against the current one and bail if the user has since
// switched tabs, so a slow response can never paint over newer content.
let _progRenderToken = 0;

// The tab bar is built once and left in the DOM. Re-rendering it on every tab
// switch destroyed and recreated the buttons, which killed the .prog-tab-btn
// transition and dropped keyboard focus.
function _ensureProgressShell(container) {
  if (container.querySelector('.prog-tabs')) return;
  container.innerHTML = `
    <div class="prog-tabs">
      <button class="prog-tab-btn" data-ptab="progress" onclick="switchProgressTab('progress')">📊 My Progress</button>
      <button class="prog-tab-btn" data-ptab="xp" onclick="switchProgressTab('xp')">⚡ XP &amp; Level</button>
    </div>
    <div id="progressTabPanel"></div>`;
}

async function renderProgressPage() {
  const container = document.getElementById('progressContainer');
  if (!container) return;

  _ensureProgressShell(container);
  container.querySelectorAll('.prog-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.ptab === _progressActiveTab);
  });

  const panel = container.querySelector('#progressTabPanel');
  if (!panel) return;
  const token = ++_progRenderToken;

  if (_progressActiveTab === 'xp') {
    // Leaving the Progress tab — tear down the chart so it isn't left holding
    // a detached canvas and its resize observer.
    _destroyProgressChart();
    _stopCountdown();
    panel.innerHTML = '<div id="xpLevelContent"></div>';
    await renderXPLevelTab(token);
  } else {
    panel.innerHTML = '<div id="progressDashContent"></div>';
    await _renderProgressDashboardInto(panel.querySelector('#progressDashContent'), token);
  }
}

let _progScoreChart = null;

function _destroyProgressChart() {
  if (_progScoreChart) {
    try { _progScoreChart.destroy(); } catch(_) {}
    _progScoreChart = null;
  }
}

// ── Progress / XP data caches ─────────────────────────────────
// Both payloads only change when a session finishes, so repeat visits paint
// from cache immediately and revalidate in the background (stale-while-
// revalidate). endMockSession() calls invalidateProgressCaches() so a freshly
// completed session is never served stale.
const PROG_CACHE_TTL_MS = 60000;
let _progResultsCache = null;   // { data, at }
let _xpSummaryCache   = null;   // { data, at }

function invalidateProgressCaches() {
  _progResultsCache = null;
  _xpSummaryCache   = null;
  invalidateSRCache();
}

async function _fetchUserResults() {
  const resp = await fetch('/api/user/results', { headers: { 'x-session-token': sessionToken } });
  if (!resp.ok) throw new Error('Failed to load results');
  const data = await resp.json();
  _progResultsCache = { data, at: Date.now() };
  return data;
}

async function _fetchXPSummary() {
  const r = await fetch('/api/xp/summary', { headers: { 'x-session-token': sessionToken } });
  if (!r.ok) throw new Error('Failed to load XP');
  const data = await r.json();
  _xpSummaryCache = { data, at: Date.now() };
  return data;
}

// Keep the old name as an alias so any other callers still work
async function renderProgressDashboard() { return renderProgressPage(); }

// ── Skeletons ─────────────────────────────────────────────────
// These deliberately reuse the REAL layout classes (.prog-page, .prog-section,
// .prog-summary-row, .prog-stat-card, .xp-hero …) rather than .bb-skeleton-card.
// The old skeletons used their own padding/margin and omitted whole sections,
// so every load ended in a visible jump when real content replaced them.
// Matching the real box model means the swap is geometrically silent.

// Placeholder heights below are measured against the rendered components, not
// guessed — .prog-section-title is 21px tall with a 16px bottom margin,
// .prog-stat-card is 87px, .prog-subj-row 16px, .prog-insight 46px,
// .sr-subj-row 37px. Keep them in sync if those components change.
const _skelTitle = (w = '30%') =>
  `<div class="bb-skeleton" style="height:21px;width:${w};border-radius:4px;margin-bottom:16px;"></div>`;

function _skelStatCards(n) {
  return `<div class="prog-summary-row">
    ${Array.from({ length: n }, () => `<div class="prog-stat-card">
      <div class="bb-skeleton" style="height:28px;width:56px;border-radius:6px;"></div>
      <div class="bb-skeleton" style="height:15px;width:76px;border-radius:4px;"></div>
    </div>`).join('')}
  </div>`;
}

// Mirrors the per-subject row layout the real widget renders. The row count is
// one per subject with dues, which varies per account — so when a previous
// fetch left anything in the cache (the common repeat-visit case) we reuse its
// subject count and the swap is pixel-exact. 3 is the cold-start fallback.
function _skelSRDue() {
  const known = _srDueBySubject(window._srDueItems).length;
  const rows  = known > 0 ? known : 3;
  return `<div class="prog-section">
    ${_skelTitle('42%')}
    <div class="bb-skeleton" style="height:17px;width:58%;border-radius:4px;margin-bottom:12px;"></div>
    <div class="sr-subj-list">
      ${Array.from({ length: rows }, () => `<div class="bb-skeleton" style="height:37px;border-radius:9px;"></div>`).join('')}
    </div>
  </div>`;
}

function _skelSRStats() {
  return `<div class="prog-section">
    ${_skelTitle('38%')}
    <div style="margin-bottom:14px;">${_skelStatCards(4)}</div>
    <div class="bb-skeleton" style="height:12px;border-radius:6px;margin-bottom:8px;"></div>
    <div class="bb-skeleton" style="height:16px;width:62%;border-radius:4px;"></div>
  </div>`;
}

// The dashboard "body" — everything between the SR due widget and the SR stats
// block. Kept separate because those two slots are filled independently.
function skeletonProgressDashboard() {
  // .prog-streak-display measures 65px tall — pinned explicitly so the flame
  // placeholder can't drift from the real emoji's line box.
  const streak = `<div class="prog-section">
    ${_skelTitle('25%')}
    <div style="display:flex;align-items:center;gap:12px;height:65px;">
      <div class="bb-skeleton bb-skeleton-circle" style="width:44px;height:44px;"></div>
      <div style="flex:1;">
        <div class="bb-skeleton" style="height:24px;width:44%;border-radius:4px;margin-bottom:6px;"></div>
        <div class="bb-skeleton" style="height:17px;width:66%;border-radius:4px;"></div>
      </div>
    </div>
  </div>`;
  const chart = `<div class="prog-section">
    ${_skelTitle('34%')}
    <div class="prog-chart-wrap"><div class="bb-skeleton" style="height:100%;border-radius:8px;"></div></div>
  </div>`;
  const subjects = `<div class="prog-section">
    ${_skelTitle('35%')}
    <div class="prog-subj-list">
      ${[1,2,3,4,5,6,7,8].map(() => `<div class="prog-subj-row">
        <div class="bb-skeleton" style="width:110px;height:16px;border-radius:4px;flex-shrink:0;"></div>
        <div class="bb-skeleton" style="flex:1;height:10px;border-radius:6px;"></div>
        <div class="bb-skeleton" style="width:38px;height:16px;border-radius:4px;flex-shrink:0;"></div>
      </div>`).join('')}
    </div>
    <div class="bb-skeleton" style="height:11px;width:46%;border-radius:4px;margin-top:12px;"></div>
  </div>`;
  const insights = `<div class="prog-section">
    ${_skelTitle('20%')}
    <div class="prog-insights-list">
      ${[1,2,3].map(() => `<div class="bb-skeleton" style="height:46px;width:100%;border-radius:10px;"></div>`).join('')}
    </div>
  </div>`;
  return _skelStatCards(4) + streak + chart + subjects + insights;
}

function skeletonXPLevel() {
  const hero = `<div class="xp-hero">
    <div class="xp-hero-top">
      <div class="bb-skeleton" style="width:64px;height:64px;border-radius:50%;flex-shrink:0;"></div>
      <div style="flex:1;">
        <div class="bb-skeleton" style="height:22px;width:46%;border-radius:5px;margin-bottom:8px;"></div>
        <div class="bb-skeleton" style="height:13px;width:68%;border-radius:4px;"></div>
      </div>
    </div>
    <div class="xp-bar-wrap">
      <div class="bb-skeleton" style="height:10px;border-radius:5px;"></div>
      <div style="display:flex;justify-content:space-between;margin-top:8px;">
        ${[1,2,3].map(() => '<div class="bb-skeleton" style="height:17px;width:54px;border-radius:4px;"></div>').join('')}
      </div>
    </div>
  </div>`;
  const stats = `<div class="xp-stats-row">
    ${[1,2,3].map(() => `<div class="xp-stat-card">
      <div class="bb-skeleton" style="height:24px;width:62px;border-radius:6px;margin:0 auto 8px;"></div>
      <div class="bb-skeleton" style="height:16px;width:78px;border-radius:4px;margin:0 auto;"></div>
    </div>`).join('')}
  </div>`;
  // Rows are 40px and the header 31px, matching .xp-history-table's real
  // metrics. Row count is a guess (the API returns up to 20) — 5 keeps the
  // skeleton honest for a typical account.
  const table = `<div class="prog-section">
    ${_skelTitle('30%')}
    <div class="bb-skeleton" style="height:31px;border-radius:4px;"></div>
    ${[1,2,3,4,5].map(() => `<div style="display:flex;align-items:center;gap:12px;height:40px;">
      <div class="bb-skeleton" style="width:88px;height:15px;border-radius:4px;flex-shrink:0;"></div>
      <div class="bb-skeleton" style="flex:1;height:15px;border-radius:4px;"></div>
      <div class="bb-skeleton" style="width:74px;height:20px;border-radius:10px;flex-shrink:0;"></div>
      <div class="bb-skeleton" style="width:54px;height:15px;border-radius:4px;flex-shrink:0;"></div>
    </div>`).join('')}
  </div>`;
  // "How to Earn XP" — omitted by the old skeleton, which is why the page grew
  // by a full section on load.
  const earn = `<div class="prog-section">
    ${_skelTitle('28%')}
    <div class="prog-subj-list" style="gap:8px;">
      ${[1,2,3,4,5,6,7].map(() => `<div class="prog-subj-row" style="gap:10px;padding:8px 0;border-bottom:1px solid var(--bdr);">
        <div class="bb-skeleton" style="flex:1;height:21px;border-radius:4px;"></div>
        <div class="bb-skeleton" style="width:118px;height:15px;border-radius:4px;flex-shrink:0;"></div>
        <div class="bb-skeleton" style="width:60px;height:15px;border-radius:4px;flex-shrink:0;"></div>
      </div>`).join('')}
    </div>
  </div>`;
  return `<div class="prog-page">${hero}${stats}${table}${earn}</div>`;
}

async function _renderProgressDashboardInto(container, token) {
  if (!container) return;
  const isStale = () => token !== undefined && token !== _progRenderToken;

  // ── Paint the shell synchronously ────────────────────────────
  // Three independent slots. The countdown is real content from the first
  // frame (it needs no network — _barExamDate is cached at boot), and the two
  // SR slots paint from cache when we have it. Nothing below ever moves: the
  // slots keep their position and the skeletons match the real box model, so
  // filling them in is a pure in-place swap.
  const srFresh  = _srCacheIsFresh();
  const cachedRes = _progResultsCache?.data;

  container.innerHTML = `
    <div class="prog-page">
      ${_renderCountdownWidget()}
      <div id="sr-due-container">${srFresh ? _renderSRDueWidget(window._srDueItems) : _skelSRDue()}</div>
      <div id="prog-body" class="prog-page">${cachedRes ? '' : skeletonProgressDashboard()}</div>
      <div id="sr-stats-container">${srFresh ? _renderSRStats(window._srStats) : _skelSRStats()}</div>
    </div>`;
  _startCountdown();

  // ── Kick off both fetches together ───────────────────────────
  // These are independent; the old code awaited results, painted, and only
  // then started the SR round-trip, stacking the two serially.
  const resultsPromise = (cachedRes && (Date.now() - _progResultsCache.at) < PROG_CACHE_TTL_MS)
    ? Promise.resolve(cachedRes)
    : _fetchUserResults();

  const srPromise = srFresh
    ? Promise.resolve(null)                      // cache is fresh — no request at all
    : (window._srDueFetchPromise || checkDueReviews());

  // Stale-while-revalidate: if we had cached results, paint them now and let
  // the fetch above refresh the DOM when it lands.
  if (cachedRes) _paintProgressBody(container, cachedRes, token);

  srPromise.then(() => {
    if (isStale()) return;
    // Scoped to `container`: if the user switched tabs, this queries a detached
    // node and finds nothing rather than painting over the new tab.
    const dueEl   = container.querySelector('#sr-due-container');
    const statsEl = container.querySelector('#sr-stats-container');
    // On a failed fetch the cache stays unset — collapse the slot instead of
    // leaving a skeleton shimmering forever or inventing zeroes.
    if (dueEl)   dueEl.innerHTML   = Array.isArray(window._srDueItems) ? _renderSRDueWidget(window._srDueItems) : '';
    if (statsEl) statsEl.innerHTML = window._srStats ? _renderSRStats(window._srStats) : '';
  }).catch(() => { /* non-critical — page works without the SR sections */ });

  let results;
  try {
    results = await resultsPromise;
  } catch(e) {
    if (isStale()) return;
    // Only blow away the body slot — the countdown and SR sections stay usable.
    const body = container.querySelector('#prog-body');
    if (body && !cachedRes) {
      body.innerHTML = `<div class="prog-section" style="text-align:center;padding:40px 20px;">
        <div style="font-size:13px;color:var(--danger);margin-bottom:14px;">Could not load progress data.</div>
        <button class="btn-gold" onclick="renderProgressPage()" style="font-size:13px;padding:9px 20px;">↻ Retry</button>
      </div>`;
    }
    return;
  }
  if (isStale()) return;
  // Revalidated data differs from what we painted from cache — repaint.
  if (!cachedRes || results !== cachedRes) _paintProgressBody(container, results, token);
}

// Renders everything between the SR due widget and the SR stats block.
function _paintProgressBody(container, results, token) {
  if (token !== undefined && token !== _progRenderToken) return;
  const body = container.querySelector('#prog-body');
  if (!body) return;

  if (!results.length) {
    body.innerHTML = `
      <div class="prog-empty">
        <div class="prog-empty-icon">📝</div>
        <div class="prog-empty-title">No Sessions Yet</div>
        <div class="prog-empty-sub">Complete your first Mock Bar to start tracking your progress!</div>
        <button class="btn-gold" onclick="navToOverview()" style="font-size:13px;padding:10px 22px;">🏛 Go to Overview</button>
      </div>`;
    _destroyProgressChart();
    return;
  }

  // ── Compute stats ────────────────────────────────────────────
  const pct = r => {
    const max = (r.total_questions || 0) * 10;
    return max > 0 ? Math.round((r.score / max) * 100) : 0;
  };

  const allPcts   = results.map(pct);
  const totalSess = results.length;
  const avgScore  = Math.round(allPcts.reduce((a,b) => a+b, 0) / allPcts.length);
  const bestScore = Math.max(...allPcts);
  const totalQs   = results.reduce((a,r) => a + (r.total_questions || 0), 0);

  // By subject
  const SUBJ_NAMES = {civil:'Civil Law',criminal:'Criminal Law',political:'Political Law',
    labor:'Labor Law',commercial:'Commercial Law',taxation:'Taxation Law',
    remedial:'Remedial Law',ethics:'Legal Ethics',custom:'Custom'};
  const SUBJ_COLORS_MAP = {civil:'var(--c-civil)',criminal:'var(--c-criminal)',political:'var(--c-political)',
    labor:'var(--c-labor)',commercial:'var(--c-commercial)',taxation:'var(--c-taxation)',
    remedial:'var(--c-remedial)',ethics:'var(--c-ethics)',custom:'var(--c-custom)'};

  const VALID_SUBJECTS = new Set(['civil','criminal','political','labor','commercial','taxation','remedial','ethics']);

  const subjMap = {};
  results.forEach(r => {
    const key = (r.subject || '').toLowerCase();
    if (!VALID_SUBJECTS.has(key)) return; // skip mock_bar, all, mixed, etc.
    if (!subjMap[key]) subjMap[key] = [];
    subjMap[key].push(pct(r));
  });
  const subjStats = Object.entries(subjMap).map(([key, pcts]) => ({
    key,
    name: SUBJ_NAMES[key] || key,
    avg: Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length),
    color: SUBJ_COLORS_MAP[key] || '#888',
  })).sort((a,b) => a.avg - b.avg); // weakest first

  const weakest  = subjStats[0];
  const strongest = subjStats[subjStats.length-1];

  // Streak (consecutive calendar days with at least 1 session, going back from today)
  const manilaDateStr = d => d.toLocaleDateString('en-CA',{timeZone:'Asia/Manila'});
  const daySet = new Set(results.map(r => manilaDateStr(new Date(r.finished_at))));
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    if (daySet.has(manilaDateStr(d))) {
      streak++;
    } else if (i > 0) { // allow today to be missing (haven't done one yet today)
      break;
    }
  }

  // Trend: last vs second-to-last pct
  const lastPct = allPcts[allPcts.length - 1];
  const prevPct = allPcts.length > 1 ? allPcts[allPcts.length - 2] : null;
  const trendDiff = prevPct !== null ? lastPct - prevPct : null;

  // Passing subjects
  const passCount = subjStats.filter(s => s.avg >= 70).length;
  const totalSubjCount = subjStats.length;

  // ── Build insights ───────────────────────────────────────────
  const insights = [];
  if (trendDiff !== null) {
    if (trendDiff > 0) insights.push({ cls:'green', text:`📈 You improved ${trendDiff}% since your last session — keep going!` });
    else if (trendDiff < 0) insights.push({ cls:'yellow', text:`📉 Your last session dropped ${Math.abs(trendDiff)}% from the one before — let's bounce back!` });
    else insights.push({ cls:'blue', text:'🔄 Your last two sessions scored the same — push for a higher score!' });
  }
  if (weakest && weakest.avg < 70) insights.push({ cls:'red', text:`⚠️ You averaged ${weakest.avg}% on ${weakest.name} — focus here` });
  insights.push({ cls: passCount === totalSubjCount ? 'green' : 'yellow',
    text:`✅ You are passing ${passCount} out of ${totalSubjCount} subject${totalSubjCount!==1?'s':''}` });
  if (strongest) insights.push({ cls:'blue', text:`🎯 Your strongest subject is ${strongest.name} at ${strongest.avg}%` });

  // ── Render ───────────────────────────────────────────────────
  const barColor = p => p >= 85 ? 'var(--teal)' : p >= 70 ? 'var(--gold)' : 'var(--danger)';
  const pctColor = p => p >= 85 ? 'var(--teal)' : p >= 70 ? 'var(--gold)' : 'var(--danger)';

  // Score history for chart — last 15 sessions only
  const chartResults = [...results]
    .sort((a, b) => new Date(a.finished_at) - new Date(b.finished_at))
    .slice(-15);
  const chartLabels = chartResults.map(r => {
    const d = new Date(r.finished_at);
    return d.toLocaleDateString('en-US',{timeZone:'Asia/Manila',month:'numeric',day:'numeric'});
  });
  const chartData = chartResults.map(pct);
  const pointColors = chartData.map(p => p >= 70 ? 'var(--teal)' : 'var(--danger)');
  const segColors   = chartData.map((p,i) => {
    if (i === 0) return p >= 70 ? 'var(--teal)' : 'var(--danger)';
    return chartData[i-1] >= 70 ? 'var(--teal)' : 'var(--danger)';
  });

  body.innerHTML = `
      <!-- Summary stats row -->
      <div class="prog-summary-row">
        <div class="prog-stat-card">
          <div class="prog-stat-value">${totalSess}</div>
          <div class="prog-stat-label">Sessions Completed</div>
        </div>
        <div class="prog-stat-card">
          <div class="prog-stat-value" style="color:${pctColor(avgScore)}">${avgScore}%</div>
          <div class="prog-stat-label">Overall Average</div>
        </div>
        <div class="prog-stat-card">
          <div class="prog-stat-value" style="color:${pctColor(bestScore)}">${bestScore}%</div>
          <div class="prog-stat-label">Best Score</div>
        </div>
        <div class="prog-stat-card">
          <div class="prog-stat-value">${totalQs}</div>
          <div class="prog-stat-label">Questions Answered</div>
        </div>
      </div>

      <!-- Streak -->
      <div class="prog-section">
        <div class="prog-section-title">🔥 Study Streak</div>
        ${streak > 0
          ? `<div class="prog-streak-display">
              <div class="prog-streak-flame">🔥</div>
              <div>
                <div class="prog-streak-count">${streak}-day streak!</div>
                <div class="prog-streak-label">Keep it going — don't break the chain.</div>
              </div>
            </div>`
          : `<div style="font-size:14px;color:var(--muted);">Start a session today to begin your streak.</div>`}
      </div>

      <!-- Score history chart -->
      <div class="prog-section">
        <div class="prog-section-title">📈 Score History (Last 15 Sessions)</div>
        ${totalSess === 1
          ? `<div style="font-size:13px;color:var(--muted);margin-bottom:12px;">Complete more sessions to see your trend.</div>`
          : ''}
        <div class="prog-chart-wrap">
          <canvas id="progScoreChart"></canvas>
        </div>
      </div>

      <!-- Subject breakdown -->
      <div class="prog-section">
        <div class="prog-section-title">📚 Subject Performance</div>
        ${weakest && weakest.avg < 70
          ? `<div class="prog-weak-banner">⚠️ Focus here: You averaged ${weakest.avg}% on ${weakest.name}</div>`
          : ''}
        <div class="prog-subj-list">
          ${subjStats.map(s => `
            <div class="prog-subj-row">
              <div class="prog-subj-name">${h(s.name)}</div>
              <div class="prog-subj-bar-wrap">
                <div class="prog-subj-bar" style="width:${s.avg}%;background:${barColor(s.avg)};"></div>
              </div>
              <div class="prog-subj-pct" style="color:${pctColor(s.avg)}">${s.avg}%</div>
            </div>`).join('')}
        </div>
        <div style="margin-top:12px;font-size:11px;color:var(--muted);">Sorted weakest → strongest · Passing threshold: 70%</div>
      </div>

      <!-- Insights -->
      <div class="prog-section">
        <div class="prog-section-title">💡 Insights</div>
        <div class="prog-insights-list">
          ${insights.map(i => `<div class="prog-insight ${i.cls}">${i.text}</div>`).join('')}
        </div>
      </div>`;

  // ── Draw Chart.js line graph ─────────────────────────────────
  // Wrapped in try/catch and kept last: Chart.js loads from a CDN, and when
  // that fails `new Chart(...)` throws. This used to abort the whole render
  // before the Spaced Repetition sections were injected, so a blocked CDN
  // silently cost the user two entire sections of the page.
  _drawProgressChart({ chartLabels, chartData, pointColors });
}

function _drawProgressChart({ chartLabels, chartData, pointColors }) {
  _destroyProgressChart();
  const ctx = document.getElementById('progScoreChart');
  if (!ctx) return;
  if (typeof Chart === 'undefined') {
    const wrap = ctx.closest('.prog-chart-wrap');
    if (wrap) wrap.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:12px;color:var(--muted);text-align:center;padding:0 20px;">Chart unavailable — could not load the charting library.</div>`;
    return;
  }
  try {
  _progScoreChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: chartLabels,
      datasets: [{
        label: 'Score %',
        data: chartData,
        borderColor: function(ctx2) {
          const chart = ctx2.chart;
          const { ctx: c, chartArea } = chart;
          if (!chartArea) return _cssVar('--gold');
          const gradient = c.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
          chartData.forEach((p,i) => {
            gradient.addColorStop(i / Math.max(chartData.length-1,1), p >= 70 ? _cssVar('--teal') : _cssVar('--danger'));
          });
          return gradient;
        },
        borderWidth: 2.5,
        pointBackgroundColor: pointColors,
        pointBorderColor: pointColors,
        pointRadius: 5,
        pointHoverRadius: 7,
        tension: 0.35,
        fill: false,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx3 => `Score: ${ctx3.parsed.y}%`,
          },
          backgroundColor: _cssVar('--card'),
          borderColor: _cssVar('--bdr-gold'),
          borderWidth: 1,
          titleColor: _cssVar('--white'),
          bodyColor: _cssVar('--white'),
        },
        annotation: undefined,
      },
      scales: {
        x: {
          ticks: { color: _cssVar('--muted'), font: { size: 11 } },
          grid: { color: _cssVar('--bdr') },
        },
        y: {
          min: 0, max: 100,
          ticks: {
            color: _cssVar('--muted'),
            font: { size: 11 },
            callback: v => v + '%',
            stepSize: 20,
          },
          grid: { color: _cssVar('--bdr') },
        }
      }
    },
    plugins: [{
      // Draw 70% passing threshold line
      id: 'progThreshLine',
      afterDraw(chart) {
        const { ctx: c, chartArea, scales } = chart;
        if (!chartArea) return;
        const y = scales.y.getPixelForValue(70);
        c.save();
        c.setLineDash([6,4]);
        c.strokeStyle = _cssVar('--gold');
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(chartArea.left, y);
        c.lineTo(chartArea.right, y);
        c.stroke();
        c.setLineDash([]);
        c.fillStyle = _cssVar('--gold');
        c.font = '10px DM Sans, sans-serif';
        c.fillText('70% passing', chartArea.left + 4, y - 5);
        c.restore();
      }
    }]
  });
  } catch(e) {
    console.warn('[progress] Chart render failed:', e.message);
    const wrap = ctx.closest('.prog-chart-wrap');
    if (wrap) wrap.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:12px;color:var(--muted);">Chart unavailable.</div>`;
  }
}

// ── XP & Level Tab ────────────────────────────────────────────
async function renderXPLevelTab(token) {
  const container = document.getElementById('xpLevelContent');
  if (!container) return;
  const isStale = () => token !== undefined && token !== _progRenderToken;

  // Paint from cache first if we have anything — refreshSidebarXP() already
  // fetched this exact payload at boot, so a first visit to the tab usually
  // has a warm cache and needs no skeleton at all.
  const cached = _xpSummaryCache?.data;
  if (cached) _paintXPLevel(container, cached, token);
  else container.innerHTML = skeletonXPLevel();

  const fresh = cached && (Date.now() - _xpSummaryCache.at) < PROG_CACHE_TTL_MS;
  if (fresh) return;

  try {
    const data = await _fetchXPSummary();
    if (isStale()) return;
    _paintXPLevel(container, data, token);
  } catch(e) {
    if (isStale() || cached) return;   // keep the cached view on a failed refresh
    container.innerHTML = `<div class="prog-section" style="text-align:center;padding:40px 20px;">
      <div style="font-size:13px;color:var(--danger);margin-bottom:14px;">Could not load XP data.</div>
      <button class="btn-gold" onclick="renderProgressPage()" style="font-size:13px;padding:9px 20px;">↻ Retry</button>
    </div>`;
  }
}

function _paintXPLevel(container, data, token) {
  if (token !== undefined && token !== _progRenderToken) return;
  const { xp, level, title, xpToNextLevel, progressPercent, recentTransactions } = data;
  {
    const _ACTION_LABELS = {
      MOCK_BAR_FULL:           'MOCK BAR ★',
      MOCK_BAR_PARTIAL:        'MOCK BAR',
      COMPLETE_SPEED_DRILL:    'SPEED DRILL',
      COMPLETE_REVIEW_SESSION: 'REVIEW',
      HIGH_SCORE_BONUS:        'HIGH SCORE',
      DAILY_LOGIN:             'LOGIN',
      STREAK_BONUS:            'STREAK',
      FIRST_SUBJECT_COMPLETE:  'SUBJECT COMPLETE',
      MASTER_SPACED_REP:       'MASTERED',
    };

    const fmtDate = ts => {
      const d = new Date(ts);
      return d.toLocaleDateString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' });
    };

    const histRows = recentTransactions.length
      ? recentTransactions.map(t => `
          <tr>
            <td style="color:var(--muted);">${fmtDate(t.created_at)}</td>
            <td>${t.description || _ACTION_LABELS[t.action] || t.action}</td>
            <td><span class="xp-action-badge">${_ACTION_LABELS[t.action] || t.action}</span></td>
            <td class="xp-earned">+${t.xp_earned} XP</td>
          </tr>`).join('')
      : `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:24px;">No XP earned yet — complete a session to get started!</td></tr>`;

    container.innerHTML = `
      <div class="prog-page">
        <!-- Hero: Level + XP bar -->
        <div class="xp-hero">
          <div class="xp-hero-top">
            <div class="xp-level-badge">
              <div class="lvl-num">${level}</div>
              <div class="lvl-lbl">Level</div>
            </div>
            <div class="xp-hero-info">
              <div class="xp-title">${h(title)}</div>
              <div class="xp-subtitle">${xp.toLocaleString()} XP total${xpToNextLevel > 0 ? ` · ${xpToNextLevel.toLocaleString()} XP to Level ${level + 1}` : ' · Max level!'}</div>
            </div>
          </div>
          <div class="xp-bar-wrap">
            <div class="xp-bar-track">
              <div class="xp-bar-fill" id="xpHeroBarFill" style="width:0%"></div>
            </div>
            <div class="xp-bar-meta">
              <span>Level ${level}</span>
              <span>${progressPercent}%</span>
              <span>${xpToNextLevel > 0 ? 'Level ' + (level + 1) : 'MAX'}</span>
            </div>
          </div>
        </div>

        <!-- Stats row -->
        <div class="xp-stats-row">
          <div class="xp-stat-card">
            <div class="xp-stat-val">${xp.toLocaleString()}</div>
            <div class="xp-stat-lbl">Total XP</div>
          </div>
          <div class="xp-stat-card">
            <div class="xp-stat-val">${level}</div>
            <div class="xp-stat-lbl">Current Level</div>
          </div>
          <div class="xp-stat-card">
            <div class="xp-stat-val">${xpToNextLevel > 0 ? xpToNextLevel.toLocaleString() : '—'}</div>
            <div class="xp-stat-lbl">XP to Next</div>
          </div>
        </div>

        <!-- XP History -->
        <div class="prog-section">
          <div class="prog-section-title">⚡ XP History</div>
          <div style="overflow-x:auto;">
            <table class="xp-history-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Action</th>
                  <th style="text-align:right;">XP</th>
                </tr>
              </thead>
              <tbody>${histRows}</tbody>
            </table>
          </div>
        </div>

        <!-- How to earn XP -->
        <div class="prog-section">
          <div class="prog-section-title">🎯 How to Earn XP</div>
          <div class="prog-subj-list" style="gap:8px;">
            ${[
              ['Mock Bar — Full (20 questions)', XP_CLIENT.MOCK_BAR_FULL_BONUS,    'flat bonus + high score bonuses'],
              ['Mock Bar — Partial',             XP_CLIENT.MOCK_BAR_PER_QUESTION,  'per question answered'],
              ['Speed Drill',                    XP_CLIENT.COMPLETE_SPEED_DRILL,   'flat per session'],
              ['High Score Bonus',               XP_CLIENT.HIGH_SCORE_BONUS,       'per question ≥ 8.0'],
              ['Review Session',                 XP_CLIENT.COMPLETE_REVIEW_SESSION,'per session'],
              ['Master a Question',              XP_CLIENT.MASTER_SPACED_REP,      'first mastery only'],
              ['Daily Login',                    XP_CLIENT.DAILY_LOGIN,            'once per day'],
            ].map(([label, val, note]) => `
              <div class="prog-subj-row" style="gap:10px;padding:8px 0;border-bottom:1px solid var(--bdr);">
                <div style="flex:1;font-size:13px;color:var(--white);">${label}</div>
                <div style="font-size:11px;color:var(--muted);">${note}</div>
                <div style="font-family:var(--fm);font-weight:700;color:var(--teal-l);min-width:60px;text-align:right;">+${val} XP</div>
              </div>`).join('')}
          </div>
        </div>
      </div>`;

    // Animate the XP bar
    requestAnimationFrame(() => {
      const fill = container.querySelector('#xpHeroBarFill');
      if (fill) setTimeout(() => { fill.style.width = progressPercent + '%'; }, 100);
    });
  }
}

// XP values exposed to client for the "how to earn" table
const XP_CLIENT = {
  MOCK_BAR_FULL_BONUS: 1000, MOCK_BAR_PER_QUESTION: 10,
  COMPLETE_SPEED_DRILL: 40, COMPLETE_REVIEW_SESSION: 60,
  HIGH_SCORE_BONUS: 50, DAILY_LOGIN: 10, STREAK_BONUS: 25,
  FIRST_SUBJECT_COMPLETE: 200, MASTER_SPACED_REP: 30,
};

function navToCustom() {
  // Block access if per-user custom subject is disabled (admins bypass)
  if (!adminKey && !isCustomSubjectEnabled()) {
    showPage('subject');
    const content = document.getElementById('subject-tab-content');
    if (content) content.innerHTML = `<div style="text-align:center;padding:48px 20px;color:var(--muted);">
      <div style="font-size:36px;margin-bottom:12px;">🔒</div>
      <div style="font-size:15px;font-weight:600;margin-bottom:6px;color:var(--text);">Custom Subject Locked</div>
      <div style="font-size:13px;">Custom Subject access is restricted. Contact your administrator.</div>
    </div>`;
    return;
  }
  // Route custom subject through the same subject page system as regular subjects
  navToSubject('custom', 'mockbar');
}

function navToSubject(subj, mode) {
  if (!subj) { // "All subjects" mock bar from overview
    currentSubject = null; currentMode = 'mockbar';
    clearSidebarActive();
    showPage('mockbar');
    updateBreadcrumb(null, null);
    initMockBarSetup(null);
    return;
  }
  // custom subject flows through the same path as regular subjects

  // Determine which mode to default to (pick first enabled)
  const ts = window.TAB_SETTINGS;
  // Tab landing priority: Flashcards is the primary default since Learn + Quiz
  // are UI-hidden. Order reflects what to try if the requested mode is disabled
  // for this subject via admin tab-settings.
  const modesInOrder = ['flashcards','mockbar','speeddrill','learn','quiz'];
  let targetMode = mode || 'flashcards';
  if (ts?.subjects?.[subj]?.[targetMode] === false) {
    targetMode = modesInOrder.find(m => ts.subjects?.[subj]?.[m] !== false) || 'flashcards';
  }

  currentSubject = subj; currentMode = targetMode;
  clearSidebarActive();
  document.getElementById('sb-subj-' + subj)?.classList.add('active');
  updateBreadcrumb(subj, targetMode);
  showPage('subject');
  renderSubjectHeader(subj);
  renderSubjectTabs(subj, targetMode);
  switchSubjectTab(subj, targetMode);
  sessionStorage.setItem('bb_last_view', 'subject');
  sessionStorage.setItem('bb_last_subject', subj);
  sessionStorage.setItem('bb_last_tab', targetMode);
}

function renderSubjectHeader(subj) {
  const s = ALL_SUBJS.find(x => x.key === subj);
  if (!s) return;
  const refs   = (KB.references||[]).filter(r=>r.subject===subj).length;
  const pbSets = (KB.pastBar||[]).filter(p=>p.subject===subj).length;
  const pbQs   = (KB.pastBar||[]).filter(p=>p.subject===subj).reduce((a,p)=>a+(p.qCount||0),0);
  const cached = Object.keys(CACHE[subj]||{}).length;
  const topicCount = (KB.syllabusTopics||[]).find(st=>st.key===subj)?.topics?.length || 0;
  const metaParts = [];
  if (refs) metaParts.push(`${refs} reference${refs!==1?'s':''}`);
  if (pbSets) metaParts.push(`${pbSets} past bar set${pbSets!==1?'s':''}`);
  if (pbQs) metaParts.push(`${pbQs} questions`);
  if (topicCount) metaParts.push(`${topicCount} topics`);
  if (cached) metaParts.push(`${cached} cached`);
  document.getElementById('subject-page-header-area').innerHTML = `
    <div class="subject-page-header">
      <div class="subject-color-bar" style="background:${s.color};"></div>
      <div>
        <h2 class="subject-page-title">${h(s.name)}</h2>
        <div class="subject-page-meta">${metaParts.length ? metaParts.join(' · ') : 'No materials uploaded yet'}</div>
      </div>
    </div>`;
}

function renderSubjectTabs(subj, activeMode) {
  const ts = window.TAB_SETTINGS?.subjects?.[subj] || {};
  const tabs = [
    { mode:'learn',      icon:'📖', label:'Learn'       },
    { mode:'quiz',       icon:'✏️',  label:'Quiz'        },
    { mode:'mockbar',    icon:'⏱',  label:'Mock Bar'    },
    { mode:'speeddrill', icon:'⚡', label:'Speed Drill' },
    { mode:'flashcards', icon:'🎴', label:'Flashcards'  },
  ];
  const bar = document.getElementById('subject-tab-bar');
  if (!bar) return;
  bar.innerHTML = tabs.map(t => {
    const enabled = ts[t.mode] !== false;
    const isActive = t.mode === activeMode;
    const drillStyle = t.mode === 'speeddrill'
      ? (isActive
          ? 'color:#a78bfa;background:linear-gradient(135deg,rgba(139,92,246,.25),rgba(106,61,232,.15));border-color:rgba(139,92,246,.4);box-shadow:0 2px 8px rgba(139,92,246,.2);'
          : 'color:#7c6fa0;')
      : '';
    return `<button id="stab-${t.mode}"
      class="subject-tab${isActive?' active':''}${!enabled?' tab-disabled':''}"
      onclick="switchSubjectTab('${subj}','${t.mode}')"
      ${!enabled?'disabled':''}
      style="${drillStyle}">
      ${t.icon} ${t.label}${!enabled?' 🔒':''}
    </button>`;
  }).join('');
}

function switchSubjectTab(subj, mode) {
  // If disabled, auto-pick first enabled
  const ts = window.TAB_SETTINGS?.subjects?.[subj] || {};
  if (ts[mode] === false) {
    // Learn + Quiz tabs are UI-hidden — prefer Flashcards as the landing tab.
    // Order reflects priority: flashcards first, then mockbar, then speeddrill,
    // then learn (hidden but kept as a final fallback so admins toggling the
    // CSS hide can still navigate via the URL/state).
    const first = ['flashcards','mockbar','speeddrill','learn','quiz'].find(m => ts[m] !== false);
    if (first) { switchSubjectTab(subj, first); return; }
  }
  currentMode = mode;
  document.querySelectorAll('.subject-tab').forEach(t => {
    t.classList.remove('active');
    t.style.color = '';
    t.style.background = '';
    t.style.borderColor = '';
    t.style.boxShadow = '';
  });
  const activeTab = document.getElementById('stab-' + mode);
  if (activeTab) {
    activeTab.classList.add('active');
    if (mode === 'speeddrill') {
      activeTab.style.color = '#a78bfa';
      activeTab.style.background = 'linear-gradient(135deg,rgba(139,92,246,.25),rgba(106,61,232,.15))';
      activeTab.style.borderColor = 'rgba(139,92,246,.4)';
      activeTab.style.boxShadow = '0 2px 8px rgba(139,92,246,.2)';
    }
  }
  updateBreadcrumb(subj, mode);
  maybeAutoExpandSidebarForFlashcards(mode);
  const content = document.getElementById('subject-tab-content');
  if (!content) return;
  // Guard: block rendering if tab is restricted for this user (defense-in-depth)
  const isAdm = !!adminKey && currentUser?.isAdmin;
  if (!isAdm && window.TAB_SETTINGS?.subjects?.[subj]?.[mode] === false) {
    content.innerHTML = `<div style="text-align:center;padding:48px 20px;color:var(--muted);">
      <div style="font-size:36px;margin-bottom:12px;">🔒</div>
      <div style="font-size:15px;font-weight:600;margin-bottom:6px;color:var(--text);">Access Restricted</div>
      <div style="font-size:13px;">This feature is not available for your account. Contact your administrator.</div>
    </div>`;
    return;
  }
  if (mode === 'learn')      renderLearnTab(subj, content);
  if (mode === 'quiz')       renderQuizTab(subj, content);
  if (mode === 'mockbar')    renderMockBarTab(subj, content);
  if (mode === 'speeddrill') renderSpeedDrillTab(subj, content);
  if (mode === 'flashcards') renderFlashcardsTab(subj, content);
}

function renderLearnTab(subj, container) {
  const subjInfo = SUBJS.find(s => s.key === subj);
  // Progress everywhere in the app means flashcards done/total.
  const prog = getSubjectFlashcardProgress(subj);
  const pct  = prog.pct;
  const subjColor = subjInfo?.color || 'var(--gold)';
  container.innerHTML = `
    <div class="split-layout">
      <aside class="panel-l">
        <div class="pl-head">
          <h3>📖 Topics</h3>
          <input class="sp-search" type="text" placeholder="Search topics…" oninput="filterTopics(this.value)" id="topicSearch">
        </div>
        <div class="subj-progress-bar-wrap" style="padding:0 12px 10px;">
          <div class="subj-progress-bar-track">
            <div class="subj-progress-bar-fill" id="subj-progress-fill-${subj}" style="width:${pct}%;background:${subjColor};"></div>
          </div>
          <span class="subj-progress-text" id="subj-progress-text-${subj}">${prog.done}/${prog.total} cards · ${pct}%</span>
        </div>
        <div style="padding:0 12px 8px;">
          <button class="pl-bm-btn" onclick="openBookmarksPanel()">🔖 My Bookmarks</button>
        </div>
        <div class="tree" id="syllabusTree"></div>
      </aside>
      <div class="panel-r">
        <div class="pr-top" id="lpTopbar" style="display:none;">
          <div class="pr-bc" id="lpBC"></div>
          <div style="display:flex;gap:7px;align-items:center;">
            <button class="btn-bookmark" id="bookmark-btn" onclick="toggleBookmark()">🔖 Bookmark</button>
            <button class="btn-mark-done" id="mark-done-btn" onclick="markDone()">○ Mark as Done</button>
            <button class="btn-og" style="font-size:11px;" onclick="switchSubjectTab(currentSubject,'quiz')">Take Quiz →</button>
          </div>
        </div>
        <div class="pr-content" id="lpContent">
          <div class="welcome-st"><div class="big-ic">📖</div><h3>${h(subjInfo?.name||subj)}</h3><p>Click a topic on the left to view its lesson content.</p></div>
        </div>
        <div id="lpFooter" style="display:none;" class="pr-foot">
          <div style="font-size:12px;color:var(--muted);font-family:var(--fm);" id="lpPgInfo">Page 1 of 1</div>
          <div style="display:flex;gap:8px;">
            <button class="btn-ghost" id="lpPrev" onclick="chgPage(-1)">← Prev</button>
            <button class="btn-gold" id="lpNext" onclick="chgPage(1)">Next →</button>
          </div>
        </div>
      </div>
    </div>`;
  // Load syllabus tree for this subject (fetch if not cached)
  loadSubjectSyllabus(subj).then(() => renderSyllabusTree('', subj));
}

async function loadSubjectSyllabus(subj) {
  if (syllabusCache[subj]) return syllabusCache[subj];
  try {
    const headers = sessionToken ? {'x-session-token': sessionToken} : {};
    const r = await fetch(`/api/syllabus/${subj}`, { headers });
    if (r.ok) { syllabusCache[subj] = await r.json(); }
  } catch(e) {}
  return syllabusCache[subj] || { sections: [] };
}

function renderQuizTab(subj, container) {
  curSubj = subj;
  container.innerHTML = `
    <div class="split-layout">
      <aside class="panel-l">
        <div class="pl-head">
          <h3>✍️ Practice</h3>
          <div class="q-type-tabs">
            <div class="qtt on" id="qmode-essay" onclick="setQMode('essay')"><span class="qtt-ic">✍️</span>Essay</div>
          </div>
        </div>
        <div class="qn-list" id="quizList"></div>
      </aside>
      <div style="display:flex;flex-direction:column;overflow:hidden;">
        <div id="qmHead" style="display:none;padding:13px 24px;align-items:center;gap:10px;background:var(--ink2);border-bottom:1px solid var(--bdr2);">
          <div style="font-family:var(--fd);font-size:19px;font-weight:700;color:var(--gold-l);flex:1;" id="qmTitle">Quiz</div>
          <div style="font-size:11px;color:var(--muted);font-family:var(--fm);" id="qmMeta"></div>
          <button class="btn-og" style="font-size:11px;" onclick="resetQuiz()">↺ Restart</button>
        </div>
        <div class="qm-body" id="qmBody">
          <div class="welcome-st"><div class="big-ic">✍️</div><h3>${h(SUBJS.find(s=>s.key===subj)?.name||subj)}</h3><p>Select a topic from the left panel to practice.</p></div>
        </div>
      </div>
    </div>`;
  buildQuizPool(subj);
}

async function renderMockBarTab(subj, container) {
  if (!container) return;
  // Ensure KB is loaded before rendering sources
  if (!KB.pastBar || (KB.pastBar.length === 0 && !KB._loaded)) {
    container.innerHTML = `<div style="text-align:center;padding:32px;color:var(--muted)"><div style="font-size:24px;margin-bottom:10px;">⏳</div>Loading materials…</div>`;
    await refreshKBState();
  }
  const s = ALL_SUBJS.find(x => x.key === subj);
  const presets = [[5,'5'],[10,'10'],[20,'20']];
  const timeOpts = [[0,'No limit'],[30,'30 min'],[60,'1 hr'],[120,'2 hr'],[180,'3 hr'],[240,'4 hr']];
  const diffOpts = [['balanced','⚖️ Balanced'],['situational','📋 Situational'],['conceptual','💡 Conceptual']];
  container.innerHTML = `
    <div style="max-width:580px;">
      <div class="mb-setup-card">
        <div class="mb-section-label">Number of Questions</div>
        <div class="mb-btn-row" id="stMbCountRow">
          ${presets.map(([n,l])=>`<button class="mb-preset-btn${mbCount===n?' active':''}" onclick="stSetMbCount(${n},this)">${l}</button>`).join('')}
          <input type="number" id="stMbCustomCount" min="1" max="100" placeholder="Custom"
            value="${![5,10,20].includes(mbCount)?mbCount:''}"
            style="width:64px;background:rgba(var(--ovl),.06);border:1px solid rgba(var(--ovl),.12);border-radius:8px;padding:7px 10px;color:var(--white);font-size:13px;font-family:var(--fb);"
            oninput="stSetMbCount(parseInt(this.value)||20)">
        </div>
      </div>
      <div class="mb-setup-card">
        <div class="mb-section-label">Time Limit</div>
        <div class="mb-btn-row" id="stMbTimeRow">
          ${timeOpts.map(([m,l])=>`<button class="mb-preset-btn${mbTimeMins===m?' active':''}" onclick="stSetMbTime(${m},this)">${l}</button>`).join('')}
        </div>
      </div>
      <div class="mb-setup-card">
        <div class="mb-section-label">Difficulty Preference</div>
        <div class="mb-btn-row" id="stMbDiffRow">
          ${diffOpts.map(([d,l])=>`<button class="mb-preset-btn${mbDifficulty===d?' active':''}" onclick="stSetMbDiff('${d}',this)">${l}</button>`).join('')}
        </div>
      </div>
      <div class="mb-preview" id="mockbar-preview">Loading…</div>
      <div id="stMbWarnBanner" class="mb-warn-banner" style="display:none;"></div>
      <button class="btn-gold" id="stStartMockBtn" onclick="startSubjectMockBar('${subj}')"
        style="width:100%;justify-content:center;font-size:15px;padding:14px;margin-top:8px;">
        ⚡ Start ${h(s?.name||subj)} Mock Bar
      </button>
    </div>`;
  updateMockPreview();
}

function stSetMbCount(n, btn) {
  mbCount = n || 20;
  document.querySelectorAll('#stMbCountRow .mb-preset-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  updateMockPreview();
}
function stSetMbTime(mins, btn) {
  mbTimeMins = mins;
  document.querySelectorAll('#stMbTimeRow .mb-preset-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}
function stSetMbDiff(diff, btn) {
  mbDifficulty = diff;
  document.querySelectorAll('#stMbDiffRow .mb-preset-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

function updateMockPreview() {
  // If we're on a subject tab, use currentSubject; otherwise use the old mock bar UI
  const onSubjectTab = document.getElementById('mockbar-preview') !== null;
  const subjects = onSubjectTab && currentSubject ? [currentSubject] : getMbSubjects();
  const isAll = subjects.includes('all');
  const avail = (KB.pastBar || [])
    .filter(pb => pb.enabled !== false && (isAll || subjects.includes(pb.subject)))
    .reduce((a, pb) => a + (pb.qCount || 0), 0);
  const want = mbCount || 5;
  const text = avail === 0
    ? '⚠️ No questions available for the selected subjects.'
    : avail < want
      ? `⚠️ Only ${avail} question${avail!==1?'s':''} available — will draw ${avail}.`
      : ``;
  const prev = document.getElementById('mockbar-preview') || document.getElementById('mbPreview');
  if (prev) prev.textContent = text;
  const btn = document.getElementById('stStartMockBtn') || document.getElementById('startMockBtn');
  if (btn) { btn.disabled = avail === 0; btn.style.opacity = avail === 0 ? '0.4' : '1'; }
}

async function startSubjectMockBar(subj) {
  const btn = document.getElementById('stStartMockBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Preparing…'; }
  try {
    const r = await fetch('/api/mockbar/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjects: [subj], count: mbCount, includePreGen: false, aiGenerate: false, difficulty: mbDifficulty, timeMins: mbTimeMins || 0 }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    if (d.warning) {
      const warn = document.getElementById('stMbWarnBanner');
      if (warn) { warn.textContent = '⚠️ ' + d.warning; warn.style.display = ''; }
    }
    startMockSession(d.questions, mbTimeMins, subj);
  } catch(e) {
    const s = ALL_SUBJS.find(x=>x.key===subj)?.name || subj;
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Start ' + s + ' Mock Bar'; }
    alert('Error: ' + e.message);
  }
}

function renderSpeedDrillTab(subj, container) {
  if (!container) return;
  const s = ALL_SUBJS.find(x => x.key === subj);
  const subjName = h(s?.name || subj);
  const subjColor = s?.color || '#8b5cf6';
  container.innerHTML = `
    <div style="max-width:520px;">
      <div class="mb-setup-card" style="border-color:rgba(139,92,246,.25);background:linear-gradient(135deg,rgba(139,92,246,.07),rgba(106,61,232,.04));">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;">
          <div style="font-size:36px;line-height:1;">⚡</div>
          <div>
            <div style="font-family:var(--fd);font-size:18px;font-weight:700;color:#c4b5fd;margin-bottom:3px;">Speed Drill</div>
            <div style="font-size:12px;color:var(--muted);line-height:1.55;">Answer 1 randomly selected question within 3 minutes.</div>
          </div>
        </div>
        <div style="display:flex;gap:12px;margin-bottom:18px;flex-wrap:wrap;">
          <div style="flex:1;min-width:100px;background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.22);border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:22px;font-weight:800;color:#a78bfa;font-family:var(--fd);">1</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px;">Question</div>
          </div>
          <div style="flex:1;min-width:100px;background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.22);border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:22px;font-weight:800;color:#a78bfa;font-family:var(--fd);">3:00</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px;">Time Limit</div>
          </div>
          <div style="flex:1;min-width:100px;background:rgba(139,92,246,.12);border:1px solid rgba(139,92,246,.22);border-radius:10px;padding:12px;text-align:center;">
            <div style="font-size:22px;font-weight:800;color:#a78bfa;font-family:var(--fd);">AI</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px;">Scored</div>
          </div>
        </div>
        <div style="font-size:12px;color:var(--muted);line-height:1.65;margin-bottom:18px;padding:10px 12px;background:rgba(var(--ovl),.03);border-radius:8px;border-left:3px solid rgba(139,92,246,.4);">
          Same scoring rules as Mock Bar (0–10 pts per question). Timer turns red with 60 seconds remaining. When time runs out, your answer is auto-submitted.
        </div>
        <div id="sdStartError" style="display:none;margin-bottom:12px;padding:10px 14px;background:rgba(224,112,128,.12);border:1px solid rgba(224,112,128,.35);border-radius:10px;color:var(--danger);font-size:13px;"></div>
        <button id="sdStartBtn" onclick="startSubjectSpeedDrill('${subj}')"
          style="width:100%;display:flex;align-items:center;justify-content:center;gap:8px;padding:14px;font-family:var(--fd);font-size:15px;font-weight:700;color:#fff;background:linear-gradient(135deg,#6a3de8,#8b5cf6);border:none;border-radius:11px;cursor:pointer;box-shadow:0 4px 18px rgba(106,61,232,.4);transition:opacity .2s;">
          ⚡ Start ${subjName} Speed Drill
        </button>
      </div>
    </div>`;
}

async function startSubjectSpeedDrill(subj) {
  const btn = document.getElementById('sdStartBtn');
  const errEl = document.getElementById('sdStartError');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading question…'; }
  if (errEl) errEl.style.display = 'none';
  try {
    const r = await fetch('/api/mockbar/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjects: [subj], count: 1, includePreGen: false, aiGenerate: false, difficulty: mbDifficulty }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    window.isSpeedDrill = true;
    startMockSession(d.questions, 3, subj);
  } catch(e) {
    if (errEl) { errEl.textContent = '⚠️ ' + e.message; errEl.style.display = ''; }
    const s = SUBJS.find(x => x.key === subj)?.name || subj;
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Start ' + s + ' Speed Drill'; }
  }
}

function drillAgain() {
  const subj = window.lastExamSubject || 'civil';
  window.isSpeedDrill = false;
  navToSubject(subj, 'speeddrill');
  setTimeout(() => startSubjectSpeedDrill(subj), 300);
}

// ═══════════════════════════════════════════════════════════
// FLASHCARDS — Student-facing tab + study session (Session 3b)
// ═══════════════════════════════════════════════════════════

// Flashcard bundle cache — populated once at login via loadFlashcardBundleOnBoot.
// Shape (from GET /api/flashcards/bundle):
//   { topicCountsBySubject, totalBySubject, doneCardIds, doneCountBySubject,
//     doneTopicCountsBySubject }
// doneCardIds kept as a Set in memory for O(1) done-state lookups.
let _fcBundleCache = null;
let _fcDoneSet = new Set();
let _fcBundlePromise = null;

// Remembered UI state for the Flashcards tab. Persists across re-renders
// so ending a study session returns the user to their prior scroll/expand
// state instead of scrolling back to the top.
let _fcLastClickedNodeId = null;      // Node ID of the topic that launched the current session
let _fcLastSubject = null;             // Subject of the last-rendered Flashcards tab
const _fcExpandState = new Map();      // nodeId -> boolean (true = expanded)

// Module-level study session state
let _fcSession = null;
// Shape when active:
// {
//   subject, mode, queue: [card,...], position: int,
//   ratings: { again: n, hard: n, good: n, easy: n },
//   startedAt: Date, currentFlipped: boolean, submitting: boolean,
//   nodeIdFilter: string|null, // for topic mode
// }

// Session 4: Flashcards tab renders SYNCHRONOUSLY from the cached bundle.
// No fetches during render — bundle was loaded at app boot via
// loadFlashcardBundleOnBoot(). If bundle happens to not be loaded yet
// (rare: opening a subject before boot-load resolves), we trigger a
// fetch and paint a skeleton in the interim.
function renderFlashcardsTab(subj, container) {
  const subjInfo = SUBJS.find(s => s.key === subj);
  const subjName = subjInfo?.name || subj;

  // Paint the header + slots immediately
  container.innerHTML = `
    <div class="fc-tab-wrap">
      <div class="fc-tab-header" style="background:linear-gradient(135deg,rgba(201,168,76,.08),rgba(201,168,76,.02));border:1px solid rgba(201,168,76,.25);border-radius:16px;padding:22px;margin-bottom:18px;">
        <div style="font-size:28px;margin-bottom:8px;">🎴</div>
        <h2 style="font-family:var(--fd);font-size:24px;font-weight:700;color:var(--gold-l);margin-bottom:6px;">${h(subjName)} Flashcards</h2>
        <p style="font-size:13px;color:var(--muted);line-height:1.65;max-width:640px;">Review cards at your own pace. Mark each card as done as you learn it. Your progress is tracked across all subjects.</p>
      </div>
      <div id="fc-stats-slot"></div>
      <div id="fc-topics-slot"></div>
    </div>
  `;

  if (_fcBundleCache) {
    // SYNCHRONOUS render from cache — zero network delay
    paintFlashcardsTabFromBundle(subj);
  } else {
    // Edge case: user navigated to a subject before boot-load finished.
    // Show skeleton + fetch in background.
    document.getElementById('fc-stats-slot').innerHTML = `
      <div class="fc-skeleton-stats" style="background:var(--card);border:1px solid var(--bdr2);border-radius:14px;padding:22px;margin-bottom:16px;height:140px;opacity:.4;"></div>
    `;
    document.getElementById('fc-topics-slot').innerHTML = `
      <div style="color:var(--muted);font-size:12px;padding:14px;text-align:center;">Loading…</div>
    `;
    fetchFlashcardBundle().then(() => {
      // If user is still on this tab, paint it
      if (document.getElementById('fc-stats-slot')) paintFlashcardsTabFromBundle(subj);
    });
  }

  // Syllabus tree is NOT in the bundle (it's subject-specific & cached
  // separately by loadSubjectSyllabus). Ensure it's loaded.
  loadSubjectSyllabus(subj).then(() => {
    if (document.getElementById('fc-topics-slot')) paintFlashcardsTabFromBundle(subj);
  });
}

function paintFlashcardsTabFromBundle(subj) {
  const statsSlot = document.getElementById('fc-stats-slot');
  const topicsSlot = document.getElementById('fc-topics-slot');
  if (!statsSlot || !topicsSlot || !_fcBundleCache) return;

  const total = _fcBundleCache.totalBySubject[subj] || 0;
  const done = _fcBundleCache.doneCountBySubject[subj] || 0;
  const remaining = Math.max(0, total - done);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  if (total === 0) {
    statsSlot.innerHTML = `
      <div style="text-align:center;padding:40px 20px;color:var(--muted);background:var(--card);border:1px solid var(--bdr2);border-radius:14px;">
        <div style="font-size:40px;margin-bottom:10px;opacity:.6;">📭</div>
        <div style="font-family:var(--fd);font-size:16px;font-weight:700;color:var(--gold-l);margin-bottom:4px;">No Flashcards Yet</div>
        <div style="font-size:12px;max-width:360px;margin:0 auto;line-height:1.6;">No cards have been imported for this subject yet.</div>
      </div>
    `;
    topicsSlot.innerHTML = '';
    return;
  }

  // Stats card with progress bar + Start button
  statsSlot.innerHTML = `
    <div class="fc-study-card" style="background:var(--card);border:1px solid var(--bdr2);border-radius:14px;padding:22px;margin-bottom:16px;">
      <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:14px;">
        <div class="fc-stat">
          <div class="fc-stat-num" style="color:var(--teal);">${done}</div>
          <div class="fc-stat-label">Done</div>
        </div>
        <div class="fc-stat">
          <div class="fc-stat-num" style="color:var(--gold-l);">${remaining}</div>
          <div class="fc-stat-label">Remaining</div>
        </div>
        <div class="fc-stat">
          <div class="fc-stat-num" style="color:var(--text);">${total}</div>
          <div class="fc-stat-label">Total</div>
        </div>
        <div class="fc-stat">
          <div class="fc-stat-num" style="color:var(--gold-l);">${pct}%</div>
          <div class="fc-stat-label">Complete</div>
        </div>
      </div>
      <div style="height:6px;background:rgba(var(--ovl),.06);border-radius:3px;overflow:hidden;margin-bottom:16px;">
        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,var(--gold),var(--gold-l));transition:width .4s;"></div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
        <button class="btn-gold" style="font-size:14px;padding:12px 22px;" onclick="startFlashcardStudySession('${h(subj)}', 'subject')">
          🎴 Start Study Session (${total} card${total!==1?'s':''})
        </button>
      </div>
    </div>
  `;

  // Warm the subject's card list while the student reads this page, so
  // Start Study Session opens from cache with no network wait.
  prefetchFlashcardCards(subj);

  // Topic tree (reuses Session 3c helpers)
  const sections = syllabusCache[subj]?.sections || [];
  const counts = _fcBundleCache.topicCountsBySubject[subj] || {};
  if (sections.length) {
    renderFlashcardTopicTree(topicsSlot, subj, sections, counts);
  } else {
    // Syllabus not loaded yet — loadSubjectSyllabus call above will re-trigger us
    topicsSlot.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:14px;text-align:center;">Loading topic structure…</div>';
  }
}

// Render the hierarchical topic tree for the Flashcards tab.
// Visual convention matches the Learn tab (Roman-numeral section headers,
// collapsible groups, clickable leaves) but filters to ONLY topics that
// have at least one enabled card.
// opts.showLabel — the in-session outline column supplies its own sticky
// "Browse by Topic" header, so it renders the tree without the inline one.
function renderFlashcardTopicTree(container, subj, sections, countsByNodeId, opts = {}) {
  const showLabel = opts.showLabel !== false;
  const labelHtml = showLabel
    ? '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:18px 0 10px;">Browse by Topic</div>'
    : '';
  // Recursively filter: keep nodes that either (a) have cards attached
  // directly OR (b) have at least one surviving descendant with cards.
  // CRITICAL: A node can have BOTH its own cards AND children. We must
  // check the node's own count regardless of whether its children survive.
  function prune(nodes) {
    const out = [];
    for (const node of (nodes || [])) {
      const children = node.children || [];
      const selfCount = countsByNodeId[node.id] || 0;
      const keptChildren = prune(children);

      if (node.type === 'section') {
        // Section headers are kept only if any descendant survives.
        if (keptChildren.length > 0) {
          out.push({ ...node, children: keptChildren });
        }
      } else if (keptChildren.length > 0 || selfCount > 0) {
        // Non-section node: keep if EITHER the node has own cards
        // OR it has surviving child descendants.
        out.push({ ...node, children: keptChildren });
      }
      // else: drop the node
    }
    return out;
  }

  const filtered = prune(sections);

  if (!filtered.length) {
    container.innerHTML = labelHtml + `
      <div style="padding:24px;text-align:center;color:var(--muted);font-size:12px;background:var(--card2);border:1px solid var(--bdr2);border-radius:10px;">
        No topics have flashcards yet. Use the due-queue button above to study cards as they get imported.
      </div>
    `;
    return;
  }

  container.innerHTML = labelHtml + `
    <div class="fc-topic-tree" id="fc-topic-tree-${h(subj)}"></div>
  `;

  const treeEl = container.querySelector('.fc-topic-tree');
  // Remembered so refreshFlashcardTreeCompletion() can recompute roll-ups
  // in place after a mark-done, without re-rendering (which would collapse
  // scroll position and re-run the whole prune).
  _fcRenderedTree = { subj, nodes: filtered, counts: countsByNodeId };
  renderFlashcardTreeNodes(filtered, treeEl, subj, countsByNodeId, 0);
}

// ── Topic completion roll-up ─────────────────────────────────
// The tree currently painted into #fc-topics-slot, kept so completion
// state can be recomputed without a full re-render.
let _fcRenderedTree = null;

// Total/done card tallies for a node INCLUDING all descendants. A node is
// "complete" only at 100% — partial progress keeps the neutral styling.
function fcNodeTally(node, counts, doneCounts) {
  let total = counts[node.id] || 0;
  let done = Math.min(doneCounts[node.id] || 0, total);
  for (const child of (node.children || [])) {
    const t = fcNodeTally(child, counts, doneCounts);
    total += t.total;
    done += t.done;
  }
  return { total, done };
}

function fcIsNodeComplete(node, counts, doneCounts) {
  const { total, done } = fcNodeTally(node, counts, doneCounts);
  return total > 0 && done >= total;
}

// Repaint just the green/neutral completion state on the already-rendered
// tree. Called after every mark-done so finishing a topic lights up live.
function refreshFlashcardTreeCompletion() {
  if (!_fcRenderedTree) return;
  const { subj, nodes, counts } = _fcRenderedTree;
  const treeEl = document.getElementById('fc-topic-tree-' + subj);
  if (!treeEl) return;
  const doneCounts = _fcBundleCache?.doneTopicCountsBySubject?.[subj] || {};

  (function walk(list) {
    for (const node of list) {
      const tally = fcNodeTally(node, counts, doneCounts);
      const complete = tally.total > 0 && tally.done >= tally.total;
      const row = node.id
        ? treeEl.querySelector('[data-fc-node="' + CSS.escape(node.id) + '"]')
        : null;
      if (row) {
        row.classList.toggle('fc-complete', complete);
        const badge = row.querySelector('.fc-count-badge');
        if (badge) fcPaintCountBadge(badge, counts[node.id] || 0, doneCounts[node.id] || 0);
      }
      if (node.children?.length) walk(node.children);
    }
  })(nodes);
}

// A leaf/self badge shows "N cards" until every card in it is done, then
// flips to a green "✓ N/N".
function fcPaintCountBadge(badgeEl, total, doneRaw) {
  const done = Math.min(doneRaw, total);
  const complete = total > 0 && done >= total;
  badgeEl.classList.toggle('fc-badge-complete', complete);
  badgeEl.textContent = complete
    ? '✓ ' + done + '/' + total
    : total + ' card' + (total !== 1 ? 's' : '');
}

function renderFlashcardTreeNodes(nodes, container, subj, counts, depth) {
  const doneCounts = _fcBundleCache?.doneTopicCountsBySubject?.[subj] || {};
  for (const node of nodes) {
    const children = node.children || [];
    const displayName = node.title || node.name || '';
    // Roll-up: green only at 100%, so a parent lights up once every
    // descendant topic is finished.
    const nodeComplete = fcIsNodeComplete(node, counts, doneCounts);

    if (node.type === 'section') {
      // Roman numeral section header — expandable, non-clickable
      const headerEl = document.createElement('div');
      headerEl.className = 'tl-section-header';
      if (node.id) headerEl.setAttribute('data-fc-node', node.id);
      if (nodeComplete) headerEl.classList.add('fc-complete');
      const arrowEl = document.createElement('span');
      arrowEl.className = 'tl-expand-arrow open';
      arrowEl.textContent = '▶';
      const nameEl = document.createElement('span');
      nameEl.className = 'tl-section-name';
      nameEl.textContent = (node.label ? node.label + '. ' : '') + displayName;
      headerEl.appendChild(arrowEl);
      headerEl.appendChild(nameEl);
      const bodyEl = document.createElement('div');
      bodyEl.className = 'tl-group-body open';
      // Default collapsed; user clicks to expand. Map preserves user choice within session.
      const sectionPriorExpanded = _fcExpandState.has(node.id) ? _fcExpandState.get(node.id) : false;
      if (!sectionPriorExpanded) {
        arrowEl.classList.remove('open');
        bodyEl.classList.remove('open');
      }
      headerEl.addEventListener('click', () => {
        arrowEl.classList.toggle('open');
        bodyEl.classList.toggle('open');
        _fcExpandState.set(node.id, bodyEl.classList.contains('open'));
      });
      container.appendChild(headerEl);
      container.appendChild(bodyEl);
      if (children.length) renderFlashcardTreeNodes(children, bodyEl, subj, counts, depth + 1);

    } else if (children.length > 0) {
      // Has children — render as expandable group.
      // If THIS node also has its own cards, we add a clickable "Study this group's cards"
      // row at the top of the expanded body.
      const selfCount = counts[node.id] || 0;

      const groupEl = document.createElement('div');
      groupEl.className = 'tl-group';
      if (node.id) groupEl.setAttribute('data-node-id', node.id);
      const headerEl = document.createElement('div');
      headerEl.className = 'tl-group-header';
      if (node.id) headerEl.setAttribute('data-fc-node', node.id);
      if (nodeComplete) headerEl.classList.add('fc-complete');
      const arrowEl = document.createElement('span');
      arrowEl.className = 'tl-expand-arrow open';
      arrowEl.textContent = '▶';
      const nameEl = document.createElement('span');
      nameEl.className = 'tl-group-name';
      nameEl.textContent = (node.label ? node.label + '. ' : '') + displayName;
      headerEl.appendChild(arrowEl);
      headerEl.appendChild(nameEl);

      // If the group node itself has cards, show a small badge on the header
      if (selfCount > 0) {
        const selfBadge = document.createElement('span');
        selfBadge.className = 'tl-cached-badge fc-count-badge';
        selfBadge.style.marginLeft = '6px';
        fcPaintCountBadge(selfBadge, selfCount, doneCounts[node.id] || 0);
        headerEl.appendChild(selfBadge);
      }

      const bodyEl = document.createElement('div');
      bodyEl.className = 'tl-group-body open';
      // Default collapsed; user clicks to expand. Map preserves user choice within session.
      const groupPriorExpanded = _fcExpandState.has(node.id) ? _fcExpandState.get(node.id) : false;
      if (!groupPriorExpanded) {
        arrowEl.classList.remove('open');
        bodyEl.classList.remove('open');
      }
      headerEl.addEventListener('click', (ev) => {
        ev.stopPropagation();
        arrowEl.classList.toggle('open');
        bodyEl.classList.toggle('open');
        _fcExpandState.set(node.id, bodyEl.classList.contains('open'));
      });
      groupEl.appendChild(headerEl);
      groupEl.appendChild(bodyEl);
      container.appendChild(groupEl);

      // If this node has its own cards, prepend a clickable "Study these" row
      if (selfCount > 0) {
        const selfStudyEl = document.createElement('div');
        selfStudyEl.className = 'tl-topic fc-topic-leaf';
        selfStudyEl.style.cssText = 'font-style:italic;opacity:.9;';
        const selfCheckEl = document.createElement('span');
        selfCheckEl.className = 'tl-topic-check';
        selfCheckEl.textContent = '🎴';
        const selfNameEl = document.createElement('span');
        selfNameEl.className = 'tl-topic-name';
        selfNameEl.textContent = '▸ Study cards for "' + displayName + '"';
        selfStudyEl.appendChild(selfCheckEl);
        selfStudyEl.appendChild(selfNameEl);
        selfStudyEl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (node.id) startFlashcardStudySession(subj, 'topic', node.id);
        });
        bodyEl.appendChild(selfStudyEl);
      }

      renderFlashcardTreeNodes(children, bodyEl, subj, counts, depth + 1);

    } else {
      // Pure leaf (no children) — clickable row that starts a topic session.
      const selfCount = counts[node.id] || 0;
      if (selfCount === 0) continue; // defensive: prune should have excluded this
      const topicEl = document.createElement('div');
      topicEl.className = 'tl-topic fc-topic-leaf';
      topicEl.setAttribute('data-node-id', node.id || '');
      if (node.id) topicEl.setAttribute('data-fc-node', node.id);
      if (nodeComplete) topicEl.classList.add('fc-complete');
      const checkEl = document.createElement('span');
      checkEl.className = 'tl-topic-check';
      checkEl.textContent = '🎴';
      const nameEl = document.createElement('span');
      nameEl.className = 'tl-topic-name';
      nameEl.textContent = (node.label ? node.label + '. ' : '') + displayName;
      const badgeEl = document.createElement('span');
      badgeEl.className = 'tl-cached-badge fc-count-badge';
      fcPaintCountBadge(badgeEl, selfCount, doneCounts[node.id] || 0);
      topicEl.appendChild(checkEl);
      topicEl.appendChild(nameEl);
      topicEl.appendChild(badgeEl);
      topicEl.addEventListener('click', () => {
        if (node.id) startFlashcardStudySession(subj, 'topic', node.id);
      });
      container.appendChild(topicEl);
    }
  }
}

// ── Card list cache ──────────────────────────────────────────
// Keyed 'subject' for subject-wide sets and 'subject::nodeId' for single
// topics. Cards are stored WITHOUT a `done` property — done state lives
// only in _fcDoneSet, so one cached list can never disagree with another
// (or with the Overview widget) after a mark-done.
const _fcCardsCache = new Map();
const _fcCardsInflight = new Map();

function _fcCacheKey(subj, nodeId) {
  return nodeId ? subj + '::' + nodeId : subj;
}

// Fetch (or replay from cache) the cards for a subject or a single topic.
// Subject-wide sets come from ONE request — the old code fired one request
// per topic, which is what made "Start Study Session" take seconds.
function loadFlashcardCards(subj, nodeId, { force = false } = {}) {
  const key = _fcCacheKey(subj, nodeId);
  if (!force && _fcCardsCache.has(key)) return Promise.resolve(_fcCardsCache.get(key));
  if (_fcCardsInflight.has(key)) return _fcCardsInflight.get(key);

  const url = nodeId
    ? '/api/flashcards/topic/' + encodeURIComponent(subj) + '/' + encodeURIComponent(nodeId)
    : '/api/flashcards/subject/' + encodeURIComponent(subj);

  const p = (async () => {
    try {
      const resp = await fetch(url, { headers: { 'x-session-token': sessionToken || '' } });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'Failed to load cards');
      const cards = (data.cards || []).map(c => {
        // Seed the done set from the server's per-card flag, then strip it.
        if (c.done) _fcDoneSet.add(c.id);
        const { done, ...rest } = c;
        return rest;
      });
      _fcCardsCache.set(key, cards);
      return cards;
    } finally {
      _fcCardsInflight.delete(key);
    }
  })();
  _fcCardsInflight.set(key, p);
  return p;
}

// Warm the subject-wide card list in the background while the student is
// still looking at the Flashcards tab, so tapping Start Study Session
// paints from cache with no network wait at all.
function prefetchFlashcardCards(subj) {
  if (!subj || _fcCardsCache.has(subj) || _fcCardsInflight.has(subj)) return;
  const total = _fcBundleCache?.totalBySubject?.[subj] || 0;
  if (total === 0) return;
  const kick = () => loadFlashcardCards(subj).catch(() => {});
  if (window.requestIdleCallback) requestIdleCallback(kick, { timeout: 1200 });
  else setTimeout(kick, 250);
}

function isFlashcardDone(card) {
  return !!card && _fcDoneSet.has(card.id);
}

async function startFlashcardStudySession(subj, mode, nodeId) {
  // Remember the last-clicked topic so endFlashcardSession can return the user there.
  const topicId = mode === 'topic' && nodeId
    ? (Array.isArray(nodeId) ? nodeId[0] : nodeId)
    : null;
  if (topicId) _fcLastClickedNodeId = topicId;

  const key = _fcCacheKey(subj, topicId);
  const cached = _fcCardsCache.get(key);

  // Nothing cached yet → show a loading shell immediately instead of a
  // dead-looking button, so the tap always produces instant feedback.
  if (!cached) _renderFlashcardLoading();

  try {
    const cards = cached || await loadFlashcardCards(subj, topicId);

    if (!cards.length) {
      showToast('No cards to study', 'info');
      if (!cached) _restoreFlashcardsTab(subj);
      return;
    }

    _fcSession = {
      subject: subj,
      mode,
      cards,
      position: 0,
      startedAt: new Date(),
      currentFlipped: false,
      nodeIdFilter: topicId,
    };

    renderFlashcardCardViewer();
    attachFlashcardKeyboardListener();
  } catch(e) {
    showToast('Study session failed: ' + e.message, 'error');
    _restoreFlashcardsTab(subj);
  }
}

// Rebuild the whole Flashcards tab. Needed after the loading shell has
// replaced the tab's markup — paintFlashcardsTabFromBundle only fills the
// stats/topics slots and no-ops when they're gone.
function _restoreFlashcardsTab(subj) {
  const container = document.getElementById('subject-tab-content');
  if (container) renderFlashcardsTab(subj, container);
}

function _renderFlashcardLoading() {
  const container = document.getElementById('subject-tab-content');
  if (!container) return;
  container.innerHTML = `
    <div class="fc-viewer-wrap">
      <div class="fc-card-outer">
        <div class="fc-card-face fc-card-loading" style="position:relative;min-height:320px;align-items:center;justify-content:center;">
          <div style="font-size:34px;margin-bottom:10px;opacity:.5;">🎴</div>
          <div style="font-size:12px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;">Shuffling your deck…</div>
        </div>
      </div>
    </div>
  `;
}

// The viewer is built ONCE per session; every subsequent interaction
// (flip, next, prev, mark-done) mutates the existing nodes instead of
// re-writing innerHTML. Re-parsing the whole viewer on every tap is what
// made the cards feel unresponsive, and it also killed the CSS flip
// transition — a freshly-inserted element can't animate into its class.
let _fcEls = null;

const FC_TYPE_BADGES = {
  definition: '📖 Definition',
  elements: '🔢 Elements',
  distinction: '⚖️ Distinction',
};

function renderFlashcardCardViewer() {
  if (!_fcSession) return;
  const container = document.getElementById('subject-tab-content');
  if (!container) return;

  if (!_fcSession.cards[_fcSession.position]) {
    renderFlashcardSessionSummary();
    return;
  }

  container.innerHTML = `
    <div class="fc-study-layout">
    <aside class="fc-study-outline">
      <div class="fc-outline-head">Browse by Topic</div>
      <div class="fc-outline-scroll" id="fc-session-outline"></div>
    </aside>
    <div class="fc-study-main">
    <div class="fc-viewer-wrap">
      <div class="fc-viewer-topbar" style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:12px;min-width:0;flex:1;">
          <div class="fc-count" style="font-size:11px;color:var(--muted);white-space:nowrap;"></div>
          <div style="flex:1;min-width:80px;max-width:220px;height:4px;background:rgba(var(--ovl),.06);border-radius:2px;overflow:hidden;">
            <div class="fc-progress-fill" style="height:100%;background:linear-gradient(90deg,var(--gold),var(--gold-l));width:0%;transition:width .25s;"></div>
          </div>
        </div>
        <button class="btn-og" onclick="endFlashcardSession()" style="font-size:11px;padding:5px 10px;">End Session</button>
      </div>

      <div class="fc-card-outer">
        <div class="fc-card">
          <div class="fc-card-face fc-card-front">
            <div class="fc-card-type-badge"></div>
            <div class="fc-card-content"></div>
            <div class="fc-card-hint">Tap or press Space to flip</div>
          </div>
          <div class="fc-card-face fc-card-back">
            <div class="fc-card-type-badge"></div>
            <div class="fc-card-content"></div>
            <div class="fc-card-source" style="display:none;"></div>
            <div class="fc-card-path" style="font-size:10px;color:var(--muted);margin-top:8px;opacity:.7;"></div>
          </div>
        </div>
      </div>

      <div class="fc-nav-row">
        <button class="fc-nav-btn fc-nav-prev" onclick="goPrevFlashcard()">
          <div class="fc-nav-key">←</div>
          <div class="fc-nav-label">Previous</div>
        </button>
        <button class="fc-nav-btn fc-nav-done" onclick="toggleFlashcardDone()">
          <div class="fc-nav-key">D</div>
          <div class="fc-nav-label">Mark as Done</div>
        </button>
        <button class="fc-nav-btn fc-nav-next" onclick="goNextFlashcard()">
          <div class="fc-nav-key">→</div>
          <div class="fc-nav-label">Next</div>
        </button>
      </div>
    </div>
    </div>
    </div>
  `;

  // Widens .pg-inner and sticks the title + tab row while studying.
  document.getElementById('page-subject')?.classList.add('fc-session-active');
  _fcRenderSessionOutline(_fcSession.subject);
  // Start from the top of the page. A session is usually launched by clicking
  // a topic partway down a long outline, so the page is scrolled — and
  // _fcSizeStudyLayout measures a viewport-relative top, which would then be
  // wrong and leave the nav row below the fold.
  window.scrollTo(0, 0);
  // Size immediately so there is always a sane height, then again once the
  // sticky header and widened .pg-inner have settled. The second pass is not
  // relied on alone: rAF is throttled in a background tab, and a session can
  // be started and left before it ever fires.
  _fcSizeStudyLayout();
  requestAnimationFrame(() => _fcSizeStudyLayout());
  _fcBindStudyLayoutResize();

  const q = sel => container.querySelector(sel);
  _fcEls = {
    card:       q('.fc-card'),
    count:      q('.fc-count'),
    progress:   q('.fc-progress-fill'),
    frontBadge: q('.fc-card-front .fc-card-type-badge'),
    frontBody:  q('.fc-card-front .fc-card-content'),
    backBadge:  q('.fc-card-back .fc-card-type-badge'),
    backBody:   q('.fc-card-back .fc-card-content'),
    source:     q('.fc-card-source'),
    path:       q('.fc-card-path'),
    prevBtn:    q('.fc-nav-prev'),
    nextBtn:    q('.fc-nav-next'),
    doneBtn:    q('.fc-nav-done'),
    doneLabel:  q('.fc-nav-done .fc-nav-label'),
  };

  _attachFlashcardTapHandlers(_fcEls.card);
  _fcPaintCard({ animate: false });
}

// Fit the two-column study frame to whatever space is left below the
// sticky title/tab block, so the page itself doesn't scroll while studying.
// Measured rather than hard-coded because the subject header's height moves
// with its metadata line and the tab row wraps on narrower widths.
function _fcSizeStudyLayout() {
  const layout = document.querySelector('.fc-study-layout');
  if (!layout) return;
  if (window.innerWidth <= 900) { layout.style.height = ''; return; } // stacked
  const top = layout.getBoundingClientRect().top;
  // Floor low enough that the card can still shrink on short viewports. Above
  // it the card's own scroller takes over, so the nav row stays put instead of
  // the whole page scrolling and pushing the buttons out of view.
  layout.style.height = Math.max(300, window.innerHeight - top - 18) + 'px';
}

let _fcResizeHandler = null;
function _fcBindStudyLayoutResize() {
  if (_fcResizeHandler) return;
  _fcResizeHandler = () => _fcSizeStudyLayout();
  window.addEventListener('resize', _fcResizeHandler);
}
function _fcUnbindStudyLayoutResize() {
  if (!_fcResizeHandler) return;
  window.removeEventListener('resize', _fcResizeHandler);
  _fcResizeHandler = null;
}

// Paint the topic outline that sits beside the card during a session. It's
// the same tree (and the same green completion roll-ups) as the overview
// screen, so refreshFlashcardTreeCompletion keeps updating it live as cards
// are marked done — clicking a row restarts the session on that topic.
function _fcRenderSessionOutline(subj) {
  const slot = document.getElementById('fc-session-outline');
  if (!slot || !subj) return;
  const sections = syllabusCache[subj]?.sections || [];
  const counts = _fcBundleCache?.topicCountsBySubject?.[subj] || {};
  if (!sections.length) {
    slot.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:12px;">Loading topics…</div>';
    // Syllabus isn't cached yet — paint once it lands, if still studying.
    loadSubjectSyllabus(subj).then(() => {
      if (_fcSession && document.getElementById('fc-session-outline')) {
        _fcRenderSessionOutline(subj);
      }
    });
    return;
  }
  renderFlashcardTopicTree(slot, subj, sections, counts, { showLabel: false });
  _fcSyncOutlineActiveTopic();
}

// Mark which topic the visible card belongs to and keep it in view. Only
// scrolls the outline's own container, never the page.
function _fcSyncOutlineActiveTopic() {
  const slot = document.getElementById('fc-session-outline');
  if (!slot || !_fcSession) return;
  const card = _fcSession.cards[_fcSession.position];
  slot.querySelectorAll('.fc-active-topic').forEach(el => el.classList.remove('fc-active-topic'));
  if (!card?.node_id) return;
  const row = slot.querySelector('[data-fc-node="' + CSS.escape(card.node_id) + '"]');
  if (!row) return;
  row.classList.add('fc-active-topic');
  // Reveal it if a collapsed ancestor is hiding it.
  let p = row.parentElement;
  while (p && p !== slot) {
    if (p.classList.contains('tl-group-body') && !p.classList.contains('open')) {
      p.classList.add('open');
      p.previousElementSibling?.querySelector('.tl-expand-arrow')?.classList.add('open');
    }
    p = p.parentElement;
  }
  const box = slot.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  if (r.top < box.top || r.bottom > box.bottom) {
    slot.scrollTop += (r.top - box.top) - box.height / 2 + r.height / 2;
  }
}

// Flip on pointerup rather than click: it fires at the moment the finger
// lifts (no ~300ms mobile click delay, no waiting on a dblclick check),
// while the movement/time guards keep scrolling long card backs and
// selecting text from being misread as a flip.
function _attachFlashcardTapHandlers(cardEl) {
  if (!cardEl) return;
  let startX = 0, startY = 0, startT = 0, tracking = false;

  cardEl.addEventListener('pointerdown', ev => {
    if (ev.button != null && ev.button !== 0) return;   // left / touch / pen only
    tracking = true;
    startX = ev.clientX; startY = ev.clientY; startT = Date.now();
    cardEl.classList.add('fc-card-pressed');
  });

  const clearPress = () => { cardEl.classList.remove('fc-card-pressed'); };
  cardEl.addEventListener('pointercancel', () => { tracking = false; clearPress(); });
  cardEl.addEventListener('pointerleave', clearPress);

  cardEl.addEventListener('pointerup', ev => {
    clearPress();
    if (!tracking) return;
    tracking = false;
    const moved = Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY);
    if (moved > 12) return;                                 // scroll / drag, not a tap
    if (Date.now() - startT > 700) return;                  // long-press, not a tap
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return; // text selection
    flipFlashcard();
  });
}

// Paint the current card into the existing DOM. `animate: false` suppresses
// the flip transition so advancing a card while flipped snaps back to the
// front instead of visibly rotating with the next card's text showing.
function _fcPaintCard({ animate = true } = {}) {
  if (!_fcSession || !_fcEls?.card) return;
  const { cards, position, currentFlipped } = _fcSession;
  const card = cards[position];
  if (!card) return;

  _fcPaintDoneState();
  _fcSyncOutlineActiveTopic();
  _fcEls.frontBody.textContent = card.front || '';
  _fcEls.backBody.innerHTML = formatFlashcardBack(card.back);
  _fcEls.path.textContent = card.node_path || '';

  if (card.source_snippet) {
    _fcEls.source.style.display = '';
    _fcEls.source.textContent = '📚 ' + card.source_snippet;
  } else {
    _fcEls.source.style.display = 'none';
  }

  // Both faces scroll independently — reset them so a new card always
  // starts at the top.
  _fcEls.frontBody.scrollTop = 0;
  _fcEls.backBody.scrollTop = 0;

  if (!animate) _fcEls.card.classList.add('fc-no-anim');
  _fcEls.card.classList.toggle('fc-card-flipped', !!currentFlipped);
  if (!animate) {
    void _fcEls.card.offsetWidth; // flush the class change before re-enabling transitions
    _fcEls.card.classList.remove('fc-no-anim');
  }

  const pct = Math.round(((position + 1) / cards.length) * 100);
  _fcEls.count.textContent = `Card ${position + 1} of ${cards.length}`;
  _fcEls.progress.style.width = pct + '%';
  _fcEls.prevBtn.disabled = position === 0;
  // Last card stays enabled — it advances to the session summary.
  const atEnd = position === cards.length - 1;
  _fcEls.nextBtn.querySelector('.fc-nav-label').textContent = atEnd ? 'Finish' : 'Next';
}

// Just the done affordances (badges, card outline, nav button) — the only
// thing a mark-done changes, so toggling it never touches the flip state.
function _fcPaintDoneState() {
  if (!_fcSession || !_fcEls?.card) return;
  const card = _fcSession.cards[_fcSession.position];
  if (!card) return;

  const isDone = isFlashcardDone(card);
  const badge = FC_TYPE_BADGES[card.card_type] || card.card_type || '';
  const badgeHtml = h(badge) + (isDone ? '<span style="color:var(--teal);margin-left:6px;">✓ Done</span>' : '');

  _fcEls.frontBadge.innerHTML = badgeHtml;
  _fcEls.backBadge.innerHTML = badgeHtml;
  _fcEls.card.classList.toggle('fc-card-done', isDone);
  _fcEls.doneBtn.classList.toggle('fc-nav-done-active', isDone);
  _fcEls.doneLabel.textContent = isDone ? '✓ Marked Done' : 'Mark as Done';
}

function formatFlashcardBack(text) {
  const safe = h(String(text || ''));
  return safe
    .replace(/\n/g, '<br>')
    .replace(/(^|<br>)(\s*)(\d+[.)])\s/g, '$1$2<strong>$3</strong> ');
}

// Flip is a pure class toggle — no re-render, so the CSS transition runs
// and the card responds on the same frame as the tap.
function flipFlashcard() {
  if (!_fcSession || !_fcEls?.card) return;
  _fcSession.currentFlipped = !_fcSession.currentFlipped;
  _fcEls.card.classList.toggle('fc-card-flipped', _fcSession.currentFlipped);
}

function goPrevFlashcard() {
  if (!_fcSession) return;
  if (_fcSession.position > 0) {
    _fcSession.position -= 1;
    _fcSession.currentFlipped = false;
    _fcPaintCard({ animate: false });
  }
}

function goNextFlashcard() {
  if (!_fcSession) return;
  if (_fcSession.position < _fcSession.cards.length - 1) {
    _fcSession.position += 1;
    _fcSession.currentFlipped = false;
    _fcPaintCard({ animate: false });
  } else {
    // At the last card — move to summary
    renderFlashcardSessionSummary();
  }
}

// In-flight mark-done writes. endFlashcardSession waits on these before
// reconciling the bundle with the server.
let _fcMarkDonePending = [];

// Optimistic: the done state flips locally and repaints immediately, then
// the request goes out. On failure we roll back and tell the user. This is
// what makes rapid D-key / button tapping feel instant.
function toggleFlashcardDone() {
  if (!_fcSession) return;
  const card = _fcSession.cards[_fcSession.position];
  if (!card) return;
  const newDone = !isFlashcardDone(card);

  _applyFlashcardDoneLocally(card, newDone, _fcSession.subject);
  _fcPaintDoneState();

  const p = fetch('/api/flashcards/mark-done', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-token': sessionToken || '',
    },
    body: JSON.stringify({ flashcardId: card.id, done: newDone }),
  })
    .then(async resp => {
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || 'Mark-done failed');
      }
    })
    .catch(e => {
      // Roll back the optimistic update
      _applyFlashcardDoneLocally(card, !newDone, _fcSession?.subject);
      if (_fcSession?.cards[_fcSession.position]?.id === card.id) {
        _fcPaintDoneState();
      }
      showToast('Mark-done failed: ' + e.message, 'error');
    })
    .finally(() => {
      _fcMarkDonePending = _fcMarkDonePending.filter(x => x !== p);
    });
  _fcMarkDonePending.push(p);
}

// Single place that mutates done state: the id set plus the cached
// per-subject counters that drive the Overview bars and sidebar badge.
function _applyFlashcardDoneLocally(card, done, fallbackSubj) {
  const subj = card.subject || fallbackSubj;
  const already = _fcDoneSet.has(card.id);
  if (done === already) return;

  if (done) _fcDoneSet.add(card.id);
  else _fcDoneSet.delete(card.id);

  if (_fcBundleCache) {
    const counts = _fcBundleCache.doneCountBySubject;
    if (counts && counts[subj] != null) {
      counts[subj] = done
        ? counts[subj] + 1
        : Math.max(0, counts[subj] - 1);
    }
    // Keep the per-topic tally in step so the topic tree's green completion
    // state stays correct without refetching the bundle.
    const nodeId = card.node_id;
    if (subj && nodeId) {
      const byNode = _fcBundleCache.doneTopicCountsBySubject
        || (_fcBundleCache.doneTopicCountsBySubject = {});
      const forSubj = byNode[subj] || (byNode[subj] = {});
      forSubj[nodeId] = done
        ? (forSubj[nodeId] || 0) + 1
        : Math.max(0, (forSubj[nodeId] || 0) - 1);
    }
    if (done) {
      _fcBundleCache.doneCardIds = _fcBundleCache.doneCardIds || [];
      _fcBundleCache.doneCardIds.push(card.id);
    } else if (Array.isArray(_fcBundleCache.doneCardIds)) {
      _fcBundleCache.doneCardIds = _fcBundleCache.doneCardIds.filter(id => id !== card.id);
    }
  }

  // Keep the Overview subject bars + widget live while studying.
  refreshFlashcardProgressUI(subj);
}

function renderFlashcardSessionSummary() {
  if (!_fcSession) return;
  const container = document.getElementById('subject-tab-content');
  if (!container) return;

  const { cards, startedAt, subject } = _fcSession;
  const doneInSession = cards.filter(isFlashcardDone).length;
  const total = cards.length;
  _fcEls = null;
  // Summary is a single centred panel — drop the two-column study frame.
  document.getElementById('page-subject')?.classList.remove('fc-session-active');
  _fcUnbindStudyLayoutResize();
  const elapsedMs = Date.now() - startedAt.getTime();
  const elapsedMin = Math.max(1, Math.round(elapsedMs / 60000));
  const pct = total > 0 ? Math.round((doneInSession / total) * 100) : 0;

  container.innerHTML = `
    <div class="fc-summary-wrap" style="text-align:center;padding:32px 20px;">
      <div style="font-size:54px;margin-bottom:12px;">🎉</div>
      <h2 style="font-family:var(--fd);font-size:26px;font-weight:700;color:var(--gold-l);margin-bottom:6px;">Session Complete!</h2>
      <p style="font-size:13px;color:var(--muted);margin-bottom:24px;">
        You spent ${elapsedMin} minute${elapsedMin!==1?'s':''} reviewing ${total} card${total!==1?'s':''}.
      </p>

      <div class="fc-summary-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;max-width:520px;margin:0 auto 24px;">
        <div class="fc-summary-stat" style="background:rgba(46,196,160,.08);border:1px solid rgba(46,196,160,.2);border-radius:10px;padding:14px;">
          <div style="font-size:28px;font-weight:700;color:var(--teal);">${doneInSession}</div>
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;">Marked Done</div>
        </div>
        <div class="fc-summary-stat" style="background:rgba(201,168,76,.08);border:1px solid rgba(201,168,76,.2);border-radius:10px;padding:14px;">
          <div style="font-size:28px;font-weight:700;color:var(--gold-l);">${pct}%</div>
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;">Completion</div>
        </div>
      </div>

      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
        <button class="btn-gold" onclick="endFlashcardSession()" style="font-size:13px;padding:10px 18px;">🎴 Back to Flashcards</button>
      </div>
    </div>
  `;

  detachFlashcardKeyboardListener();
  // Refresh sidebar badge + widget (bundle already updated optimistically)
  refreshSidebarFlashcardBadge();
}

function endFlashcardSession() {
  const subj = _fcSession?.subject;
  const nodeIdToRestore = _fcLastClickedNodeId; // captured before _fcSession is cleared
  _fcSession = null;
  _fcEls = null;
  document.getElementById('page-subject')?.classList.remove('fc-session-active');
  _fcUnbindStudyLayoutResize();
  detachFlashcardKeyboardListener();
  // Safety: reconcile the bundle with the server. Waits for any in-flight
  // mark-done writes first — refetching mid-write would pull a stale count
  // and visibly undo the optimistic update.
  const pending = _fcMarkDonePending.slice();
  Promise.allSettled(pending).then(() => {
    fetchFlashcardBundle(true).then(() => {
      refreshFlashcardProgressUI();
      if (!_fcSession && document.getElementById('fc-stats-slot') && subj) {
        paintFlashcardsTabFromBundle(subj);
      }
    });
  });
  if (subj) {
    const content = document.getElementById('subject-tab-content');
    if (content) {
      renderFlashcardsTab(subj, content);
      // After the tab re-renders its tree, scroll to the remembered node.
      // renderFlashcardsTab is synchronous from cache when bundle is warm, so
      // the DOM should be ready immediately; use a short timeout as a safety
      // net in case of any async paint.
      if (nodeIdToRestore) {
        setTimeout(() => scrollFlashcardNodeIntoView(nodeIdToRestore), 50);
      }
    }
  }
  refreshSidebarFlashcardBadge();
}

// Scroll the given topic node into view within the flashcards topic tree
// and flash-highlight it briefly so the user knows where they are.
function scrollFlashcardNodeIntoView(nodeId) {
  if (!nodeId) return;
  // Find any DOM element tagged with this nodeId. Our tree uses
  // data-node-id on leaf rows; groups don't have it yet, so leaves
  // are the primary target. We search within the Flashcards tab container.
  const container = document.getElementById('subject-tab-content');
  if (!container) return;
  const el = container.querySelector('[data-node-id="' + nodeId.replace(/"/g, '\\"') + '"]');
  if (!el) return;
  // Expand any collapsed ancestor groups so the element is actually visible
  let anc = el.parentElement;
  while (anc && anc !== container) {
    if (anc.classList && anc.classList.contains('tl-group-body') && !anc.classList.contains('open')) {
      anc.classList.add('open');
      // Also flip the sibling header's arrow
      const hdr = anc.previousElementSibling;
      if (hdr) {
        const arrow = hdr.querySelector('.tl-expand-arrow');
        if (arrow) arrow.classList.add('open');
      }
    }
    anc = anc.parentElement;
  }
  // Scroll into view
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Flash-highlight
  el.classList.add('fc-flash-highlight');
  setTimeout(() => { el.classList.remove('fc-flash-highlight'); }, 1600);
}

// ── Keyboard shortcuts ───────────────────────────────────────
let _fcKeyboardListener = null;
function attachFlashcardKeyboardListener() {
  if (_fcKeyboardListener) return;
  _fcKeyboardListener = (ev) => {
    if (!_fcSession) return;
    const tag = (ev.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

    // Held keys shouldn't machine-gun a toggle; arrows may repeat so the
    // student can scrub through a deck by holding the key down.
    if (ev.code === 'Space' || ev.key === 'Enter' || ev.key === 'f' || ev.key === 'F') {
      if (ev.repeat) return;
      ev.preventDefault();
      flipFlashcard();
    } else if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      goPrevFlashcard();
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      goNextFlashcard();
    } else if (ev.key === 'd' || ev.key === 'D') {
      if (ev.repeat) return;
      ev.preventDefault();
      toggleFlashcardDone();
    }
  };
  document.addEventListener('keydown', _fcKeyboardListener);
}

function detachFlashcardKeyboardListener() {
  if (_fcKeyboardListener) {
    document.removeEventListener('keydown', _fcKeyboardListener);
    _fcKeyboardListener = null;
  }
}

// ── Bundle fetch (Session 4) ─────────────────────────────────
async function fetchFlashcardBundle(force = false) {
  if (!force && _fcBundleCache) return _fcBundleCache;
  if (_fcBundlePromise) return _fcBundlePromise;
  _fcBundlePromise = (async () => {
    try {
      const resp = await fetch('/api/flashcards/bundle', {
        headers: { 'x-session-token': sessionToken || '' },
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      // Drop cached card lists for any subject whose card count changed
      // (e.g. an admin imported cards while this tab was open) so we never
      // study a stale deck.
      const prevTotals = _fcBundleCache?.totalBySubject || {};
      for (const subj of Object.keys(data.totalBySubject || {})) {
        if (prevTotals[subj] != null && prevTotals[subj] !== data.totalBySubject[subj]) {
          for (const key of [..._fcCardsCache.keys()]) {
            if (key === subj || key.startsWith(subj + '::')) _fcCardsCache.delete(key);
          }
        }
      }
      _fcBundleCache = data;
      _fcDoneSet = new Set(data.doneCardIds || []);
      return data;
    } catch {
      return null;
    } finally {
      _fcBundlePromise = null;
    }
  })();
  return _fcBundlePromise;
}

// Call once right after login (or when app first boots with valid session).
// After this resolves, every Flashcards tab + Overview widget + sidebar badge
// can paint synchronously from _fcBundleCache with zero network delay.
async function loadFlashcardBundleOnBoot() {
  await fetchFlashcardBundle(true);
  // Repaint any cached flashcard UI that's already visible — including the
  // Overview subject cards, whose progress bars come from this bundle and
  // would otherwise sit at 0% until the next full render.
  refreshFlashcardProgressUI();
}

// ── Overview widget ──────────────────────────────────────────
function renderDashboardFlashcardWidget() {
  const el = document.getElementById('fc-overview-widget');
  if (!el) return;
  if (!_fcBundleCache) {
    // No bundle yet (very first paint of overview before boot-load finishes).
    // Hide silently — boot-load will call renderDashboardFlashcardWidget
    // again when it resolves.
    el.style.display = 'none';
    return;
  }
  _paintFlashcardOverviewWidget(el, _fcBundleCache);
}

// Renders the aggregate flashcard progress bar inside the overview hero.
// It used to be a standalone card that also listed a chip per subject —
// the same dot, name and done/total as the subject grid directly below it,
// with the same click target. That duplicate list is gone; the subject cards
// own per-subject detail, and this owns the single overall number.
function _paintFlashcardOverviewWidget(el, bundle) {
  el.style.display = '';

  let totalCards = 0, totalDone = 0;
  for (const subj of Object.keys(bundle.totalBySubject || {})) {
    const t = bundle.totalBySubject[subj] || 0;
    // Clamp per subject, matching getSubjectFlashcardProgress — a stale done
    // count must never push the aggregate above 100%.
    totalCards += t;
    totalDone  += Math.min(t, bundle.doneCountBySubject[subj] || 0);
  }
  const overallPct = totalCards > 0 ? Math.round((totalDone / totalCards) * 100) : 0;

  if (totalCards === 0) {
    el.innerHTML = `<div class="ov-prog-empty">No flashcards imported yet — past bar questions are still available below.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="ov-prog-track"><div class="ov-prog-fill" style="width:${overallPct}%"></div></div>
    <div class="ov-prog-meta">
      <span><strong>${totalDone.toLocaleString()}</strong> of ${totalCards.toLocaleString()} flashcards done</span>
      <span class="ov-prog-pct">${overallPct}%</span>
    </div>`;
}

// ── Per-subject flashcard progress ───────────────────────────
// The single source of truth for every "progress" bar in the app. Overview
// subject cards used to show Learn-tab topic checkmarks, which went stale
// when the Learn tab was hidden — progress is now flashcards done/total.
function getSubjectFlashcardProgress(subj) {
  const total = _fcBundleCache?.totalBySubject?.[subj] || 0;
  const done  = Math.min(total, _fcBundleCache?.doneCountBySubject?.[subj] || 0);
  return {
    done,
    total,
    remaining: Math.max(0, total - done),
    pct: total > 0 ? Math.round((done / total) * 100) : 0,
    loaded: !!_fcBundleCache,
  };
}

// Update the progress affordances in place — no full re-render, so this is
// cheap enough to call after every single mark-done.
// Pass a subject to touch just that one; omit to refresh all of them.
function refreshFlashcardProgressUI(subj) {
  const subjects = subj
    ? [subj]
    : SUBJS.filter(s => s.key !== 'custom').map(s => s.key);

  for (const key of subjects) {
    const prog = getSubjectFlashcardProgress(key);
    const label = prog.total > 0
      ? `${prog.done}/${prog.total} cards`
      : 'No cards yet';

    // Overview subject card
    const ovCard = document.querySelector(`.ov-subj-card[data-subj="${key}"]`);
    if (ovCard) {
      const fill  = ovCard.querySelector('.ov-subj-prog-fill');
      const stat  = ovCard.querySelector('.ov-subj-stats span:first-child');
      const track = ovCard.querySelector('.ov-subj-prog-track');
      const pctEl = ovCard.querySelector('.ov-subj-pct');
      if (fill) fill.style.width = prog.pct + '%';
      if (stat) stat.textContent = label;
      if (pctEl) pctEl.textContent = prog.total > 0 ? prog.pct + '%' : '';
      // Drives the muted empty styling — must follow the data, or a subject
      // stays greyed out after its first cards are imported.
      ovCard.classList.toggle('is-empty', prog.total === 0);
      if (track) track.title = prog.total > 0
        ? `${prog.done} of ${prog.total} flashcards marked done`
        : 'No flashcards imported yet';
    }

    // Subject-page sidebar bar (Learn tab layout)
    const fill2 = document.getElementById('subj-progress-fill-' + key);
    const txt2  = document.getElementById('subj-progress-text-' + key);
    if (fill2) fill2.style.width = prog.pct + '%';
    if (txt2)  txt2.textContent  = `${prog.done}/${prog.total} cards · ${prog.pct}%`;
  }

  renderDashboardFlashcardWidget();
  refreshSidebarFlashcardBadge();
  // Green topic roll-ups follow marks made during a study session.
  refreshFlashcardTreeCompletion();
}

// ── Sidebar badge ────────────────────────────────────────────
function refreshSidebarFlashcardBadge() {
  const el = document.getElementById('sidebarFlashcardBadge');
  if (!el) return;
  if (!_fcBundleCache) {
    el.style.display = 'none';
    return;
  }
  // Remaining across all subjects
  let totalRemaining = 0;
  for (const subj of Object.keys(_fcBundleCache.totalBySubject || {})) {
    const t = _fcBundleCache.totalBySubject[subj] || 0;
    const d = _fcBundleCache.doneCountBySubject[subj] || 0;
    totalRemaining += Math.max(0, t - d);
  }
  if (totalRemaining > 0) {
    el.style.display = '';
    el.textContent = totalRemaining > 99 ? '99+' : String(totalRemaining);
  } else {
    el.style.display = 'none';
  }
}

function showLockedMessage(subj, mode) {
  const subjInfo = ALL_SUBJS.find(s => s.key === subj);
  showPage('mockbar'); // reuse a blank area
  document.getElementById('mockConfig').innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:65vh;text-align:center;padding:32px;">
      <div style="font-size:56px;margin-bottom:14px;">🔒</div>
      <div style="font-family:var(--fd);font-size:24px;font-weight:700;color:var(--gold-l);margin-bottom:8px;">Section Unavailable</div>
      <div style="font-size:14px;color:var(--muted);max-width:320px;line-height:1.7;margin-bottom:24px;">This section has been temporarily disabled by the administrator.</div>
      <button class="btn-gold" onclick="navToOverview()" style="font-size:13px;padding:10px 20px;">🏛 Go to Overview</button>
    </div>`;
}

// Sidebar no longer uses expand/collapse — subjects are single-click items.
// Kept as no-op for any legacy call sites.
function toggleSbSubject(subj, forceOpen) { /* no-op — sidebar uses direct navToSubject */ }

function loadLearnForSubject(subj) {
  // Delegate to subject page learn tab
  navToSubject(subj, 'learn');
}

function loadQuizForSubject(subj) {
  navToSubject(subj, 'quiz');
}

function loadMockBarForSubject(subj) {
  navToSubject(subj, 'mockbar');
}

// Legacy nav() — bridged to new system for backward compat (used inside admin HTML)
function nav(id, btn) {
  if (id === 'dashboard' || id === 'overview') { navToOverview(); return; }
  if (id === 'admin')   { navToAdmin(); return; }
  if (id === 'learn')   { navToSubject(currentSubject || SUBJS[0].key, 'learn'); return; }
  if (id === 'practice'){ navToSubject(currentSubject || SUBJS[0].key, 'quiz'); return; }
  if (id === 'mockbar') { navToSubject(currentSubject, 'mockbar'); return; }
  // Generic fallback
  showPage(id);
}

// ══════════════════════════════════
// SIDEBAR COLLAPSE
// ══════════════════════════════════
// State lives on <html> (not .sidebar) so the pre-body script in index.html
// can restore it before any layout happens — see #sidebar-state.
function setSidebarCollapsed(collapsed) {
  document.documentElement.classList.toggle('sb-collapsed', collapsed);
  const btn = document.getElementById('sbToggleBtn');
  if (btn) {
    btn.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  try { localStorage.setItem('bb_sidebar_collapsed', collapsed ? '1' : '0'); } catch(e){}
}

function toggleSidebarCollapse() {
  const collapsing = !document.documentElement.classList.contains('sb-collapsed');
  // A deliberate collapse while studying opts out of auto-expand until the
  // user navigates somewhere else.
  if (collapsing && currentMode === 'flashcards') _fcSidebarUserCollapsed = true;
  setSidebarCollapsed(collapsing);
}

// True when the user manually collapsed the rail while ON the Flashcards
// tab. Auto-expand honours that for the rest of the visit; any navigation
// away clears it (see clearSidebarActive), so coming back re-opens.
//
// This replaced a "last auto-expanded subject::flashcards key" gate, which
// was only cleared by switchSubjectTab. Leaving via Overview/Progress/Admin
// never went through there, so the stale key made every later return to
// Flashcards a silent no-op.
let _fcSidebarUserCollapsed = false;

function maybeAutoExpandSidebarForFlashcards(mode) {
  if (mode !== 'flashcards') { _fcSidebarUserCollapsed = false; return; }
  if (_fcSidebarUserCollapsed) return;
  if (document.documentElement.classList.contains('sb-collapsed')) {
    setSidebarCollapsed(false);
  }
}

// Syncs the toggle button's title/aria to whatever state the early inline
// script (in index.html, runs before app.js) already applied — avoids
// re-writing localStorage on every boot.
function initSidebarToggleState() {
  const btn = document.getElementById('sbToggleBtn');
  if (!btn) return;
  const collapsed = document.documentElement.classList.contains('sb-collapsed');
  btn.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

// ══════════════════════════════════
// SIDEBAR RENDERER
// ══════════════════════════════════
function renderSidebar() {
  const list = document.getElementById('sbSubjectList');
  if (!list) return;
  const html = SUBJS.map(s => {
    const hasMaterials = (KB.references||[]).some(r=>r.subject===s.key) || (KB.pastBar||[]).some(p=>p.subject===s.key);
    const qCount = (KB.pastBar||[]).filter(p=>p.subject===s.key).reduce((a,p)=>a+(p.qCount||0),0);
    // The per-subject "N due" badge lives in the notification panel now, where
    // it comes with a review action instead of just a number.
    return `<button class="sb-subject" id="sb-subj-${s.key}" style="--subject-color:${s.color};" onclick="navToSubject('${s.key}')" title="${h(s.name)}">
      <span class="sb-subj-dot" style="background:${hasMaterials?s.color:'rgba(var(--txt2-rgb),.2)'};"></span>
      <span class="sb-subj-name sb-lbl">${h(s.name)}</span>
      ${qCount>0?`<span class="sb-subj-qcount sb-lbl">${qCount}q</span>`:''}
      <span class="sb-lock-icon sb-lbl" style="display:none;">🔒</span>
    </button>`;
  }).join('');
  list.innerHTML = html;
  sessionStorage.setItem('bb_sidebar_cache', html);
  // The sidebar no longer displays SR counts, but it's still a reliable point
  // to make sure the due data gets fetched — the notification bell reads the
  // same cache. The in-flight-promise guard in checkDueReviews dedupes if
  // another handler (DOMContentLoaded, onAuthSuccess) already fired it.
  //
  // Guarded by sessionToken because renderSidebar can be called before login
  // completes (on initial app boot) and checkDueReviews would return early
  // anyway — but this avoids the no-op call overhead.
  if (sessionToken && !window._srDueItems) {
    checkDueReviews().catch(() => {});
  }
}


function refreshSidebarDots() {
  SUBJS.forEach(s => {
    const el = document.getElementById('sb-subj-' + s.key);
    if (!el) return;
    const hasMaterials = (KB.references||[]).some(r=>r.subject===s.key) || (KB.pastBar||[]).some(p=>p.subject===s.key);
    const dot = el.querySelector('.sb-subj-dot');
    if (dot) dot.style.background = hasMaterials ? s.color : 'rgba(var(--txt2-rgb),.2)';
    const qCount = (KB.pastBar||[]).filter(p=>p.subject===s.key).reduce((a,p)=>a+(p.qCount||0),0);
    let countEl = el.querySelector('.sb-subj-qcount');
    if (qCount > 0) {
      if (!countEl) { countEl = document.createElement('span'); countEl.className='sb-subj-qcount sb-lbl'; el.insertBefore(countEl, el.querySelector('.sb-lock-icon')); }
      countEl.textContent = qCount + 'q';
    } else if (countEl) { countEl.remove(); }
  });
  // Custom subject count badge
  const customQCount = (KB.pastBar||[]).filter(p=>p.subject==='custom').reduce((a,p)=>a+(p.qCount||0),0);
  const customCountEl = document.getElementById('sbCustomCount');
  if (customCountEl) {
    customCountEl.textContent = customQCount > 0 ? customQCount + 'q' : '';
    customCountEl.style.display = customQCount > 0 ? '' : 'none';
  }
}

// ══════════════════════════════════
// OVERVIEW GRID
// ══════════════════════════════════
function renderOverviewGrid() { renderOverview(); } // legacy alias

function renderOverview() {
  const container = document.getElementById('overviewContainer');
  if (!container) return;

  const pbCount = subj => (KB.pastBar||[]).filter(p=>p.subject===subj).reduce((a,p)=>a+(p.qCount||0),0);
  const userName = currentUser?.name?.split(' ')[0] || 'Counselor';
  const quote    = getMotivationalQuote();

  const _cdDiff = _getBarExamDate().getTime() - Date.now();
  const _cdDays  = _cdDiff > 0 ? Math.floor(_cdDiff / 86400000) : -1;

  // Time-of-day greeting in Manila local time (UTC+8 per CLAUDE.md).
  const manilaHour = parseInt(new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', hour12: false }));
  const timeWord = manilaHour < 12 ? 'Good morning' : manilaHour < 18 ? 'Good afternoon' : 'Good evening';
  const timeIcon = manilaHour < 12 ? '☀️' : manilaHour < 18 ? '🌤' : '🌙';

  // Pick a focus line that points at what the student can actually do today.
  // Tier order: due flashcards > active mocks > generic start prompt. Counts
  // come from the same bundle that powers the Flashcards Progress widget.
  let focusLine = 'Pick a subject below to start drilling flashcards or take a Mock Bar.';
  if (_fcBundleCache) {
    let totalRemaining = 0;
    for (const subj of Object.keys(_fcBundleCache.totalBySubject || {})) {
      const t = _fcBundleCache.totalBySubject[subj] || 0;
      const d = _fcBundleCache.doneCountBySubject[subj] || 0;
      totalRemaining += Math.max(0, t - d);
    }
    if (totalRemaining > 0) {
      // toLocaleString to match the grouped figures in the progress bar below —
      // "1207 left" beside "of 1,920" read as two different number systems.
      focusLine = `You have <strong style="color:var(--gold-l)">${totalRemaining.toLocaleString()}</strong> flashcard${totalRemaining!==1?'s':''} left to drill. Keep the streak going.`;
    } else if (totalRemaining === 0 && Object.keys(_fcBundleCache.totalBySubject||{}).length > 0) {
      focusLine = `You've cleared every flashcard 🎉 — jump into a Mock Bar to test your recall under timed conditions.`;
    }
  }

  // Subjects actually shown, computed before render so the section header can
  // report a count that matches what's on screen.
  const visibleSubjs = SUBJS.filter(s => s.key !== 'custom').filter(s => {
    const ts = window.TAB_SETTINGS?.subjects?.[s.key] || {};
    const allOff = ['learn','quiz','mockbar','flashcards','speeddrill'].every(m => ts[m] === false);
    return !(allOff && !adminKey);
  });

  container.innerHTML = `
    <div class="overview-inner">
      <!-- Hero: greeting, today's focus, aggregate progress and the countdown
           in one card. These were four separate stacked bands (countdown
           banner, welcome card, "Flashcards Progress" card, quote bar) that
           between them said "Bar Exam 2026" twice and the flashcard count
           three times before any actionable content appeared. -->
      <section class="ov-hero">
        <div class="ov-hero-main">
          <h2 class="ov-greeting">${timeIcon} ${timeWord}, ${h(userName)}.</h2>
          <p class="ov-focus-line">${focusLine}</p>
          <div class="ov-prog" id="fc-overview-widget"></div>
        </div>
        ${_cdDays >= 0
          ? `<button class="ov-countdown" onclick="navToProgress()" title="View my progress">
              <span class="ov-cd-num">${_cdDays}</span>
              <span class="ov-cd-lbl">day${_cdDays!==1?'s':''} to the Bar</span>
              <span class="ov-cd-link">My Progress →</span>
            </button>`
          : ''}
      </section>

      <p class="ov-quote"><span class="ov-quote-star">✦</span> ${h(quote)}</p>

      <div class="ov-subjects-head">
        <span class="ov-subjects-title">Subjects</span>
        <span class="ov-subjects-count">${visibleSubjs.length}</span>
      </div>
      <div class="ov-subjects-grid">
        ${visibleSubjs.map(s => {
          // Progress = flashcards marked done / total cards for the subject.
          const prog = getSubjectFlashcardProgress(s.key);
          const pct  = prog.pct;
          const pb   = pbCount(s.key);
          const ts = window.TAB_SETTINGS?.subjects?.[s.key] || {};
          const flashcardsOk = ts.flashcards !== false;
          const mockOk       = ts.mockbar    !== false;
          // `empty` mutes the track instead of rendering a full-width trough
          // next to the words "No cards yet", which said the same thing twice.
          const empty = prog.total === 0;
          return `
            <div class="ov-subj-card${empty ? ' is-empty' : ''}" data-subj="${s.key}" style="--subj-color:${s.color}">
              <div class="ov-subj-top">
                <div class="ov-subj-dot" style="background:${s.color}"></div>
                <div class="ov-subj-name">${h(s.name)}</div>
                <div class="ov-subj-pct">${empty ? '' : pct + '%'}</div>
              </div>
              <div class="ov-subj-prog-track" title="${prog.total > 0 ? `${prog.done} of ${prog.total} flashcards marked done` : 'No flashcards imported yet'}">
                <div class="ov-subj-prog-fill" style="width:${pct}%;background:${s.color}"></div>
              </div>
              <div class="ov-subj-stats">
                <span>${prog.total > 0 ? `${prog.done}/${prog.total} cards` : 'No cards yet'}</span>
                ${pb > 0 ? `<span>${pb} past Qs</span>` : ''}
              </div>
              <div class="ov-subj-actions">
                ${flashcardsOk ? `<button class="ov-btn-learn" onclick="navToSubject('${s.key}','flashcards')">🎴 Flashcards</button>` : ''}
                ${pb > 0 && mockOk ? `<button class="ov-btn-mock" onclick="navToSubject('${s.key}','mockbar')">⏱ Mock</button>` : ''}
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>`;
  renderDashboardFlashcardWidget();
  refreshSidebarFlashcardBadge();
}
const openModal  = id => document.getElementById(id).classList.add('on');
const closeModal = id => document.getElementById(id).classList.remove('on');
document.querySelectorAll('.overlay').forEach(o=>o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('on');}));

// ══════════════════════════════════
// SYLLABUS TREE
// ══════════════════════════════════

// Recursively extract all testable (non-group) topics from hierarchical structure
// Flatten all learnable (clickable) topics — handles both new type:'topic' and legacy !isGroup formats
function flattenLeafTopics(topics) {
  const result = [];
  function walk(items) {
    (items || []).forEach(t => {
      if (t.type === 'topic' || (!t.type && !t.isGroup)) result.push(t);
      walk(t.children || []);
      if (!t.type) walk(t.subtopics || []); // legacy format compat
    });
  }
  walk(topics);
  return result;
}

function isTopicCached(subj, topicName) { return !!getCached(subj, topicName); }
function loadTopicContent(subj, topicName) { clickTopic(subj, topicName); }
function countLearnableTopics(nodes) {
  let n = 0;
  function walk(items) { (items||[]).forEach(t => { if (t.type==='topic') n++; walk(t.children||[]); }); }
  walk(nodes);
  return n;
}

// Toggle expand/collapse on a tree group or parent node
function toggleTopicGroup(el) {
  el.classList.toggle('open');
  const next = el.nextElementSibling;
  if (next) next.classList.toggle('open');
}

// Toggle just the children container via expand icon click (without triggering parent onclick)
function toggleTopicChildren(iconEl) {
  const row = iconEl.closest('.topic-parent-row');
  const childDiv = row && row.nextElementSibling;
  if (!childDiv) return;
  iconEl.classList.toggle('open');
  childDiv.classList.toggle('open');
}

// DOM-based topic tree renderer — builds elements directly into container
// Handles both new format (node.title, node.id, node.pdfId) and legacy (node.name)
function renderTopicTree(nodes, container, subj, depth) {
  depth = depth || 0;
  if (!nodes || !nodes.length) return;
  nodes.forEach(node => {
    const children = node.children || [];
    const displayName = node.title || node.name || '';
    const isGroup = children.length > 0;

    if (node.type === 'section') {
      // Roman numeral section header — expand/collapse, non-clickable
      const headerEl = document.createElement('div');
      headerEl.className = 'tl-section-header';
      const arrowEl = document.createElement('span');
      arrowEl.className = 'tl-expand-arrow';
      arrowEl.textContent = '▶';
      const nameEl = document.createElement('span');
      nameEl.className = 'tl-section-name';
      nameEl.textContent = (node.label ? node.label + '. ' : '') + displayName;
      headerEl.appendChild(arrowEl);
      headerEl.appendChild(nameEl);
      const bodyEl = document.createElement('div');
      bodyEl.className = 'tl-group-body';
      headerEl.addEventListener('click', () => {
        arrowEl.classList.toggle('open');
        bodyEl.classList.toggle('open');
      });
      container.appendChild(headerEl);
      container.appendChild(bodyEl);
      if (children.length) renderTopicTree(children, bodyEl, subj, depth + 1);

    } else if (node.type === 'group' || node.isGroup || isGroup) {
      // Topic group — expand/collapse, non-clickable
      const groupEl = document.createElement('div');
      groupEl.className = 'tl-group';
      const headerEl = document.createElement('div');
      headerEl.className = 'tl-group-header';
      const arrowEl = document.createElement('span');
      arrowEl.className = 'tl-expand-arrow';
      arrowEl.textContent = '▶';
      const nameEl = document.createElement('span');
      nameEl.className = 'tl-group-name';
      nameEl.textContent = (node.label ? node.label + '. ' : '') + displayName;
      headerEl.appendChild(arrowEl);
      headerEl.appendChild(nameEl);
      if (node.pdfId) {
        const pdfBadge = document.createElement('span');
        pdfBadge.style.cssText = 'font-size:10px;color:var(--teal);margin-left:5px;';
        pdfBadge.textContent = '📄';
        headerEl.appendChild(pdfBadge);
      }
      const bodyEl = document.createElement('div');
      bodyEl.className = 'tl-group-body';
      headerEl.addEventListener('click', () => {
        arrowEl.classList.toggle('open');
        bodyEl.classList.toggle('open');
      });
      groupEl.appendChild(headerEl);
      groupEl.appendChild(bodyEl);
      container.appendChild(groupEl);
      if (children.length) renderTopicTree(children, bodyEl, subj, depth + 1);

    } else {
      // Learnable topic — clickable leaf
      const cached     = !node.pdfId && isTopicCached(subj, displayName);
      const done       = node.id ? isTopicDone(subj, node.id) : false;
      const bookmarked = node.id ? isTopicBookmarked(subj, node.id) : false;
      const genNow  = !node.pdfId && KB.genState?.running && KB.genState?.current?.includes(displayName);
      const topicEl = document.createElement('div');
      topicEl.className = 'tl-topic' + ((done || cached) ? ' tl-done' : '') + (node.pdfId ? ' tl-has-pdf' : '');
      topicEl.setAttribute('data-node-id', node.id || '');
      topicEl.setAttribute('data-subj-key', subj);
      topicEl.setAttribute('data-topic-name', displayName);
      const checkEl = document.createElement('span');
      checkEl.className = 'tl-topic-check';
      checkEl.textContent = node.pdfId ? '📄' : (done || cached) ? '✓' : '○';
      const nameEl = document.createElement('span');
      nameEl.className = 'tl-topic-name';
      nameEl.textContent = (node.label ? node.label + '. ' : '') + displayName;
      topicEl.appendChild(checkEl);
      topicEl.appendChild(nameEl);
      if (bookmarked) {
        const bmBadge = document.createElement('span');
        bmBadge.className = 'tl-bm-badge';
        bmBadge.setAttribute('data-bm-badge', node.id);
        bmBadge.textContent = '🔖';
        topicEl.appendChild(bmBadge);
      }
      if (node.pdfId) {
        const b = document.createElement('span');
        b.className = 'tl-cached-badge';
        b.style.cssText = 'background:rgba(20,180,160,.1);border-color:rgba(20,180,160,.2);color:var(--teal);';
        b.textContent = 'PDF';
        topicEl.appendChild(b);
      } else if (genNow) {
        const b = document.createElement('span');
        b.className = 'ready-badge rb-gen'; b.textContent = 'gen…';
        topicEl.appendChild(b);
      } else if (cached) {
        const b = document.createElement('span');
        b.className = 'tl-cached-badge'; b.textContent = 'cached';
        topicEl.appendChild(b);
      }
      topicEl.addEventListener('click', () => {
        if (node.id) { clickSyllabusNode(subj, node); }
        else { loadTopicContent(subj, displayName); } // legacy fallback
      });
      container.appendChild(topicEl);
    }
  });
}

function renderSyllabusTree(filter, subjFilter) {
  filter = filter || '';
  const subj = subjFilter || currentSubject;
  const tree = document.getElementById('syllabusTree');
  if (!tree) return;
  const subjData = syllabusCache[subj];
  const sections = subjData?.sections || [];
  if (!sections.length) {
    tree.innerHTML = `<div style="padding:20px 12px;text-align:center;color:var(--muted);font-size:12px;line-height:1.6;"><div style="font-size:28px;margin-bottom:8px;opacity:.4;">📋</div>No topics yet. Admin can add them in the Syllabus Builder.</div>`;
    return;
  }
  const fl = filter.toLowerCase();
  tree.innerHTML = '';
  // Collect all leaf topics for flat search
  const allLeaves = [];
  function collectLeaves(nodes) {
    (nodes || []).forEach(n => {
      if (!(n.children?.length)) allLeaves.push({ id: n.id, title: n.title, pdfId: n.pdfId, node: n });
      collectLeaves(n.children || []);
    });
  }
  sections.forEach(sec => collectLeaves(sec.children || []));
  if (fl) {
    const matches = allLeaves.filter(t => t.title.toLowerCase().includes(fl));
    if (!matches.length) { tree.innerHTML = `<div style="padding:18px;text-align:center;color:var(--muted);font-size:12px;">No topics match.</div>`; return; }
    matches.forEach(t => {
      const cached = isTopicCached(subj, t.title);
      const el = document.createElement('div');
      el.className = 'tl-topic' + (cached ? ' tl-done' : '') + (t.pdfId ? ' tl-has-pdf' : '');
      el.setAttribute('data-node-id', t.id);
      el.innerHTML = `<span class="tl-topic-check">${t.pdfId ? '📄' : cached ? '✓' : '○'}</span><span class="tl-topic-name">${h(t.title)}</span>${cached && !t.pdfId ? '<span class="tl-cached-badge">cached</span>' : ''}`;
      el.addEventListener('click', () => clickSyllabusNode(subj, t.node));
      tree.appendChild(el);
    });
  } else {
    renderTopicTree(sections, tree, subj, 0);
  }
}
function filterTopics(v){renderSyllabusTree(v, currentSubject);}

// ══════════════════════════════════
// LESSON VIEWER
// ══════════════════════════════════
async function clickTopic(subjKey, topicName) {
  // Clear all active/selected states
  document.querySelectorAll('.topic-item,.topic-leaf-item,.topic-parent-row').forEach(t => {
    t.classList.remove('active');
    const oc = t.getAttribute('onclick') || '';
    if (oc.includes(topicName) && oc.includes(subjKey)) t.classList.add('active');
  });
  document.querySelectorAll('.tl-topic').forEach(t => {
    t.classList.remove('tl-selected');
    if (t.getAttribute('data-subj-key') === subjKey && t.getAttribute('data-topic-name') === topicName)
      t.classList.add('tl-selected');
  });
  curSubj=subjKey; curTopic=topicName; curPage=0;
  const sub=SUBJS.find(s=>s.key===subjKey)||{name:subjKey,cls:'sg-gen'};
  const lpBC=document.getElementById('lpBC');if(lpBC)lpBC.innerHTML=`<span class="sbg ${sub.cls}">${h(sub.name)}</span> &nbsp;›&nbsp; <strong>${h(topicName)}</strong>`;
  const lpTB=document.getElementById('lpTopbar');if(lpTB)lpTB.style.display='flex';

  // 1) Check browser cache first
  let data = getCached(subjKey, topicName);
  if (data) { renderLesson(data, topicName, subjKey, 'cache'); return; }

  // 2) Try server
  const _lpc=document.getElementById('lpContent'),_lpf=document.getElementById('lpFooter');
  if(_lpc)_lpc.innerHTML=`<div class="gen-state"><div class="spin"></div><div style="font-size:14px;color:var(--gold-l);">Loading from server…</div></div>`;
  if(_lpf)_lpf.style.display='none';
  try {
    const r = await fetch(`/api/content/${subjKey}/${encodeURIComponent(topicName)}`);
    const d = await r.json();
    if (d.found) {
      if (d.status === 'no_materials') { renderNoMaterials(subjKey, topicName); return; }
      saveCacheItem(subjKey, topicName, d); renderLesson(d, topicName, subjKey, 'server'); return;
    }
  } catch(e){}

  // 3) Check if subject has no references at all — skip AI gen, show no_materials
  const hasRefs = (KB.references||[]).some(r => r.subject === subjKey);
  if (!hasRefs) { renderNoMaterials(subjKey, topicName); return; }

  // 4) On-demand generation (fallback if pre-gen hasn't reached this yet)
  await genOnDemand(subjKey, topicName);
}

// PDF-aware topic click for new manual syllabus nodes
async function clickSyllabusNode(subjKey, node) {
  if (!node) return;
  const displayName = node.title || node.name || '';
  // Update active state in tree
  document.querySelectorAll('.tl-topic').forEach(t => {
    t.classList.remove('tl-selected');
    if (t.getAttribute('data-node-id') === node.id) t.classList.add('tl-selected');
  });
  curSubj = subjKey; curTopic = displayName; curPage = 0;
  const sub = SUBJS.find(s => s.key === subjKey) || { name: subjKey, cls: 'sg-gen' };
  const lpBC = document.getElementById('lpBC');
  if (lpBC) lpBC.innerHTML = `<span class="sbg ${sub.cls}">${h(sub.name)}</span> &nbsp;›&nbsp; <strong>${h((node.label ? node.label + '. ' : '') + displayName)}</strong>`;
  const lpTB = document.getElementById('lpTopbar');
  if (lpTB) lpTB.style.display = 'flex';
  // Sync Mark Done button state
  if (node.id) {
    const btn = document.getElementById('mark-done-btn');
    if (btn) {
      const done = isTopicDone(subjKey, node.id);
      btn.textContent = done ? '✓ Completed' : '○ Mark as Done';
      btn.classList.toggle('is-done', done);
      btn.onclick = () => handleMarkDone(subjKey, node.id);
    }
    // Sync Bookmark button state
    const bmBtn = document.getElementById('bookmark-btn');
    if (bmBtn) {
      const bookmarked = isTopicBookmarked(subjKey, node.id);
      bmBtn.textContent = bookmarked ? '🔖 Bookmarked' : '🔖 Bookmark';
      bmBtn.classList.toggle('is-bookmarked', bookmarked);
      bmBtn.onclick = () => toggleBookmark(subjKey, node);
    }
  }
  // If node has a PDF — show PDF viewer (token-authenticated, no download)
  if (node.pdfId) {
    currentTopic = node;
    const lpContent = document.getElementById('lpContent');
    const lpFooter  = document.getElementById('lpFooter');
    if (lpFooter) lpFooter.style.display = 'none';
    if (lpContent) renderTopicPDFViewer(node, lpContent);
    return;
  }
  // No PDF — fall back to AI-generated / cached lesson content
  await clickTopic(subjKey, displayName);
}

async function renderTopicPDFViewer(node, container) {
  const displayName = h(node.title || node.name || '');
  // STEP 1: Show skeleton with spinner immediately — no waiting
  container.innerHTML = `
    <div class="pdf-viewer-shell" id="pdf-viewer-shell-${h(node.id)}">
      <div class="pdf-viewer-header">
        <div class="pdf-header-info">
          <span style="font-size:16px;">📄</span>
          <div>
            <div class="pdf-topic-title">${displayName}</div>
            <div class="pdf-topic-sub">Review Material · ${h(node.pdfName || 'Document')}</div>
          </div>
        </div>
        <button class="pdf-maximize-btn" id="pdf-max-btn-${h(node.id)}" title="Maximize (or press F)" onclick="toggleMaximizePdf('${h(node.id)}')">
          <span class="pdf-max-icon">⛶</span>
          <span class="pdf-max-label">Maximize</span>
        </button>
      </div>
      <div class="pdf-frame-wrap" id="pdf-frame-wrap-${h(node.id)}" oncontextmenu="return false">
        <div class="pdf-loading-state" id="pdf-loading-${h(node.id)}">
          <div class="pdf-spinner"></div>
          <div style="font-size:13px;color:var(--muted);margin-top:12px;">Loading PDF…</div>
        </div>
      </div>
    </div>`;

  // Attach the Ctrl/Cmd-S keyboard guard ONCE this viewer is in the DOM
  attachPdfKeyboardGuard();

  try {
    // STEP 2: Fetch auth token
    const headers = sessionToken ? { 'x-session-token': sessionToken } : {};
    const r = await fetch(`/api/syllabus/pdf-token/${node.id}`, { headers });
    if (!r.ok) throw new Error('Authentication failed (' + r.status + ')');
    const { token } = await r.json();
    // #toolbar=0&navpanes=0&scrollbar=0 is honored by Chrome/Edge/Firefox
    // built-in PDF viewers — hides the toolbar that includes the Download button.
    // Safari ignores it (still allows download); we accept that as an acknowledged
    // gap per "casual deterrence only" scope.
    const pdfUrl = `/api/syllabus/pdf/${node.id}?token=${encodeURIComponent(token)}#toolbar=0&navpanes=0&scrollbar=0`;

    // Guard: user navigated away while token was being fetched
    if (currentTopic?.id !== node.id) return;

    // STEP 3: Inject iframe — browser starts streaming PDF immediately
    const wrap = document.getElementById('pdf-frame-wrap-' + node.id);
    if (!wrap) return;
    wrap.innerHTML = `<iframe src="${pdfUrl}" class="lesson-pdf-iframe" title="${displayName}" type="application/pdf"></iframe>`;

  } catch(e) {
    if (currentTopic?.id !== node.id) return;
    const wrap = document.getElementById('pdf-frame-wrap-' + node.id);
    if (wrap) wrap.innerHTML = `
      <div style="text-align:center;padding:48px 24px;">
        <div style="font-size:40px;margin-bottom:14px;">⚠️</div>
        <div style="font-family:var(--fd);font-size:16px;font-weight:700;color:var(--text,var(--white));margin-bottom:8px;">Could Not Load PDF</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:16px;">${h(e.message || 'Please try again.')}</div>
        <button onclick="renderTopicPDFViewer(currentTopic, document.getElementById('lpContent'))"
          style="padding:8px 18px;border-radius:10px;background:rgba(201,168,76,.1);border:1px solid rgba(201,168,76,.25);color:var(--gold);font-weight:700;font-size:13px;cursor:pointer;">
          ↺ Retry
        </button>
      </div>`;
  }
}

// ── PDF Maximize: Fullscreen API with CSS modal fallback ─────────
function toggleMaximizePdf(nodeId) {
  const shell = document.getElementById('pdf-viewer-shell-' + nodeId);
  if (!shell) return;

  // If currently in CSS modal mode, exit
  if (shell.classList.contains('pdf-fullscreen-modal')) {
    shell.classList.remove('pdf-fullscreen-modal');
    document.body.classList.remove('pdf-fullscreen-modal-open');
    updateMaximizeBtn(nodeId, false);
    return;
  }

  // If currently in real fullscreen, exit
  if (document.fullscreenElement === shell) {
    document.exitFullscreen?.();
    return; // fullscreenchange listener will update the button
  }

  // Try real fullscreen first
  const reqFs = shell.requestFullscreen || shell.webkitRequestFullscreen || shell.msRequestFullscreen;
  if (reqFs) {
    try {
      const result = reqFs.call(shell);
      if (result && typeof result.then === 'function') {
        result.then(() => updateMaximizeBtn(nodeId, true)).catch(() => activateModalFallback(shell, nodeId));
      } else {
        updateMaximizeBtn(nodeId, true);
      }
      return;
    } catch (_) { /* fall through to CSS modal */ }
  }

  // Fallback: CSS modal (covers the page, browser chrome stays visible)
  activateModalFallback(shell, nodeId);
}

function activateModalFallback(shell, nodeId) {
  shell.classList.add('pdf-fullscreen-modal');
  document.body.classList.add('pdf-fullscreen-modal-open');
  updateMaximizeBtn(nodeId, true);
}

function updateMaximizeBtn(nodeId, isMaximized) {
  const btn = document.getElementById('pdf-max-btn-' + nodeId);
  if (!btn) return;
  const icon = btn.querySelector('.pdf-max-icon');
  const label = btn.querySelector('.pdf-max-label');
  if (isMaximized) {
    if (icon) icon.textContent = '⛶';
    if (label) label.textContent = 'Exit';
    btn.classList.add('is-maximized');
  } else {
    if (icon) icon.textContent = '⛶';
    if (label) label.textContent = 'Maximize';
    btn.classList.remove('is-maximized');
  }
}

// Listen for fullscreen state changes from outside our toggle (e.g. Esc key)
if (!window._pdfFsListenerAttached) {
  document.addEventListener('fullscreenchange', () => {
    // Find any pdf-viewer-shell that should reflect the new state
    document.querySelectorAll('.pdf-viewer-shell').forEach(shell => {
      const idMatch = shell.id.match(/^pdf-viewer-shell-(.+)$/);
      if (!idMatch) return;
      const nodeId = idMatch[1];
      const isFs = (document.fullscreenElement === shell);
      updateMaximizeBtn(nodeId, isFs);
    });
  });
  // Also listen for Esc to exit modal fallback
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const openShell = document.querySelector('.pdf-viewer-shell.pdf-fullscreen-modal');
    if (openShell) {
      const idMatch = openShell.id.match(/^pdf-viewer-shell-(.+)$/);
      if (idMatch) toggleMaximizePdf(idMatch[1]);
    }
  });
  window._pdfFsListenerAttached = true;
}

// ── PDF Keyboard Guard: block Ctrl/Cmd-S while a viewer is mounted ──
let _pdfKeyboardGuardAttached = false;
function attachPdfKeyboardGuard() {
  if (_pdfKeyboardGuardAttached) return;
  _pdfKeyboardGuardAttached = true;
  document.addEventListener('keydown', (ev) => {
    // Only act if a PDF viewer is currently in the DOM
    if (!document.querySelector('.pdf-viewer-shell')) return;
    // Block Ctrl/Cmd-S (Save), Ctrl/Cmd-P (Print), Ctrl/Cmd-Shift-S (Save As variant)
    const isSaveCombo =
      (ev.ctrlKey || ev.metaKey) &&
      (ev.key === 's' || ev.key === 'S' || ev.key === 'p' || ev.key === 'P');
    if (isSaveCombo) {
      ev.preventDefault();
      // Optional: brief toast
      if (typeof showToast === 'function') {
        showToast('Saving and printing are disabled for this content.', 'info');
      }
      return false;
    }
  }, true); // capture phase so we beat the iframe
}

function renderNoMaterials(subjKey, topicName) {
  const subjInfo = SUBJS.find(s => s.key === subjKey);
  const lpContent = document.getElementById('lpContent');
  if (!lpContent) return;
  lpContent.innerHTML = `
    <div style="text-align:center;padding:40px 20px;">
      <div style="font-size:40px;margin-bottom:12px;">📂</div>
      <div style="font-family:var(--fd);font-size:18px;font-weight:700;color:var(--gold-l);margin-bottom:8px;">No Materials for This Subject</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.7;max-width:300px;margin:0 auto 20px;">
        Upload reference materials tagged to <strong>${h(subjInfo?.name||subjKey)}</strong> in the Admin panel to generate lesson content for "${h(topicName)}".
      </div>
      <button class="btn-gold" onclick="navToAdmin()" style="font-size:12px;">⚙️ Go to Admin</button>
    </div>`;
  const lpFooter=document.getElementById('lpFooter');if(lpFooter)lpFooter.style.display='none';
}

function renderLesson(data, topicName, subjKey, source) {
  if (data?.status === 'no_materials') { renderNoMaterials(subjKey, topicName); return; }
  const lpContent = document.getElementById('lpContent');
  if (!lpContent) return; // tab no longer active (async race)
  const pages = data.lesson?.pages;
  if (!pages?.length) { lpContent.innerHTML=`<div style="padding:30px;text-align:center;color:var(--danger);">⚠️ No lesson content found. Try regenerating.</div>`; return; }
  const page = pages[curPage], total=pages.length;
  const sub=SUBJS.find(s=>s.key===subjKey)||{cls:'sg-gen',name:subjKey};
  const hasRef=KB.references?.some(r=>r.subject===subjKey);
  lpContent.innerHTML=`<div class="lc">
    ${hasRef?`<div class="kb-ref-note">📚 Grounded in uploaded reference materials. ${source==='cache'?'Loaded from browser cache.':'Loaded from server.'}</div>`:''}
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
      <span class="sbg ${sub.cls}">${h(sub.name)}</span><span class="tag tg-l">Lesson</span>
      <span style="font-size:10px;color:var(--muted);margin-left:auto;font-family:var(--fm);">${source==='cache'?'💾 cached':'🖥 server'}</span>
    </div>
    <h2>${h(topicName)}</h2>
    <div class="lc-meta">
      <span style="font-size:12px;color:var(--muted);font-family:var(--fm);">Page ${curPage+1} of ${total}</span>
      <div style="height:4px;width:110px;background:rgba(var(--ovl),.07);border-radius:2px;overflow:hidden;">
        <div style="height:100%;width:${((curPage+1)/total)*100}%;background:linear-gradient(90deg,var(--gold-d),var(--gold));border-radius:2px;"></div>
      </div>
    </div>
    <h3>${h(page.title)}</h3>
    ${page.content}
  </div>`;
  const pgInfo=document.getElementById('lpPgInfo');if(pgInfo)pgInfo.textContent=`Page ${curPage+1} of ${total}`;
  const prev=document.getElementById('lpPrev');if(prev)prev.disabled=curPage===0;
  const footer=document.getElementById('lpFooter');if(footer)footer.style.display='flex';
  const nxt=document.getElementById('lpNext');
  if (nxt){if(curPage<total-1){nxt.textContent='Next →';nxt.onclick=()=>chgPage(1);}
  else{nxt.textContent='Done ✓';nxt.onclick=()=>{markDone();goToPractice();};}}
  // Track visit
  const existing=VISITED.findIndex(v=>v.subjKey===subjKey&&v.topicName===topicName);
  if(existing>=0)VISITED.splice(existing,1);
  VISITED.unshift({subjKey,topicName,title:topicName,type:'lesson'});
  if(VISITED.length>12)VISITED.length=12;
  try{localStorage.setItem(LS_VISITED,JSON.stringify(VISITED));}catch(e){}
  updateDash();
}

async function callAPI({ messages, max_tokens = 4096 }) {
  const r = await fetch('/api/generate-content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.content;
}

async function genOnDemand(subjKey, topicName) {
  const lpContent=()=>document.getElementById('lpContent');
  const lpFooter=()=>document.getElementById('lpFooter');
  if(lpContent())lpContent().innerHTML=`<div class="gen-state"><div class="spin"></div><div style="font-size:14px;color:var(--gold-l);">Generating "${h(topicName)}"…</div><div style="font-size:12px;color:var(--muted);text-align:center;max-width:280px;">Pre-generation hasn't reached this topic yet. Generating now and caching for next time.</div></div>`;
  if(lpFooter())lpFooter().style.display='none';
  const prompt=`Generate a complete Philippine Bar Exam study package for: "${topicName}" (${subjKey} law)

Respond ONLY with valid JSON (no markdown):
{
  "lesson":{"pages":[{"title":"Page 1: Overview","content":"Rich HTML with definition-box, case-box, codal-box, rule-box, tip-box divs"},{"title":"Page 2: Applications","content":"More cases and bar tips"}]},
  "mcq":{"questions":[{"q":"Bar MCQ","options":["A.","B.","C.","D."],"answer":0,"explanation":"Cite Art./G.R."},{"q":"...","options":["A.","B.","C.","D."],"answer":1,"explanation":"..."},{"q":"...","options":["A.","B.","C.","D."],"answer":2,"explanation":"..."},{"q":"...","options":["A.","B.","C.","D."],"answer":0,"explanation":"..."},{"q":"...","options":["A.","B.","C.","D."],"answer":3,"explanation":"..."}]},
  "essay":{"questions":[{"prompt":"Full bar essay question","context":"","modelAnswer":"Answer with citations","keyPoints":["Point 1","Point 2"]},{"prompt":"...","context":"","modelAnswer":"...","keyPoints":["..."]},{"prompt":"...","context":"","modelAnswer":"...","keyPoints":["..."]}]}
}`;
  try{
    const raw=await callAPI({messages:[{role:'user',content:prompt}],max_tokens:4096,subject:subjKey,topicName,mode:'lesson'});
    const data=JSON.parse(raw.replace(/^```json\s*/i,'').replace(/```$/,'').trim());
    saveCacheItem(subjKey,topicName,data);
    buildQuizPool();
    renderSyllabusTree(document.getElementById('topicSearch')?.value||'');
    renderLesson(data,topicName,subjKey,'generated');
  }catch(err){
    if(lpContent())lpContent().innerHTML=`<div style="padding:36px;text-align:center;color:var(--danger);"><div style="font-size:36px;margin-bottom:10px;">⚠️</div><p style="margin-bottom:14px;">${h(err.message)}</p><button class="btn-gold" onclick="genOnDemand('${subjKey}','${h(topicName)}')">Retry</button></div>`;
  }
}

function chgPage(d){
  const data=getCached(curSubj,curTopic);if(!data)return;
  curPage+=d;renderLesson(data,curTopic,curSubj,'cache');
}
// ══════════════════════════════════
// PROGRESS TRACKING
// ══════════════════════════════════

function getUserProgress() {
  const userId = currentUser?.id || 'guest';
  try { return JSON.parse(localStorage.getItem('bb_progress_' + userId) || '{}'); } catch { return {}; }
}

function setTopicDone(subject, topicId, done) {
  const userId = currentUser?.id || 'guest';
  const key = 'bb_progress_' + userId;
  const progress = getUserProgress();
  if (!progress[subject]) progress[subject] = {};
  if (done) progress[subject][topicId] = true;
  else delete progress[subject][topicId];
  localStorage.setItem(key, JSON.stringify(progress));
  // Persist to server (fire-and-forget)
  if (sessionToken) {
    fetch('/api/user/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify({ subject, topicId, done })
    }).catch(() => {});
  }
  // Progress bars track flashcards now, not lesson topics — but repaint the
  // subject's bars anyway so nothing is left stale after a Learn-tab action.
  // (Called directly rather than through the old updateProgressUI wrapper,
  // whose name collided with the pregeneration SSE handler above.)
  refreshFlashcardProgressUI(subject);
}

function isTopicDone(subject, topicId) {
  return !!getUserProgress()[subject]?.[topicId];
}

function getSubjectProgress(subject) {
  // syllabusData is populated by admin load; syllabusCache by per-subject lazy loads
  const subjectSyllabus = syllabusData[subject] || syllabusCache[subject];
  const sections = subjectSyllabus?.sections || [];
  if (!sections.length) return { done: 0, total: 0 };
  const subjectProgress = getUserProgress()[subject] || {};
  let total = 0, done = 0;
  function countNodes(arr) {
    for (const node of (arr || [])) {
      if (!node.children?.length) { total++; if (subjectProgress[node.id]) done++; }
      else countNodes(node.children);
    }
  }
  for (const sec of sections) countNodes(sec.children || []);
  return { done, total };
}

// ══════════════════════════════════
// BOOKMARKS
// ══════════════════════════════════

function getBookmarks() {
  const userId = currentUser?.id || 'guest';
  try { return JSON.parse(localStorage.getItem('bb_bookmarks_' + userId) || '{}'); } catch { return {}; }
}

function isTopicBookmarked(subject, topicId) {
  return !!getBookmarks()[subject]?.[topicId];
}

function setBookmarkLocal(subject, topicId, topicTitle, bookmarked) {
  const userId = currentUser?.id || 'guest';
  const bms = getBookmarks();
  if (!bms[subject]) bms[subject] = {};
  if (bookmarked) {
    bms[subject][topicId] = { topic_title: topicTitle, created_at: new Date().toISOString() };
  } else {
    delete bms[subject][topicId];
    if (!Object.keys(bms[subject]).length) delete bms[subject];
  }
  localStorage.setItem('bb_bookmarks_' + userId, JSON.stringify(bms));
}

async function toggleBookmark(subjKey, node) {
  subjKey = subjKey || curSubj;
  node = node || { id: null, title: curTopic, name: curTopic };
  const topicId = node.id;
  const topicTitle = node.title || node.name || curTopic;
  if (!topicId || !subjKey) return;

  const wasBookmarked = isTopicBookmarked(subjKey, topicId);
  const nowBookmarked = !wasBookmarked;

  // Optimistic update
  setBookmarkLocal(subjKey, topicId, topicTitle, nowBookmarked);
  const bmBtn = document.getElementById('bookmark-btn');
  if (bmBtn) {
    bmBtn.textContent = nowBookmarked ? '🔖 Bookmarked' : '🔖 Bookmark';
    bmBtn.classList.toggle('is-bookmarked', nowBookmarked);
  }
  updateBookmarkBadgeInTree(topicId, nowBookmarked);
  showToast(nowBookmarked ? '🔖 Topic bookmarked' : 'Bookmark removed', nowBookmarked ? 'success' : 'info');

  // Persist to server
  if (sessionToken) {
    try {
      if (nowBookmarked) {
        await fetch('/api/bookmarks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken },
          body: JSON.stringify({ topicId, topicTitle, subject: subjKey })
        });
      } else {
        await fetch('/api/bookmarks/' + encodeURIComponent(topicId), {
          method: 'DELETE',
          headers: { 'x-session-token': sessionToken }
        });
      }
    } catch(e) {
      // Rollback on network error
      setBookmarkLocal(subjKey, topicId, topicTitle, wasBookmarked);
      if (bmBtn) {
        bmBtn.textContent = wasBookmarked ? '🔖 Bookmarked' : '🔖 Bookmark';
        bmBtn.classList.toggle('is-bookmarked', wasBookmarked);
      }
      updateBookmarkBadgeInTree(topicId, wasBookmarked);
      showToast('Failed to save bookmark', 'error');
    }
  }
}

function updateBookmarkBadgeInTree(topicId, bookmarked) {
  const topicEl = document.querySelector(`.tl-topic[data-node-id="${topicId}"]`);
  if (!topicEl) return;
  const existing = topicEl.querySelector('.tl-bm-badge');
  if (bookmarked && !existing) {
    const bmBadge = document.createElement('span');
    bmBadge.className = 'tl-bm-badge';
    bmBadge.setAttribute('data-bm-badge', topicId);
    bmBadge.textContent = '🔖';
    const nameEl = topicEl.querySelector('.tl-topic-name');
    if (nameEl) nameEl.after(bmBadge);
    else topicEl.appendChild(bmBadge);
  } else if (!bookmarked && existing) {
    existing.remove();
  }
}

async function syncBookmarksFromServer() {
  if (!sessionToken) return;
  try {
    const r = await fetch('/api/bookmarks', { headers: { 'x-session-token': sessionToken } });
    if (!r.ok) return;
    const items = await r.json();
    const bms = {};
    for (const bm of items) {
      if (!bms[bm.subject]) bms[bm.subject] = {};
      bms[bm.subject][bm.topic_id] = { topic_title: bm.topic_title, created_at: bm.created_at };
    }
    if (currentUser?.id) {
      localStorage.setItem('bb_bookmarks_' + currentUser.id, JSON.stringify(bms));
    }
  } catch(e) {}
}

function openBookmarksPanel() {
  renderBookmarksPanelBody();
  document.getElementById('bm-panel')?.classList.add('open');
  document.getElementById('bm-overlay')?.classList.add('open');
}

function closeBookmarksPanel() {
  document.getElementById('bm-panel')?.classList.remove('open');
  document.getElementById('bm-overlay')?.classList.remove('open');
}

function renderBookmarksPanelBody() {
  const body = document.getElementById('bm-panel-body');
  if (!body) return;
  const bms = getBookmarks();
  const subjects = Object.keys(bms).filter(s => Object.keys(bms[s]).length > 0);
  if (!subjects.length) {
    body.innerHTML = `<div class="bm-empty"><span class="bm-empty-icon">🔖</span>No bookmarks yet.<br>Bookmark topics to find them quickly later.</div>`;
    return;
  }
  let html = '';
  for (const subj of subjects) {
    const subjInfo = SUBJS.find(s => s.key === subj);
    const subjName = subjInfo?.name || subj;
    const topics = Object.entries(bms[subj]).sort((a, b) => new Date(b[1].created_at) - new Date(a[1].created_at));
    html += `<div class="bm-subject-group"><span class="bm-subject-label">${h(subjName)}</span>`;
    for (const [topicId, info] of topics) {
      const safeSubj = h(subj);
      const safeId = h(topicId);
      html += `<div class="bm-item">
        <button class="bm-item-title" onclick="navToBookmark('${safeSubj}','${safeId}')">${h(info.topic_title || topicId)}</button>
        <button class="bm-item-nav" onclick="navToBookmark('${safeSubj}','${safeId}')" title="Go to topic">→</button>
        <button class="bm-item-rm" onclick="removeBookmarkFromPanel('${safeSubj}','${safeId}')" title="Remove bookmark">×</button>
      </div>`;
    }
    html += `</div>`;
  }
  body.innerHTML = html;
}

async function navToBookmark(subject, topicId) {
  closeBookmarksPanel();
  await navToSubject(subject, 'learn');
  await loadSubjectSyllabus(subject);
  renderSyllabusTree('', subject);
  setTimeout(() => {
    const topicEl = document.querySelector(`.tl-topic[data-node-id="${topicId}"]`);
    if (topicEl) topicEl.click();
  }, 250);
}

function removeBookmarkFromPanel(subject, topicId) {
  const bms = getBookmarks();
  const topicTitle = bms[subject]?.[topicId]?.topic_title || topicId;
  setBookmarkLocal(subject, topicId, topicTitle, false);
  updateBookmarkBadgeInTree(topicId, false);
  // If currently viewing this topic, reset its bookmark button
  const selected = document.querySelector(`.tl-topic.tl-selected[data-node-id="${topicId}"]`);
  if (selected) {
    const bmBtn = document.getElementById('bookmark-btn');
    if (bmBtn) { bmBtn.textContent = '🔖 Bookmark'; bmBtn.classList.remove('is-bookmarked'); }
  }
  renderBookmarksPanelBody();
  if (sessionToken) {
    fetch('/api/bookmarks/' + encodeURIComponent(topicId), {
      method: 'DELETE',
      headers: { 'x-session-token': sessionToken }
    }).catch(() => {});
  }
}

// Load all subject syllabuses in background so overview progress bars are accurate
async function preloadAllSyllabuses() {
  const subjects = ['civil','criminal','political','labor','commercial','taxation','remedial','ethics'];
  await Promise.all(subjects.map(s => loadSubjectSyllabus(s)));
  // If overview is currently visible, re-render with updated data
  if (document.getElementById('page-dashboard')?.classList.contains('on')) renderOverview();
}

async function syncProgressFromServer() {
  if (!sessionToken) return;
  try {
    const r = await fetch('/api/user/progress', { headers: { 'x-session-token': sessionToken } });
    if (!r.ok) return;
    const d = await r.json();
    if (d.progress && currentUser?.id) {
      localStorage.setItem('bb_progress_' + currentUser.id, JSON.stringify(d.progress));
    }
  } catch(e) {}
}

function handleMarkDone(subject, topicId) {
  const newDone = !isTopicDone(subject, topicId);
  setTopicDone(subject, topicId, newDone);
  // Update button state
  const btn = document.getElementById('mark-done-btn');
  if (btn) {
    btn.textContent = newDone ? '✓ Completed' : '○ Mark as Done';
    btn.classList.toggle('is-done', newDone);
    if (newDone) { btn.style.transform = 'scale(1.05)'; setTimeout(() => { btn.style.transform = ''; }, 200); }
  }
  // Update the topic list item check icon
  if (topicId) {
    const topicEl = document.querySelector(`.tl-topic[data-node-id="${topicId}"]`);
    if (topicEl) {
      const icon = topicEl.querySelector('.tl-topic-check');
      if (icon && !topicEl.classList.contains('tl-has-pdf')) icon.textContent = newDone ? '✓' : '○';
      topicEl.classList.toggle('tl-done', newDone);
    }
  }
  // Re-render overview if visible
  if (document.getElementById('page-dashboard')?.classList.contains('on')) renderOverview();
}


// Legacy shim — kept so existing lesson footer "Mark Done" button still works
function markDone(){
  if (currentTopic?.id && currentSubject) {
    handleMarkDone(currentSubject, currentTopic.id);
  } else {
    document.querySelector('.tl-topic.tl-selected')?.classList.add('tl-done');
  }
}
function goToPractice(){
  if (currentSubject) {
    switchSubjectTab(currentSubject, 'quiz');
    // After tab renders, jump to matching quiz item
    setTimeout(() => {
      const qi=quizPool.findIndex(q=>q.type===qMode&&q.subject===curSubj&&q.topic===curTopic);
      if(qi>=0)openQuizItem(qi);else renderQuizList();
    }, 50);
  } else {
    nav('practice', null);
    const qi=quizPool.findIndex(q=>q.type===qMode&&q.subject===curSubj&&q.topic===curTopic);
    if(qi>=0)openQuizItem(qi);else renderQuizList();
  }
}

// ══════════════════════════════════
// QUIZ POOL (from cache)
// ══════════════════════════════════
function buildQuizPool(subjFilter) {
  quizPool=[];
  Object.entries(CACHE).forEach(([subj,topics])=>{
    if (subjFilter && subj !== subjFilter) return;
    Object.entries(topics).forEach(([topic,data])=>{
      if(data.essay?.questions?.length) quizPool.push({type:'essay',subject:subj,topic,data:data.essay});
    });
  });
  renderQuizList();
  updateDash();
}

function setQMode(m){qMode=m;['essay'].forEach(x=>{const el=document.getElementById('qmode-'+x);if(el)el.classList.toggle('on',x===m);});renderQuizList();}
function renderQuizList(){
  const list=document.getElementById('quizList');
  if(!list) return;  // element only exists while Quiz tab is active
  const items=quizPool.filter(q=>q.type===qMode);
  if(!items.length){list.innerHTML=`<div style="padding:16px 12px;text-align:center;color:var(--muted);font-size:12px;line-height:1.6;">No ${qMode} quizzes cached yet.</div>`;return;}
  list.innerHTML=items.map((q,i)=>{const sub=SUBJS.find(s=>s.key===q.subject)||{cls:'sg-gen',name:q.subject};
    return `<div class="qn-item${activeQuiz===i?' active':''}" onclick="openQuizItem(${i})"><div class="qn-icon">✍️</div><div class="qn-info"><div class="qn-title">${h(q.topic)}</div><div class="qn-sub"><span class="sbg ${sub.cls}" style="font-size:9px;">${sub.name}</span> ${q.data.questions?.length||0} Qs</div></div></div>`;
  }).join('');
}
function openQuizItem(i){activeQuiz=i;qIdx=0;qScore=0;renderQuizList();const qh=document.getElementById('qmHead');if(qh)qh.style.display='flex';const qt=document.getElementById('qmTitle');if(qt)qt.textContent=quizPool[i]?.topic||'Quiz';const qm=document.getElementById('qmMeta');if(qm)qm.textContent=`${quizPool[i]?.data?.questions?.length||0} questions`;renderQuizQ();}
function resetQuiz(){if(activeQuiz!==null){qIdx=0;qScore=0;renderQuizQ();}}

function renderQuizQ(){
  const pool=quizPool[activeQuiz];if(!pool)return;
  const qs=pool.data.questions,body=document.getElementById('qmBody');
  if(!body)return;
  if(qIdx>=qs.length){showQuizResults();return;}
  const cur=qs[qIdx],sub=SUBJS.find(s=>s.key===pool.subject)||{cls:'sg-gen',name:pool.subject};
  body.innerHTML=`<div style="display:flex;gap:7px;margin-bottom:14px;flex-wrap:wrap;"><span class="sbg ${sub.cls}">${sub.name}</span><span class="tag tg-e">Essay</span></div>
    <div class="q-prog-track"><div class="q-prog-fill" style="width:${(qIdx/qs.length)*100}%"></div></div>
    <div class="q-prog-meta"><span>Q${qIdx+1} of ${qs.length}</span><span>Write answer → AI feedback</span></div>
    ${(cur.type==='situational'&&cur.context&&cur.context.trim())
      ? `<div class="facts-box"><div class="facts-label">📋 Facts</div><div class="facts-text">${h(cur.context)}</div></div>
         <div class="question-label">❓ Question</div>
         <div class="question-text">${h(cur.prompt||cur.q||'')}</div>`
      : `<div class="question-text">${h(cur.prompt||cur.q||'')}</div>`
    }
    <textarea class="essay-box" id="essayBox" placeholder="Write your answer…"></textarea>
    <div style="display:flex;gap:8px;margin-top:10px;">
      <button class="btn-gold" id="essFB" onclick="submitEssay()">🤖 Get AI Feedback</button>
      <button class="btn-ghost" onclick="nextQ()">Skip →</button>
    </div>
    <div class="ai-fb" id="aiFB"></div>
    <div style="display:flex;justify-content:flex-end;margin-top:8px;"><button class="btn-gold" id="essNext" style="display:none;" onclick="nextQ()">Next →</button></div>`;
}
// ── Eval format badge ──────────────────────────────────────
function evalFormatBadge(format){
  const isSit=format==='essay'||format==='situational'||format==='alac';
  const [label,color,bg]=isSit
    ?['📝 ALAC Scoring','var(--warn)','rgba(255,140,66,.12)']
    :['💡 Conceptual Scoring','#c9a84c','rgba(201,168,76,.12)'];
  return `<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;background:${bg};color:${color};letter-spacing:.04em;margin-right:6px;">${label}</span>`;
}
// ── Error card ─────────────────────────────────────────────
function renderErrorCard(ev){
  const idx=ev._qIdx!=null?ev._qIdx:-1;
  const retryBtn=idx>=0
    ?`<button onclick="retryEvaluation(${idx})" style="background:rgba(201,168,76,.2);border:1px solid rgba(201,168,76,.4);color:#c9a84c;border-radius:6px;padding:3px 11px;font-size:12px;font-weight:700;cursor:pointer;margin-left:8px;">↺ Retry</button>`
    :'';
  return `<div class="ai-fb-head" style="color:var(--danger);flex-wrap:wrap;gap:8px;">⚠️ Evaluation unavailable.${retryBtn}<div style="font-size:11px;color:var(--muted);width:100%;margin-top:2px;">${h(ev.overallFeedback||'Click Retry to re-evaluate.')}</div></div>`;
}
// ── Writing & Mechanics card (non-scoring, shared by ALAC + conceptual) ──
function renderWritingFeedback(ev){
  const wf=ev&&ev.writingFeedback;
  if(!wf) return '';
  const hasSpelling=wf.spelling&&wf.spelling.length;
  const hasGrammar=wf.grammar&&wf.grammar.length;
  const hasOverall=!!wf.overall;
  if(!hasSpelling&&!hasGrammar&&!hasOverall) return '';
  let html=`<div class="writing-feedback-card"><div class="writing-feedback-header">✍️ Writing &amp; Mechanics <span class="writing-feedback-subtitle">(non-scoring)</span></div>`;
  if(hasSpelling) html+=`<div class="writing-feedback-section"><strong>Spelling:</strong><ul>${wf.spelling.map(x=>`<li>${h(x)}</li>`).join('')}</ul></div>`;
  if(hasGrammar) html+=`<div class="writing-feedback-section"><strong>Grammar:</strong><ul>${wf.grammar.map(x=>`<li>${h(x)}</li>`).join('')}</ul></div>`;
  if(hasOverall) html+=`<div class="writing-feedback-overall">${h(wf.overall)}</div>`;
  html+=`</div>`;
  return html;
}
// ── Dispatcher ─────────────────────────────────────────────
function renderEvalCard(ev){
  if(!ev) return '';
  if(ev.grade==='Error'||ev._evalError) return renderErrorCard(ev);
  const fmt=ev.format||ev.questionType||'essay';
  const isSit=fmt==='situational'||fmt==='essay'||fmt==='alac';
  return isSit?renderAlacCard(ev):renderDefCard(ev);
}
// ── Conceptual card ────────────────────────────────────────
function renderDefCard(ev){
  const gc=ev.grade==='Excellent'?'var(--teal-d)':ev.grade==='Good'?'#50d090':ev.grade==='Satisfactory'?'#c9a84c':ev.grade==='Needs Improvement'?'#e09050':'var(--danger)';
  const bd=ev.breakdown||{};
  // Normalise fields the AI sometimes nests inside breakdown instead of top-level
  const overallFeedback=ev.overallFeedback||(typeof bd.overallFeedback==='string'?bd.overallFeedback:'')||'';
  const keyMissedArr=ev.keyMissed?.length?ev.keyMissed:(Array.isArray(bd.keyMissed)?bd.keyMissed:[]);
  const cls=(s,max)=>s>=max*.8?'hi':s>=max*.5?'mid':'lo';
  const defRows=[['Accuracy',bd.accuracy,4],['Completeness',bd.completeness,3],['Clarity',bd.clarity,3]].filter(([,c])=>c);
  const tableRows=defRows.map(([label,c,max])=>`<tr>
    <td style="color:var(--white);font-weight:600;">${label}</td>
    <td><span class="alac-score ${cls(c.score??0,max)}">${c.score!=null?c.score:'—'}</span></td>
    <td style="color:var(--muted);font-size:12px;white-space:nowrap;">/${max}</td>
    <td style="color:rgba(var(--txt2-rgb),.8);">${h(c.feedback||'')}</td>
  </tr>`).join('');
  return `<div class="ai-fb-head">${evalFormatBadge(ev.format)}<span class="ai-fb-score">${h(ev.score||'?/10')}</span><span style="background:rgba(var(--ovl),.08);border-radius:5px;padding:2px 7px;font-family:var(--fm);color:${gc};">${h(ev.grade||'')}</span></div>
  <div class="ai-fb-content">
    <table class="alac-table">
      <thead><tr><th>Component</th><th>Score</th><th>Max</th><th>Feedback</th></tr></thead>
      <tbody>${tableRows}<tr class="alac-total-row"><td style="color:${gc};">Total</td><td style="color:${gc};">${h(ev.score||'?/10')}</td><td style="color:var(--muted);font-size:12px;">/10</td><td style="color:rgba(var(--txt2-rgb),.6);font-size:12px;">${h(overallFeedback)}</td></tr></tbody>
    </table>
    ${keyMissedArr.length?`<p style="margin-top:10px;"><strong>📚 Missed:</strong></p><ul>${keyMissedArr.map(s=>`<li>${h(s)}</li>`).join('')}</ul>`:''}
    ${renderWritingFeedback(ev)}
    <details style="margin-top:12px;"><summary style="cursor:pointer;color:var(--gold);font-weight:600;font-size:13px;">📖 Model Answer</summary>
    <div style="margin-top:8px;padding:12px;background:rgba(var(--ovl),.03);border-radius:9px;">${renderModelAnswer(ev)}</div></details>
  </div>`;
}
// Returns the authoritative numeric score for one question:
// if ALAC components are present, use their sum; otherwise fall back to the AI-returned numericScore.
function effectiveScore(s){
  const al=s.alac||{};
  if(al.answer||al.legalBasis||al.application||al.conclusion){
    return (al.answer?.score??0)+(al.legalBasis?.score??0)+(al.application?.score??0)+(al.conclusion?.score??0);
  }
  return s.numericScore||0;
}
function gradeFromScore(n){
  return n>=8.5?'Excellent':n>=7.0?'Good':n>=5.5?'Satisfactory':n>=4.0?'Needs Improvement':'Poor';
}
// ALAC color thresholds per component
function alacScoreCls(score, key){
  if(key==='answer')      return score>=1.2?'hi':score>=0.7?'mid':'lo';
  if(key==='legalBasis')  return score>=2.0?'hi':score>=1.0?'mid':'lo';
  if(key==='application') return score>=2.8?'hi':score>=1.75?'mid':'lo';
  if(key==='conclusion')  return score>=1.2?'hi':score>=0.7?'mid':'lo';
  return score>=2?'hi':score>=1?'mid':'lo';
}
// ── ALAC model answer helpers ──────────────────────────────────────────────────
// Parse "ANSWER: ...\n\nLEGAL BASIS: ..." text into {answer,legalBasis,application,conclusion}
function parseALACString(text){
  if(!text) return null;
  const SECS=[
    {key:'ANSWER',      field:'answer'},
    {key:'LEGAL BASIS', field:'legalBasis'},
    {key:'APPLICATION', field:'application'},
    {key:'CONCLUSION',  field:'conclusion'},
  ];
  const up=text.toUpperCase();
  const found=SECS.map(s=>({...s,idx:up.indexOf(s.key+':')})).filter(s=>s.idx!==-1).sort((a,b)=>a.idx-b.idx);
  if(found.length<2) return null;
  const comps={answer:'',legalBasis:'',application:'',conclusion:''};
  found.forEach((s,i)=>{
    const start=s.idx+s.key.length+1;
    const end=found[i+1]?found[i+1].idx:text.length;
    comps[s.field]=text.slice(start,end).trim();
  });
  return comps;
}
// Render an ALAC components object as colored section cards
function renderALACSections(components, headerLabel){
  if(!components) return '';
  const DEFS=[
    {field:'answer',      label:'A — Answer',      color:'#4a9eff', icon:'⚖️'},
    {field:'legalBasis',  label:'L — Legal Basis',  color:'var(--amber)', icon:'📜'},
    {field:'application', label:'A — Application',  color:'#4caf50', icon:'🔍'},
    {field:'conclusion',  label:'C — Conclusion',   color:'#ff9800', icon:'✅'},
  ];
  const parts=DEFS.filter(d=>components[d.field]);
  if(!parts.length) return '';
  const title=headerLabel||'📘 Model Answer (ALAC Format)';
  return `<div class="alac-model-answer">
    <div class="alac-model-header">${title}</div>
    ${parts.map(d=>`<div class="alac-section">
      <div class="alac-section-label" style="color:${d.color};">${d.icon} ${d.label}</div>
      <div class="alac-section-content">${h(components[d.field])}</div>
    </div>`).join('')}
  </div>`;
}
// Render structured conceptual model answer (Accuracy, Completeness, Clarity)
function renderConceptualSections(cm){
  if(!cm) return '';
  const DEFS=[
    {field:'accuracy',      label:'Accuracy',      color:'#4a9eff', icon:'✅'},
    {field:'completeness',  label:'Completeness',  color:'#4caf50', icon:'📋'},
    {field:'clarity',       label:'Clarity',        color:'#ff9800', icon:'💡'},
  ];
  const parts=DEFS.filter(d=>cm[d.field]&&cm[d.field].content);
  if(!parts.length) return '';
  let html=`<div class="alac-model-answer">
    <div class="alac-model-header">📋 Model Answer (Conceptual Breakdown)</div>`;
  if(cm.overview) html+=`<div class="alac-section"><div class="alac-section-label" style="color:#5a3e1b;">Overview</div><div class="alac-section-content">${h(cm.overview)}</div></div>`;
  parts.forEach(d=>{
    const sec=cm[d.field];
    html+=`<div class="alac-section">
      <div class="alac-section-label" style="color:${d.color};">${d.icon} ${d.label}</div>
      <div class="alac-section-content">${h(sec.content)}</div>`;
    if(sec.keyPoints&&sec.keyPoints.length) html+=`<ul style="margin:6px 0 2px 0;padding-left:18px;font-size:13px;">${sec.keyPoints.map(p=>`<li style="margin:2px 0;color:var(--text);">${h(p)}</li>`).join('')}</ul>`;
    html+=`</div>`;
  });
  if(cm.conclusion) html+=`<div class="alac-section"><div class="alac-section-label" style="color:#5a3e1b;">Conclusion</div><div class="alac-section-content">${h(cm.conclusion)}</div></div>`;
  if(cm.keyProvisions&&cm.keyProvisions.length) html+=`<div class="alac-section"><div class="alac-section-label" style="color:#5a3e1b;">Key Provisions</div><ul style="margin:4px 0 2px 0;padding-left:18px;font-size:13px;">${cm.keyProvisions.map(p=>`<li style="margin:2px 0;color:var(--text);">${h(p)}</li>`).join('')}</ul></div>`;
  html+=`</div>`;
  return html;
}
// Render model answer — prefers structured alacModelAnswer or conceptualModelAnswer, falls back to ALAC string parse, then plain text
// Accepts either an evaluation object or a plain string (legacy compat)
function renderModelAnswer(evaluation, questionType){
  if(typeof evaluation==='string') evaluation={modelAnswer:evaluation};

  // Alternative answer indicator — only show badge for multi-alt match
  const showBadge = evaluation.showMatchedBadge && evaluation.matchedAlternativeNumber > 0;
  const altBanner = showBadge
    ? `<div style="display:flex;align-items:center;gap:8px;background:#e8f5e9;border:1px solid #81c784;border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:13px;color:#2e7d32;">
        <span style="font-size:15px;">✅</span>
        <span>Matched to <strong>Alternative Answer ${evaluation.matchedAlternativeNumber}</strong> — scored against this version</span>
       </div>`
    : '';

  // Determine ALAC header label
  const alacLabel = showBadge
    ? `📘 Alternative Answer ${evaluation.matchedAlternativeNumber} (ALAC Format)`
    : '📘 Model Answer (ALAC Format)';

  // 1. Conceptual — always show conceptual model answer, never alternatives
  if(evaluation.conceptualModelAnswer){
    const rendered=renderConceptualSections(evaluation.conceptualModelAnswer);
    if(rendered) return rendered;
  }
  // 2. Matched alternative ALAC from server
  if(evaluation.matchedAlternativeAlac){
    const rendered=renderALACSections(evaluation.matchedAlternativeAlac, alacLabel);
    if(rendered) return altBanner + rendered;
  }
  // 3. Structured ALAC components from server
  if(evaluation.alacModelAnswer){
    const rendered=renderALACSections(evaluation.alacModelAnswer, alacLabel);
    if(rendered) return altBanner + rendered;
  }
  // 4. Formatted ALAC string or plain modelAnswer
  const text=evaluation.modelAnswerFormatted||evaluation.modelAnswer||evaluation.correctAnswer||'';
  if(!text) return '<em style="color:#777;font-size:13px;">No model answer available for this question.</em>';
  // 5. Try parsing as ALAC text
  const comps=parseALACString(text);
  if(comps){
    const rendered=renderALACSections(comps, alacLabel);
    if(rendered) return altBanner + rendered;
  }
  return altBanner + `<div class="plain-model-answer">${h(text)}</div>`;
}
function renderAlacCard(ev){
  const gc=ev.grade==='Excellent'?'var(--teal-d)':ev.grade==='Good'?'#50d090':ev.grade==='Satisfactory'?'#c9a84c':ev.grade==='Needs Improvement'?'#e09050':'var(--danger)';
  const al=ev.alac||{};
  const rows=[
    ['A — Answer',      'answer',      al.answer,      1.5],
    ['L — Legal Basis', 'legalBasis',  al.legalBasis,  3.0],
    ['A — Application', 'application', al.application, 4.0],
    ['C — Conclusion',  'conclusion',  al.conclusion,  1.5],
  ];
  const tableRows=rows.map(([label,key,c,maxPts])=>c?`<tr>
    <td style="color:var(--white);font-weight:600;">${label}</td>
    <td><span class="alac-score ${alacScoreCls(c.score??0,key)}">${c.score!=null?c.score:'—'}</span></td>
    <td style="color:var(--muted);font-size:12px;white-space:nowrap;">/${maxPts}</td>
    <td style="color:rgba(var(--txt2-rgb),.8);">${h(c.feedback||'')}</td>
  </tr>`:''
  ).join('');
  const computedTotal=(al.answer?.score??0)+(al.legalBasis?.score??0)+(al.application?.score??0)+(al.conclusion?.score??0);
  const totalDisplay=computedTotal>0?`${+computedTotal.toFixed(1)}/10`:(ev.score||'?/10');
  return `<div class="ai-fb-head">${evalFormatBadge(ev.format||ev.questionType||'essay')}<span class="ai-fb-score">${h(totalDisplay)}</span><span style="background:rgba(var(--ovl),.08);border-radius:5px;padding:2px 7px;font-family:var(--fm);color:${gc};">${h(ev.grade||'')}</span></div>
  <div class="ai-fb-content">
    <table class="alac-table">
      <thead><tr><th>Component</th><th>Score</th><th>Max</th><th>Feedback</th></tr></thead>
      <tbody>${tableRows}<tr class="alac-total-row"><td style="color:${gc};">Total</td><td style="color:${gc};">${h(totalDisplay)}</td><td style="color:var(--muted);font-size:12px;">/10</td><td style="color:rgba(var(--txt2-rgb),.6);font-size:12px;">${h(ev.overallFeedback||'')}</td></tr></tbody>
    </table>
    ${ev.strengths?.length?`<p style="margin-top:10px;"><strong>✅ Strengths:</strong></p><ul>${ev.strengths.map(s=>`<li>${h(s)}</li>`).join('')}</ul>`:''}
    ${ev.improvements?.length?`<p><strong>⚠️ Improve:</strong></p><ul>${ev.improvements.map(s=>`<li>${h(s)}</li>`).join('')}</ul>`:''}
    ${ev.keyMissed?.length?`<p><strong>📚 Missed:</strong></p><ul>${ev.keyMissed.map(s=>`<li>${h(s)}</li>`).join('')}</ul>`:''}
    ${renderWritingFeedback(ev)}
    <details style="margin-top:12px;"><summary style="cursor:pointer;color:var(--gold);font-weight:600;font-size:13px;">📖 Model Answer (ALAC Format)</summary>
    <div style="margin-top:8px;padding:12px;background:rgba(var(--ovl),.03);border-radius:9px;">${renderModelAnswer(ev)}</div></details>
  </div>`;
}
async function submitEssay(){
  const ans=document.getElementById('essayBox')?.value.trim();if(!ans){document.getElementById('essayBox')?.focus();return;}
  const btn=document.getElementById('essFB');btn.disabled=true;btn.textContent='⏳ Evaluating…';
  const pool=quizPool[activeQuiz],cur=pool.data.questions[qIdx];
  const fb=document.getElementById('aiFB');fb.className='ai-fb show';
  fb.innerHTML=`<div class="ai-fb-head"><div class="spin" style="width:16px;height:16px;border-width:2px;"></div> Evaluating…</div>`;
  const payload={question:cur.prompt||cur.q,answer:ans,context:cur.context||'',modelAnswer:cur.modelAnswer,keyPoints:cur.keyPoints,subject:pool.subject,questionId:cur.id||null};
  let lastErr=null;
  for(let attempt=1;attempt<=3;attempt++){
    if(attempt>1){
      fb.innerHTML=`<div class="ai-fb-head"><div class="spin" style="width:16px;height:16px;border-width:2px;"></div> Retrying (${attempt}/3)…</div>`;
      await new Promise(r=>setTimeout(r,attempt*1000));
    }
    try{
      const controller=new AbortController();
      const timeoutId=setTimeout(()=>controller.abort(),120000);
      try{
        const r=await fetch('/api/evaluate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
        clearTimeout(timeoutId);
        const ev=await r.json();if(ev.error)throw new Error(ev.error);
        fb.innerHTML=renderEvalCard(ev);
        document.getElementById('essNext').style.display='block';totalQDone++;updateDash();
        lastErr=null;break;
      }finally{clearTimeout(timeoutId);}
    }catch(err){
      lastErr=err;
      console.error(`[submitEssay] attempt ${attempt}/3 failed:`,err.message);
    }
  }
  if(lastErr){
    console.error('[submitEssay] all 3 retries failed:',lastErr.message);
    fb.innerHTML=`<div class="ai-fb-head" style="color:var(--danger);flex-wrap:wrap;gap:8px;">⚠️ Evaluation unavailable. <button onclick="submitEssay()" style="background:rgba(201,168,76,.2);border:1px solid rgba(201,168,76,.4);color:#c9a84c;border-radius:6px;padding:3px 11px;font-size:12px;font-weight:700;cursor:pointer;">↺ Click to retry</button><div style="font-size:11px;color:var(--muted);width:100%;margin-top:2px;">${h(lastErr.message)}</div></div>`;
  }
  btn.disabled=false;btn.textContent='🤖 Get AI Feedback';
}
async function retryEvaluation(idx){
  const container=document.getElementById('eval-card-'+idx);
  if(!container)return;
  const q=mockQs[idx],ans=mockAnswers[idx]||'';
  if(!ans.trim()){container.innerHTML=renderErrorCard({grade:'Error',overallFeedback:'No answer was provided for this question.',_qIdx:idx});return;}
  let lastErr=null;
  for(let attempt=1;attempt<=3;attempt++){
    container.innerHTML=`<div class="ai-fb-head"><div class="spin" style="width:16px;height:16px;border-width:2px;"></div> ${attempt===1?'Re-evaluating…':`Retrying (${attempt}/3)…`}</div>`;
    if(attempt>1) await new Promise(r=>setTimeout(r,attempt*1000));
    try{
      const controller=new AbortController();
      const timeoutId=setTimeout(()=>controller.abort(),120000);
      try{
        const r=await fetch('/api/evaluate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q.prompt||q.q,answer:ans,context:q.context||'',modelAnswer:q.modelAnswer,keyPoints:q.keyPoints,subject:q.subject,questionId:q.id||null}),signal:controller.signal});
        clearTimeout(timeoutId);
        const ev=await r.json();if(ev.error)throw new Error(ev.error);
        if(!ev.modelAnswer&&q.modelAnswer)ev.modelAnswer=q.modelAnswer;
        if(!ev.keyPoints?.length&&q.keyPoints?.length)ev.keyPoints=q.keyPoints;
        ev._qIdx=idx;
        if(mockScores)mockScores[idx]=ev;
        container.innerHTML=renderEvalCard(ev);
        recomputeResultsDisplay(idx,ev);
        lastErr=null;break;
      }finally{clearTimeout(timeoutId);}
    }catch(err){
      lastErr=err;
      console.error(`[retryEvaluation] Q${idx+1} attempt ${attempt}/3 failed:`,err.message);
    }
  }
  if(lastErr){
    console.error(`[retryEvaluation] Q${idx+1} all retries failed:`,lastErr.message);
    container.innerHTML=renderErrorCard({grade:'Error',overallFeedback:'Evaluation unavailable. Click Retry to try again.',_qIdx:idx});
  }
}
function recomputeResultsDisplay(idx,ev){
  if(!mockScores||!mockQs.length)return;
  const numQuestions=mockQs.length;
  const maxScore=numQuestions*10;
  const rawScore=mockScores.reduce((a,s)=>a+effectiveScore(s),0);
  const pct=maxScore>0?Math.round(rawScore/maxScore*100):0;
  // Update all score-fraction spans inside the results container
  const res=document.getElementById('mockResults');
  if(res){res.querySelectorAll('.score-fraction').forEach(el=>{el.textContent=fmt(rawScore)+'/'+maxScore;});}
  // Update percentage/verdict line
  const pctEl=document.getElementById('mock-pct-display');
  if(pctEl){
    pctEl.style.color=pct>=70?'var(--teal-d)':pct>=55?'#c9a84c':'var(--danger)';
    pctEl.textContent=pct+'% — '+(pct>=70?'✅ PASSED':pct>=55?'📖 Keep Studying':'❌ Needs More Review');
  }
  // Update percentage stat card
  const pctStat=document.getElementById('mock-pct-stat');
  if(pctStat)pctStat.textContent=pct+'%';
  // Update question score badge
  const ns=effectiveScore(ev);
  const qsb=document.getElementById('mock-qsb-'+idx);
  if(qsb){
    const cls=ns>=7?'qsb-high':ns>=5?'qsb-mid':'qsb-low';
    qsb.className='q-score-badge '+cls;
    qsb.textContent=fmt(ns)+'/10';
  }
  console.log(`[recomputeResults] Q${idx+1} retry updated display — new total: ${fmt(rawScore)}/${maxScore} (${pct}%)`);
  updateSupabaseResult(rawScore, pct);
}
async function updateSupabaseResult(rawScore, pct){
  if(!window.mockResultId||!sessionToken)return;
  const numQuestions=mockQs.length;
  const maxScore=numQuestions*10;
  // Build per-question summary with ALAC detail for the record
  const questions=mockScores.map((s,i)=>{
    const ns=effectiveScore(s);
    const entry={q:(mockQs[i]?.prompt||mockQs[i]?.q||'').slice(0,120),score:ns,max:10,improvements:s.improvements||[],keyMissed:s.keyMissed||[]};
    if(s.alac){entry.alac=s.alac;}
    return entry;
  });
  try{
    const r=await fetch('/api/results/'+window.mockResultId,{
      method:'PATCH',
      headers:{'Content-Type':'application/json','x-session-token':sessionToken},
      body:JSON.stringify({score:parseFloat(rawScore.toFixed(2)),questions,passed:pct>=70}),
    });
    const data=await r.json();
    if(!data.ok)throw new Error(data.error||'Update failed');
    console.log('[updateSupabase] Result updated — id:',window.mockResultId,'score:',rawScore);
    // Refresh admin results list if the results panel is currently visible
    const adminResultsPanel=document.getElementById('adminResultsPanel');
    if(adminResultsPanel&&adminResultsPanel.style.display!=='none')loadAdminResults();
  }catch(e){
    console.warn('[updateSupabase] Could not update result record:',e.message);
  }
}
function nextQ(){qIdx++;renderQuizQ();}
function showQuizResults(){
  const pct=qIdx>0?Math.round(qScore/qIdx*100):0;
  const body=document.getElementById('qmBody');if(!body)return;
  body.innerHTML=`<div class="quiz-results">
    <div style="font-size:48px;margin-bottom:12px;">${pct>=70?'⚖️':pct>=50?'📖':'💪'}</div>
    <div style="font-family:var(--fd);font-size:26px;font-weight:700;color:var(--gold-l);margin-bottom:5px;">${pct>=70?'Excellent!':pct>=50?'Good Effort!':'Keep Reviewing!'}</div>
    <div class="qr-stats">
      <div class="qr-stat"><div class="n">${qScore}</div><div class="l">Correct</div></div>
      <div class="qr-stat"><div class="n">${qIdx-qScore}</div><div class="l">Wrong</div></div>
      <div class="qr-stat"><div class="n">${pct}%</div><div class="l">Score</div></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
      <button class="btn-gold" onclick="resetQuiz()">↺ Retry</button>
      <button class="btn-ghost" onclick="nav('learn',document.getElementById('tab-learn'))">📖 Learn</button>
      <button class="btn-mock" onclick="nav('mockbar',document.getElementById('tab-mockbar'))">⏱ Mock Bar</button>
    </div>
  </div>`;
}

// ══════════════════════════════════
// DASHBOARD
// ══════════════════════════════════
function updateDash(){
  const stScore = document.getElementById('st-score');
  const hDone   = document.getElementById('h-done');
  const hMock   = document.getElementById('h-mock');
  if(stScore) stScore.textContent=totalQDone?Math.round(totalCorrect/totalQDone*100)+'%':'—';
  if(hDone)   hDone.textContent=totalQDone;
  if(hMock)   hMock.textContent=mockSessions;
  updateKBIndicator();
  // Recent list
  const recentList = document.getElementById('recent-list');
  if(recentList && VISITED.length){
    recentList.innerHTML=VISITED.slice(0,6).map(v=>{
      const sub=SUBJS.find(s=>s.key===v.subjKey)||{cls:'sg-gen',name:v.subjKey};
      return `<div class="r-item" onclick="navToSubject('${v.subjKey}','learn');setTimeout(()=>clickTopic('${v.subjKey}','${h(v.topicName)}'),50);">
        <div class="r-ic">📖</div>
        <div class="r-info"><div class="r-title">${h(v.topicName)}</div><div class="r-sub">${sub.name}</div></div>
        <span class="sbg ${sub.cls}">${sub.name}</span><span class="tag tg-l">Lesson</span>
      </div>`;
    }).join('');
  }
  renderSubjectTracker();
}
function renderSubjectTracker(){
  const el=document.getElementById('sub-tracker');
  if(!el) return;
  const cachedBySubj={};
  Object.entries(CACHE).forEach(([k,v])=>cachedBySubj[k]=Object.keys(v).length);
  el.innerHTML=SUBJS.map((s,i)=>{
    const total=(KB.syllabusTopics||[]).find(st=>st.key===s.key)?.topics?.length||0;
    const cached=cachedBySubj[s.key]||0;
    const pct=total?Math.round(cached/total*100):0;
    return `<div class="sub-row"><div class="sub-num">${i+1}</div>
      <div style="flex:1;"><div style="font-size:12px;font-weight:600;margin-bottom:1px;">${s.name}</div><div style="font-size:10px;color:var(--muted);">${cached}/${total} topics ready</div></div>
      <div><div class="bar-track"><div class="bar-fill ${s.f}" style="width:${pct}%"></div></div><div style="font-size:10px;color:var(--muted);font-family:var(--fm);">${pct}%</div></div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════
// MOCK BAR
// ══════════════════════════════════
function toggleMockSubj(el){
  if(el.dataset.key==='all'){document.querySelectorAll('.mc-subj-tag').forEach(t=>t.classList.remove('on'));el.classList.add('on');return;}
  document.querySelector('.mc-subj-tag[data-key="all"]').classList.remove('on');
  el.classList.toggle('on');
  if(!document.querySelector('.mc-subj-tag.on'))document.querySelector('.mc-subj-tag[data-key="all"]').classList.add('on');
}

// ══════════════════════════════════
// MOCK BAR SETUP PANEL
// ══════════════════════════════════
function initMockBarSetup(preselectedSubj) {
  // Reset to default state
  mbCount = 20; mbTimeMins = 0; mbDifficulty = 'balanced';
  // Restore panel HTML if it was replaced by locked message
  const cfg = document.getElementById('mockConfig');
  if (cfg && !document.getElementById('mbSetupHeader')) location.reload(); // edge case: panel was destroyed
  // Preset buttons
  document.querySelectorAll('#mbCountRow .mb-preset-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.count)===20));
  document.getElementById('mbCustomCount').style.display = 'none';
  document.querySelectorAll('[data-min]').forEach(b => b.classList.toggle('active', parseInt(b.dataset.min)===0));
  document.querySelectorAll('[data-diff]').forEach(b => b.classList.toggle('active', b.dataset.diff==='balanced'));
  // Subject filter
  const subjectCard = document.getElementById('mbSubjectFilterCard');
  if (preselectedSubj && preselectedSubj !== 'all') {
    // Pre-select specific subject, hide "All" filter card (not needed)
    subjectCard.style.display = 'none';
    // Store selection in data attr
    subjectCard.dataset.forcedSubj = preselectedSubj;
    // Update header
    const subjName = ALL_SUBJS.find(s=>s.key===preselectedSubj)?.name || preselectedSubj;
    document.getElementById('mbSetupHeader').innerHTML = `
      <div style="font-size:24px;margin-bottom:8px;">⏱</div>
      <h2 style="font-family:var(--fd);font-size:26px;font-weight:700;color:var(--gold-l);margin-bottom:8px;">${h(subjName)} — Mock Bar</h2>
      <p style="font-size:13px;color:var(--muted);">Practice questions filtered to ${h(subjName)}.</p>`;
    // Show topic filter for single subject
    updateTopicFilter(preselectedSubj);
  } else {
    subjectCard.style.display = 'block';
    subjectCard.dataset.forcedSubj = '';
    // Select All
    document.querySelectorAll('#mbSubjectTags .mb-subj-tag').forEach(t => t.classList.remove('on'));
    document.querySelector('#mbSubjectTags [data-key="all"]').classList.add('on');
    document.getElementById('mbTopicFilter').style.display = 'none';
    document.getElementById('mbSetupHeader').innerHTML = `
      <div style="font-size:28px;margin-bottom:8px;">⏱🏛</div>
      <h2 style="font-family:var(--fd);font-size:28px;font-weight:700;color:var(--gold-l);margin-bottom:8px;">Mock <em>Bar Examination</em></h2>
      <p style="font-size:13px;color:var(--muted);line-height:1.65;max-width:640px;">Simulate the Philippine Bar Exam. Questions drawn exclusively from your uploaded past bar and exam materials.</p>`;
  }
  // Inject dynamic sources section
  const sourcesList = document.getElementById('mbSourcesList');
  if (sourcesList) sourcesList.innerHTML = renderSourcesSection(preselectedSubj || null);
  // Hide the bottom Past Bar card when a specific subject is shown (sources section shows the files)
  const pbCard = document.getElementById('mbPastBarCard');
  if (pbCard) pbCard.style.display = (preselectedSubj && preselectedSubj !== 'all') ? 'none' : '';
  updateMockPreview();
  // Show config panel
  if (cfg) { cfg.style.display=''; }
  document.getElementById('mockSession').classList.remove('on');
  document.getElementById('mockResults').style.display = 'none';
}

function setMbCount(n, btn) {
  document.querySelectorAll('#mbCountRow .mb-preset-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const custom = document.getElementById('mbCustomCount');
  if (n === 0) { custom.style.display='block'; mbCount = parseInt(custom.value)||10; }
  else { custom.style.display='none'; mbCount = n; }
  updateMockPreview();
}
function setMbTime(mins, btn) {
  document.querySelectorAll('[data-min]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  mbTimeMins = mins;
}
function setMbDiff(diff, btn) {
  document.querySelectorAll('[data-diff]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  mbDifficulty = diff;
}
function toggleMbSubj(btn) {
  const key = btn.dataset.key;
  if (key === 'all') {
    document.querySelectorAll('#mbSubjectTags .mb-subj-tag').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    document.getElementById('mbTopicFilter').style.display = 'none';
  } else {
    document.querySelector('#mbSubjectTags [data-key="all"]').classList.remove('on');
    btn.classList.toggle('on');
    const sel = Array.from(document.querySelectorAll('#mbSubjectTags .mb-subj-tag.on')).filter(b=>b.dataset.key!=='all');
    if (sel.length === 0) {
      document.querySelector('#mbSubjectTags [data-key="all"]').classList.add('on');
      document.getElementById('mbTopicFilter').style.display = 'none';
    } else if (sel.length === 1) {
      updateTopicFilter(sel[0].dataset.key);
    } else {
      document.getElementById('mbTopicFilter').style.display = 'none';
    }
  }
  updateMockBarPreview();
}
function updateTopicFilter(subj) {
  const card = document.getElementById('mbTopicFilter');
  const sylSubj = (KB.syllabusTopics||[]).find(s => s.key === subj);
  if (!sylSubj || !sylSubj.topics?.length) { card.style.display='none'; return; }
  card.style.display = 'block';
  document.getElementById('mbTopicCheckboxes').innerHTML = sylSubj.topics.map(t =>
    `<label style="display:flex;align-items:center;gap:7px;font-size:12px;color:rgba(var(--txt2-rgb),.75);cursor:pointer;padding:3px 0;">
      <input type="checkbox" class="mb-source-check mb-topic-chk" value="${h(t.name)}" checked onchange="updateMockBarPreview()">
      ${h(t.name)}
    </label>`).join('');
}
function setAllMbTopics(checked) {
  document.querySelectorAll('.mb-topic-chk').forEach(c => { c.checked = checked; });
  updateMockBarPreview();
}

function getMbSubjects() {
  const card = document.getElementById('mbSubjectFilterCard');
  const forced = card?.dataset?.forcedSubj;
  if (forced) return [forced];
  const allOn = document.querySelector('#mbSubjectTags [data-key="all"]')?.classList.contains('on');
  if (allOn) return ['all'];
  return Array.from(document.querySelectorAll('#mbSubjectTags .mb-subj-tag.on')).map(b => b.dataset.key);
}
function getMbTopics() {
  return Array.from(document.querySelectorAll('.mb-topic-chk:checked')).map(c => c.value);
}

// Kept as alias for legacy callers; delegates to the unified updateMockPreview()
function updateMockBarPreview() { updateMockPreview(); }

async function startMockBar(){
  const customInput = document.getElementById('mbCustomCount');
  const isCustom = document.querySelector('#mbCountRow .mb-preset-btn[data-count="0"]')?.classList.contains('active');
  const count = isCustom ? (parseInt(customInput?.value)||10) : mbCount;
  const timeMin = mbTimeMins;
  // Determine subject scope: forced subject (custom/single) or multi-subject selection
  const forcedSubj = document.getElementById('mbSubjectFilterCard')?.dataset.forcedSubj;
  const subjects = forcedSubj ? [forcedSubj] : getMbSubjects();
  console.log('Starting mock bar:', {count, subjects, mbDifficulty});
  mockSubjectsUsed = subjects; mockSessionDate = new Date(); mockScores = []; window.mockStartTime = Date.now();
  const btn = document.getElementById('startMockBtn');
  btn.disabled=true; btn.textContent='⏳ Building question set…';
  document.getElementById('mockStartError').style.display='none';
  document.getElementById('mbWarnBanner').style.display='none';
  try{
    const r = await fetch('/api/mockbar/generate',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({subjects, count, includePreGen:false, aiGenerate:false, difficulty:mbDifficulty})});
    const data = await r.json(); if(data.error) throw new Error(data.error);
    if (data.warning) {
      const wb = document.getElementById('mbWarnBanner');
      if (wb) { wb.textContent = data.warning; wb.style.display='block'; }
    }
    console.log('Questions received:',data.questions?.length,'requested:',count);
    startMockSession(data.questions, timeMin);
  }catch(err){
    const errEl=document.getElementById('mockStartError');
    errEl.textContent='⚠️ '+err.message; errEl.style.display='block';
  }
  btn.disabled=false; btn.textContent='🚀 Begin Mock Bar';
}

// Shared session launcher — used by both startMockBar and startSubjectMockBar
function startMockSession(questions, timeMin, subjectKey) {
  if (!questions?.length) { alert('No questions available. Upload reference materials for this subject in Admin.'); return; }
  mockQs = questions; mockIdx = 0; mockAnswers = Array(mockQs.length).fill('');
  mockScores = []; mockSubjectsUsed = []; mockSessionDate = new Date().toISOString();
  mockTimeLimitSecs = timeMin > 0 ? timeMin * 60 : 0;
  window.examHighlights = {};
  window.flaggedQuestions = new Set();
  // Navigate to the mock bar page to show the session UI
  showPage('mockbar');
  clearSidebarActive();
  document.getElementById('mockConfig').style.display = 'none';
  document.getElementById('mockResults').style.display = 'none';
  document.getElementById('mockSession').classList.add('on');
  showSessionOverlay();
  document.getElementById('ms-of').textContent = `of ${mockQs.length}`;
  renderQMarkers();
  if (mockTimeLimitSecs > 0) { mockLeft = mockTimeLimitSecs; document.getElementById('ms-timer').style.display = 'flex'; runTimer(); }
  else document.getElementById('ms-timer').style.display = 'none';
  renderMockQ();
  mockSessions++; updateDash();
  // ── Create and save exam session ──
  const subj = subjectKey || mockQs[0]?.subject || 'all';
  window.lastExamSubject = subj; // remember for "New Session" button
  const subjName = SUBJS.find(s => s.key === subj)?.name || subj;
  window.activeExamSession = {
    sessionId: 'exam_' + Date.now(),
    userId: currentUser?.id,
    subject: subj,
    subjectName: subjName,
    startedAt: new Date().toISOString(),
    lastSavedAt: new Date().toISOString(),
    timeLimit: mockTimeLimitSecs || null,
    timeElapsed: 0,
    totalQuestions: mockQs.length,
    currentQuestion: 0,
    questions: mockQs,
    answers: {},
    difficulty: mbDifficulty || 'balanced',
    status: 'in_progress',
  };
  ExamSession.saveLocal(window.activeExamSession);
  ExamSession.saveServer(window.activeExamSession).catch(() => {});
  ExamSession.startAutoSave(() => window.activeExamSession);
}

function fmtTime(secs){
  const h=Math.floor(secs/3600),m=Math.floor((secs%3600)/60),s=secs%60;
  const mm=m.toString().padStart(2,'0'),ss=s.toString().padStart(2,'0');
  return h>0?`${h}:${mm}:${ss}`:`${m}:${ss}`;
}
function fmt(n,decimals=1){
  if(n===null||n===undefined)return'0';
  const num=parseFloat(n);
  if(isNaN(num))return'0';
  return parseFloat(num.toFixed(decimals)).toString();
}
function formatDate(iso){
  if(!iso)return'Unknown date';
  const d=new Date(iso);
  return d.toLocaleString('en-PH',{timeZone:'Asia/Manila',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:true});
}
function runTimer(){
  if(mockTimer)clearInterval(mockTimer);
  document.getElementById('timer-val').textContent=fmtTime(mockLeft);
  mockTimer=setInterval(()=>{
    mockLeft--;
    document.getElementById('timer-val').textContent=fmtTime(mockLeft);
    const timerEl=document.getElementById('ms-timer');
    timerEl.classList.toggle('critical',mockLeft<=30);
    timerEl.classList.toggle('warn',mockLeft>30&&mockLeft<=60);
    // Track elapsed time for session restore
    if (window.activeExamSession) {
      window.activeExamSession.timeElapsed = (mockTimeLimitSecs||0) - mockLeft;
      // Save to localStorage every 10 seconds
      if (window.activeExamSession.timeElapsed % 10 === 0) {
        ExamSession.saveLocal(window.activeExamSession);
      }
    }
    if(mockLeft<=0){clearInterval(mockTimer);endMockSession();}
  },1000);
}

function renderMockQ(){
  const q=mockQs[mockIdx];if(!q)return;
  document.getElementById('ms-qnum').textContent=`Question ${mockIdx+1}`;
  document.getElementById('ms-prog').style.width=`${((mockIdx+1)/mockQs.length)*100}%`;
  const sub=SUBJS.find(s=>s.key===q.subject)||{name:q.subject,cls:'sg-gen'};
  document.getElementById('ms-src').innerHTML=q.isReal
    ?`<span class="ms-source">📜 ${h(q.pastBarName||q.source||'Past Bar')}${q.year?' · '+h(q.year):''}</span>`
    :q.source==='Pre-generated'
      ?`<span class="ms-source">📚 Pre-generated</span>`
      :`<span class="ms-source">🤖 AI Generated</span>`;
  document.querySelectorAll('.q-marker').forEach((m,i)=>{
    const flagged=window.flaggedQuestions?.has(i);
    m.className='q-marker'+(mockAnswers[i]?.trim()?' done':'')+(i===mockIdx?' current':'')+(flagged?' flagged':'');
    m.innerHTML=(i+1)+(flagged?'<span style="font-size:8px;margin-left:1px;">🚩</span>':'');
  });
  const qText = q.prompt || q.q || '';
  const isSituational = (q.type === 'situational') && q.context && q.context.trim();
  document.getElementById('mockQArea').innerHTML=`
    <div style="display:flex;gap:7px;margin-bottom:18px;flex-wrap:wrap;"><span class="sbg ${sub.cls}">${h(sub.name)}</span><span class="tag tg-e">Bar Essay</span></div>
    <div id="exam-content">
    ${isSituational
      ? `<div class="facts-box"><div class="facts-label">📋 Facts</div><div class="facts-text">${h(q.context)}</div></div>
         <div class="question-label">❓ Question</div>
         <div class="question-text">${h(qText)}</div>`
      : `<div class="question-text">${h(qText)}</div>`
    }
    </div>
    <div style="font-size:11px;color:var(--muted);margin:8px 0 10px;">Write a complete bar exam answer. Navigate freely between questions before submitting.</div>
    <textarea class="essay-box" id="mockBox" style="min-height:220px;" placeholder="Write your answer…" oninput="saveMock()">${h(mockAnswers[mockIdx]||'')}</textarea>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;">
      <button class="btn-ghost" onclick="moveMock(-1)" ${mockIdx===0?'disabled':''}>← Prev</button>
      <span style="font-size:12px;color:var(--muted);font-family:var(--fm);">${mockAnswers.filter(a=>a?.trim()).length}/${mockQs.length} answered</span>
      ${mockIdx<mockQs.length-1?`<button class="btn-gold" onclick="moveMock(1)">Next →</button>`:`<button class="btn-mock" onclick="checkFlaggedBeforeSubmit()">Submit All &amp; Score</button>`}
    </div>`;
  updateFlagButton(mockIdx);
  restoreHighlightsForQuestion(mockIdx);
}
function saveMock(){
  const val = document.getElementById('mockBox')?.value || '';
  mockAnswers[mockIdx] = val;
  if (window.activeExamSession) {
    if (!window.activeExamSession.answers) window.activeExamSession.answers = {};
    // Use the numeric INDEX as key — reliable even when questions have no .id
    window.activeExamSession.answers[mockIdx] = { text: val, savedAt: new Date().toISOString(), wordCount: val.trim().split(/\s+/).filter(w=>w).length };
    window.activeExamSession.currentQuestion = mockIdx;
    ExamSession.saveLocal(window.activeExamSession);
    // Debounce server sync — localStorage write is immediate above
    clearTimeout(window._serverSaveTimer);
    window._serverSaveTimer = setTimeout(() => ExamSession.saveServer(window.activeExamSession).catch(()=>{}), 3000);
    const ind = document.getElementById('exam-save-indicator');
    if (ind) { ind.textContent = '● Saving…'; ind.style.color = 'var(--muted)'; ind.style.opacity = '1'; }
  }
}
function moveMock(d){saveMock();mockIdx=Math.max(0,Math.min(mockQs.length-1,mockIdx+d));renderMockQ();}
function jumpMock(i){saveMock();mockIdx=i;renderMockQ();}

// ── Poll /api/eval-progress until complete, then fetch /api/eval-results ───────
// Updates the progress screen UI and handles stall detection along the way.
async function pollForResults(submissionId, authHdr, expectedCount) {
  let lastDone = -1;
  let stalledChecks = 0;
  let wakeUp = null; // lets "Check Again" button force an immediate poll
  window._evalForceCheck = () => { if (wakeUp) { const fn = wakeUp; wakeUp = null; fn(); } };

  while (true) {
    // Wait 3 s, but allow "Check Again" button to wake early
    await new Promise(r => {
      const tid = setTimeout(r, 3000);
      wakeUp = () => { clearTimeout(tid); r(); };
    });
    wakeUp = null;

    let data;
    try {
      const progRes = await fetch('/api/eval-progress/' + submissionId, { headers: { 'x-session-token': authHdr } });
      if (!progRes.ok) { stalledChecks++; continue; }
      data = await progRes.json();
    } catch(e) { stalledChecks++; continue; }

    const total = data.total || expectedCount;
    const pct   = total > 0 ? Math.round(data.done / total * 100) : 0;

    // Update progress bar
    const doneEl  = document.getElementById('eval-done');
    const totalEl = document.getElementById('eval-total');
    const fillEl  = document.getElementById('eval-progress-fill');
    const msgEl   = document.getElementById('eval-message');
    const noteEl  = document.getElementById('eval-note');
    if (doneEl)  doneEl.textContent  = data.done;
    if (totalEl) totalEl.textContent = total;
    if (fillEl)  fillEl.style.width  = pct + '%';

    // Stall detection — reaching 100% is never a stall; only count if mid-flight
    const allDone = data.done >= total;
    if (allDone) {
      stalledChecks = 0;  // don't count done === total as a stall
    } else if (data.done === lastDone) {
      stalledChecks++;
    } else {
      stalledChecks = 0;
    }
    lastDone = data.done;

    if (msgEl) {
      if (!allDone && stalledChecks >= 10) {
        msgEl.innerHTML = 'Evaluation seems stalled \u2014 <button onclick="window._evalForceCheck&&window._evalForceCheck()" style="background:rgba(201,168,76,.2);border:1px solid rgba(201,168,76,.4);color:#c9a84c;border-radius:6px;padding:3px 11px;font-size:12px;font-weight:700;cursor:pointer;">\u21ba Check Again</button>';
      } else if (!allDone && stalledChecks >= 3) {
        msgEl.textContent = 'Evaluation seems slow \u2014 still processing...';
      } else if (pct < 30) { msgEl.textContent = 'BarBuddy is reviewing your answers...';
      } else if (pct < 70) { msgEl.textContent = 'Analyzing your responses...';
      } else if (pct < 100){ msgEl.textContent = 'Almost done...';
      } else               { msgEl.textContent = 'Preparing your results!'; }
    }
    if (noteEl && data.done > 0 && !data.complete) {
      const rem = allDone ? 0 : Math.max(0, total - data.done);
      if (rem > 0) noteEl.innerHTML = `Please keep this window open.<br><span style="font-size:11px;color:var(--muted);">~${rem} question${rem !== 1 ? 's' : ''} remaining</span>`;
    }

    // Fetch results when complete flag is set OR when all questions are done.
    // Uses an inner retry loop so waiting: true retries /api/eval-results directly
    // every 1.5s instead of bouncing back through the 3s outer poll cycle.
    if (data.complete || allDone) {
      let resultRetries = 0;
      const maxResultRetries = 20; // 20 × 1.5s = 30s max
      while (resultRetries < maxResultRetries) {
        const rRes = await fetch('/api/eval-results/' + submissionId, { headers: { 'x-session-token': authHdr } });
        const rData = await rRes.json();
        console.log('[poll] attempt', resultRetries, 'rData:', JSON.stringify(rData).slice(0, 200));
        if (rData.scores) {
          console.log('[poll] scores received, returning');
          return { scores: rData.scores, xpData: rData.xpData || null };
        }
        if (rData.waiting || !rData.complete) {
          console.log('[poll] waiting, retry', resultRetries);
          resultRetries++;
          if (msgEl) msgEl.textContent = 'Preparing your results...';
          if (noteEl) noteEl.textContent = '';
          await new Promise(r => setTimeout(r, 1500));
          continue; // retry inner loop — NOT the outer poll loop
        }
        console.log('[poll] unrecoverable:', JSON.stringify(rData));
        throw new Error('Results unavailable after evaluation completed');
      }
      throw new Error('Results timed out waiting for server');
    }
  }
}

// ── Resume an evaluation that was in-flight when the page was refreshed ────────
async function resumePendingEvaluation() {
  if (!sessionToken) return false;
  let pending;
  try { pending = JSON.parse(sessionStorage.getItem('bb_pending_eval') || 'null'); } catch(e) {}
  if (!pending?.submissionId) return false;

  const { submissionId, total } = pending;
  const authHdr = sessionToken || '';

  // Verify the submission is still alive on the server
  try {
    const pr = await fetch('/api/eval-progress/' + submissionId, { headers: { 'x-session-token': authHdr } });
    if (!pr.ok) { sessionStorage.removeItem('bb_pending_eval'); return false; }
    const d = await pr.json();
    if (!d.total) { sessionStorage.removeItem('bb_pending_eval'); return false; }
  } catch(e) { sessionStorage.removeItem('bb_pending_eval'); return false; }

  // Show resume progress screen — lock UI while evaluating
  showSessionOverlay();
  const res = document.getElementById('mockResults');
  if (!res) return false;
  res.style.display = 'block';
  res.innerHTML = `<div id="eval-progress-screen">
    <div class="eval-icon">⚖️</div>
    <h2>Evaluation In Progress</h2>
    <p style="font-size:13px;color:var(--muted);margin-bottom:12px;">Your evaluation is still running — resuming where you left off.</p>
    <div class="eval-progress-bar"><div id="eval-progress-fill" class="eval-progress-fill" style="width:0%"></div></div>
    <div class="eval-stats"><span id="eval-done">0</span> / <span id="eval-total">${total}</span> answers evaluated</div>
    <p class="eval-message" id="eval-message">BarBuddy is reviewing your answers...</p>
    <p id="eval-note" class="eval-note">Please keep this window open.<br>Results will appear automatically.</p>
  </div>`;

  try {
    const { scores: resumeScores, xpData: resumeXpData } = await pollForResults(submissionId, authHdr, total);
    sessionStorage.removeItem('bb_pending_eval');
    const fillEl = document.getElementById('eval-progress-fill');
    if (fillEl) fillEl.style.width = '100%';
    // mockQs/mockAnswers are gone after a refresh — show completion notice (with XP popup if available)
    const _showResumeComplete = () => {
      hideSessionOverlay();
      res.innerHTML = `<div class="mock-results" style="text-align:center;padding:48px 24px;">
        <div style="font-size:48px;margin-bottom:12px;">✅</div>
        <div style="font-family:var(--fd);font-size:22px;font-weight:700;color:var(--gold-l);margin-bottom:10px;">Evaluation Complete!</div>
        <p style="color:var(--muted);font-size:14px;margin-bottom:24px;">Your ${resumeScores.length} answer${resumeScores.length !== 1 ? 's have' : ' has'} been evaluated and your score has been saved.</p>
        <button class="btn-mock" onclick="navToSubject(window.lastExamSubject||'overview','mockbar')">⏱ New Session</button>
      </div>`;
    };
    if (resumeXpData && resumeXpData.xpEarned > 0 && sessionToken) {
      showXPPopup(resumeXpData, _showResumeComplete);
    } else {
      _showResumeComplete();
    }
  } catch(e) {
    hideSessionOverlay();
    sessionStorage.removeItem('bb_pending_eval');
    res.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--muted);">Could not resume evaluation. Please start a new session.</div>`;
  }
  return true;
}

async function endMockSession(){
  saveMock();
  if(mockTimer)clearInterval(mockTimer);
  ExamSession.stopAutoSave();
  // This session will change results, XP and spaced-repetition state. Drop the
  // caches up front so anything that reads them mid-evaluation refetches.
  // showXPPopup() invalidates again for the no-XP-awarded paths that skip it.
  invalidateProgressCaches();
  // Mark complete and clear saved session
  if (window.activeExamSession) { window.activeExamSession.status = 'completed'; }
  ExamSession.clearAll().catch(() => {});
  document.getElementById('mockSession').classList.remove('on');
  // Keep overlay active during evaluation — hideSessionOverlay() called when results render
  const answered=mockAnswers.filter(a=>a?.trim()).length;
  const res=document.getElementById('mockResults');
  res.style.display='block';
  res.innerHTML=`<div id="eval-progress-screen">
    <div class="eval-icon">⚖️</div>
    <h2>Evaluating Your Answers</h2>
    <div class="eval-progress-bar"><div id="eval-progress-fill" class="eval-progress-fill" style="width:0%"></div></div>
    <div class="eval-stats"><span id="eval-done">0</span> / <span id="eval-total">${answered}</span> answers evaluated</div>
    <p class="eval-message" id="eval-message">BarBuddy is reviewing your answers...</p>
    <p id="eval-note" class="eval-note">Please keep this window open.<br>Results will appear automatically.</p>
  </div>`;

  // Build batch payload
  const batchPayload=mockQs.map((q,i)=>({id:q.id||null,question:q.prompt||q.q,answer:mockAnswers[i]||'',context:q.context||'',modelAnswer:q.modelAnswer,keyPoints:q.keyPoints,subject:q.subject,_cachedAlternatives:q._cachedAlternatives||null,_cachedAlac:q._cachedAlac||null,alternativeAnswer1:q.alternativeAnswer1||null,alternativeAnswer2:q.alternativeAnswer2||null,alternativeAnswer3:q.alternativeAnswer3||null,alternativeAnswer4:q.alternativeAnswer4||null,alternativeAnswer5:q.alternativeAnswer5||null,alternativeAlac1:q.alternativeAlac1||null,alternativeAlac2:q.alternativeAlac2||null,alternativeAlac3:q.alternativeAlac3||null,alternativeAlac4:q.alternativeAlac4||null,alternativeAlac5:q.alternativeAlac5||null}));
  let scores=[];
  const authHdr=sessionToken||'';
  const submissionId='sub_'+Date.now()+'_'+Math.random().toString(36).slice(2,7);

  // Compute session type early so it can be passed to evaluate-batch
  const _sessionType = window.isReviewSession ? 'review_session' : window.isSpeedDrill ? 'speed_drill' : 'mock_bar';

  // Pre-save result record to get resultId BEFORE evaluation starts.
  // Server will update it with final scores + award XP once evaluate-batch completes.
  let _resultId = null;
  let _xpData = null;
  if (sessionToken && currentUser) {
    try {
      const preR = await fetch('/api/results/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({
          score: 0, total: mockQs.length, subject: currentSubject || 'Mock Bar',
          questions: mockQs.map(q => ({ q: (q.prompt||q.q||'').slice(0, 120), score: 0, max: 10, improvements: [], keyMissed: [] })),
          timeTakenMs: window.mockStartTime ? Date.now() - window.mockStartTime : null,
          sessionType: _sessionType,
        }),
      });
      const preData = await preR.json();
      _resultId = preData.id || null;
      if (_resultId) window.mockResultId = _resultId;
    } catch(e) { console.warn('[endMock] pre-save failed:', e.message); }
  }

  try{
    // Persist so a page refresh can resume polling
    sessionStorage.setItem('bb_pending_eval',JSON.stringify({submissionId,total:mockQs.length}));
    // POST returns immediately — server enqueues all jobs and replies with { submissionId, total }
    const startRes=await fetch('/api/evaluate-batch',{method:'POST',headers:{'Content-Type':'application/json','x-session-token':authHdr},body:JSON.stringify({questions:batchPayload,submissionId,resultId:_resultId,sessionType:_sessionType,subject:currentSubject})});
    const startData=await startRes.json();
    if(startData.error)throw new Error(startData.error);
    // Poll every 3 s, update UI, wait for complete, then fetch scores
    const _pollResult=await pollForResults(submissionId,authHdr,mockQs.length);
    scores=_pollResult.scores; _xpData=_pollResult.xpData;
    sessionStorage.removeItem('bb_pending_eval');
    // Normalize: pad error stubs for any questions the server missed
    while(scores.length<mockQs.length){
      scores.push({score:'0/10',numericScore:0,grade:'Error',overallFeedback:'Evaluation unavailable.',keyMissed:[],_evalError:true});
    }
    const fillEl=document.getElementById('eval-progress-fill');
    const doneEl=document.getElementById('eval-done');
    if(fillEl)fillEl.style.width='100%';
    if(doneEl)doneEl.textContent=scores.length;
  }catch(e){
    sessionStorage.removeItem('bb_pending_eval');
    // Fallback: sequential evaluation (evaluates ALL questions, never skips)
    console.warn('[endMock] batch failed, falling back to sequential:',e.message);
    scores=[];
    for(let i=0;i<mockQs.length;i++){
      const q=mockQs[i],ans=mockAnswers[i]||'';
      if(!ans.trim()){
        scores.push({score:'0/10',numericScore:0,grade:'Not Answered',overallFeedback:'No answer provided.',keyMissed:[]});
      } else {
        let pushed=false;
        for(let attempt=1;attempt<=3;attempt++){
          try{
            const controller=new AbortController();
            const tid=setTimeout(()=>controller.abort(),120000);
            try{
              const r=await fetch('/api/evaluate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q.prompt||q.q,answer:ans,context:q.context||'',modelAnswer:q.modelAnswer,keyPoints:q.keyPoints,subject:q.subject,questionId:q.id||null}),signal:controller.signal});
              clearTimeout(tid);
              const ev=await r.json();
              if(ev.error)throw new Error(ev.error);
              scores.push(ev);pushed=true;break;
            }finally{clearTimeout(tid);}
          }catch(ex){
            console.error(`[endMock fallback] Q${i+1} attempt ${attempt}/3 failed:`,ex.message);
            if(attempt<3)await new Promise(r=>setTimeout(r,attempt*1000));
          }
        }
        if(!pushed)scores.push({score:'0/10',numericScore:0,grade:'Error',overallFeedback:'Evaluation unavailable.',keyMissed:[],_evalError:true});
      }
      // Update progress bar after each question
      const seqFill=document.getElementById('eval-progress-fill');
      const seqDone=document.getElementById('eval-done');
      const seqTotal=document.getElementById('eval-total');
      if(seqFill)seqFill.style.width=Math.round(scores.length/mockQs.length*100)+'%';
      if(seqDone)seqDone.textContent=scores.length;
      if(seqTotal)seqTotal.textContent=mockQs.length;
    }
  }

  mockScores=scores;
  const errCount=scores.filter(s=>s._evalError).length;
  console.log(`[endMock] Evaluated ${scores.length-errCount} / ${scores.length} questions. ${errCount} errors.`);
  const rawScore=scores.reduce((a,s)=>a+effectiveScore(s),0);
  const numQuestions=scores.length||mockQs.length||1;
  const maxScore=numQuestions*10;
  const avg=Math.round(rawScore/numQuestions*10)/10;
  const pct=maxScore>0?Math.round(rawScore/maxScore*100):0;
  totalQDone+=answered;totalCorrect+=Math.round(pct/100*answered);updateDash();

  // Update result record with evaluated scores; server already handled XP via evaluate-batch.
  // If pre-save failed (_resultId is null), fall back to full save (old path).
  if (_resultId && sessionToken) {
    fetch(`/api/results/${_resultId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify({
        score: rawScore,
        questions: scores.map((s,i) => ({ q: (mockQs[i]?.prompt||mockQs[i]?.q||'').slice(0, 120), score: effectiveScore(s), max: 10, improvements: s.improvements||[], keyMissed: s.keyMissed||[] })),
      }),
    }).catch(e => console.warn('[endMock] result patch failed:', e.message));
  } else if (!_resultId) {
    await saveMockBarResults(
      scores.map((s,i)=>({q:(mockQs[i]?.prompt||mockQs[i]?.q||'').slice(0,120),score:effectiveScore(s),max:10,improvements:s.improvements||[],keyMissed:s.keyMissed||[]})),
      _sessionType
    );
  }

  // Pre-fill email modal subject
  const emailSubj=`BarBuddy Mock Bar Results — ${new Date().toLocaleDateString('en-PH',{timeZone:'Asia/Manila'})} — ${fmt(rawScore)}/${maxScore} (${pct}%)`;
  document.getElementById('email-subject').value=emailSubj;

  // Capture current session flags before async gap resets them
  const _isReview = !!window.isReviewSession;
  const _isDrill  = !!window.isSpeedDrill;

  function _renderResults() {
    hideSessionOverlay();
    // The session just changed spaced-repetition state (mastery, next review
    // dates). Refetch so the bell badge reflects what's actually still due
    // rather than the pre-session count.
    checkDueReviews().catch(() => {});
    res.innerHTML=`<div class="mock-results">
    ${currentUser?`<div style="background:rgba(201,168,76,.07);border:1px solid rgba(201,168,76,.18);border-radius:9px;padding:8px 14px;margin-bottom:14px;text-align:left;"><div class="result-user">👤 ${h(currentUser.name)}</div><div style="font-size:11px;color:var(--muted);">${new Date().toLocaleDateString('en-PH',{timeZone:'Asia/Manila'})}</div></div>`:''}
    <div style="font-size:32px;margin-bottom:8px;">🏛</div>
    <div style="font-family:var(--fd);font-size:20px;font-weight:700;color:var(--warn);margin-bottom:4px;">Mock Bar Results</div>
    <div class="mr-grade"><span class="score-fraction">${fmt(rawScore)}/${maxScore}</span></div>
    <div id="mock-pct-display" style="font-size:16px;font-weight:700;color:${pct>=70?'var(--teal-d)':pct>=55?'#c9a84c':'var(--danger)'};margin-bottom:4px;">${pct}% — ${pct>=70?'✅ PASSED':pct>=55?'📖 Keep Studying':'❌ Needs More Review'}</div>
    <div style="font-size:12px;color:var(--muted);font-family:var(--fm);margin-bottom:18px;">Passing score: 70% (${Math.ceil(maxScore*0.7)} / ${maxScore} points)</div>
    <div class="mr-stats">
      <div class="mr-stat"><div class="n"><span class="score-fraction">${fmt(rawScore)}/${maxScore}</span></div><div class="l">Score</div></div>
      <div class="mr-stat"><div id="mock-pct-stat" class="n">${pct}%</div><div class="l">Percentage</div></div>
      <div class="mr-stat"><div class="n">${numQuestions}</div><div class="l">Questions</div></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:center;margin-bottom:22px;flex-wrap:wrap;">
      ${_isReview
        ? `<button onclick="window.isReviewSession=false;navToProgress()" style="display:flex;align-items:center;gap:7px;padding:11px 20px;font-family:var(--fd);font-size:13px;font-weight:700;color:var(--gold-l);background:rgba(212,168,67,.15);border:1px solid rgba(212,168,67,.35);border-radius:10px;cursor:pointer;">📊 My Progress</button>
           <button class="btn-ghost" onclick="window.isReviewSession=false;checkDueReviews().catch(()=>{})">🔄 Review Again</button>`
        : _isDrill
          ? `<button onclick="drillAgain()" style="display:flex;align-items:center;gap:7px;padding:11px 20px;font-family:var(--fd);font-size:13px;font-weight:700;color:#fff;background:linear-gradient(135deg,#6a3de8,#8b5cf6);border:none;border-radius:10px;cursor:pointer;box-shadow:0 4px 14px rgba(106,61,232,.35);">⚡ Drill Again</button>
             <button class="btn-ghost" onclick="window.isSpeedDrill=false;navToSubject(window.lastExamSubject||'overview','speeddrill')">⏱ Back to Setup</button>`
          : `<button class="btn-mock" onclick="navToSubject(window.lastExamSubject||'overview','mockbar')">⏱ New Session</button>`
      }
      <button class="btn-ghost" onclick="backToFlashcards()">🎴 Back to Flashcards</button>
      <button class="btn-ghost" onclick="downloadMockResults()">⬇️ Save</button>
      <button class="btn-ghost" onclick="openModal('emailOverlay')">📧 Email</button>
    </div>
    <h3 style="font-family:var(--fd);font-size:20px;font-weight:700;color:var(--gold-l);margin-bottom:14px;text-align:left;">📋 Question Review</h3>
    ${mockQs.map((q,i)=>{
      const s={...scores[i],_qIdx:i};
      if(!s.modelAnswer&&q.modelAnswer)s.modelAnswer=q.modelAnswer;
      if(!s.keyPoints?.length&&q.keyPoints?.length)s.keyPoints=q.keyPoints;
      const sub=SUBJS.find(x=>x.key===q.subject)||{name:q.subject,cls:'sg-gen'},ns=effectiveScore(s);
      const qText=q.prompt||q.q||'';
      const isSit=(q.type==='situational')&&q.context;
      const qBadgeCls=ns>=7?'qsb-high':ns>=5?'qsb-mid':'qsb-low';
      return `<div class="q-review-item">
        <div style="font-size:11px;color:#a08060;margin-bottom:5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          Q${i+1} · <span class="sbg ${sub.cls}">${sub.name}</span>
          ${q.isReal?`<span style="font-size:9px;">📜 ${h(q.pastBarName||'Past Bar')}</span>`:q.source==='Pre-generated'?'<span style="font-size:9px;color:var(--teal);">📚 Pre-gen</span>':'<span style="font-size:9px;">🤖 AI</span>'}
          <span id="mock-qsb-${i}" class="q-score-badge ${s.grade==='Not Answered'?'qsb-low':qBadgeCls}" style="margin-left:auto;">${s.grade==='Not Answered'?'Not Answered':fmt(ns)+'/10'}</span>
        </div>
        ${isSit
          ? `<div class="facts-box" style="margin-bottom:16px;">
               <div class="facts-label">📋 Facts</div>
               <div class="facts-text" style="font-size:15px;">${h(q.context)}</div>
             </div>
             <div class="question-label">❓ Question</div>
             <div class="question-text" style="font-size:var(--fs-read-sm);margin-bottom:10px;">${h(qText)}</div>`
          : `<div class="question-text" style="font-size:var(--fs-read-sm);margin-bottom:10px;">${h(qText)}</div>`
        }
        ${s.grade==='Not Answered'?'':`
        <div id="eval-card-${i}" class="ai-fb show" style="margin-top:8px;">${renderEvalCard(s)}</div>`}
        ${(()=>{const srPrev=window._srReviewData?.[q.id];if(srPrev==null)return'';const ns=effectiveScore(s);if(ns>=8)return'<div class="sr-motivation sr-mastered">🎉 Mastered! This question won\'t resurface</div>';if(ns>srPrev)return`<div class="sr-motivation sr-improved">📈 Great improvement! Up from ${(+srPrev).toFixed(1)} to ${ns.toFixed(1)}</div>`;return`<div class="sr-motivation sr-retry">Keep practicing — rescheduled for 3 days (${(+srPrev).toFixed(1)} → ${ns.toFixed(1)})</div>`;})()}
        <details style="margin-top:8px;"><summary style="cursor:pointer;color:var(--muted);font-size:12px;font-weight:600;">Your answer</summary>
          <div style="margin-top:6px;padding:10px;background:rgba(var(--ovl),.03);border-radius:8px;font-size:12px;line-height:1.7;color:rgba(var(--txt2-rgb),.8);">${h(mockAnswers[i]||'(no answer)')}</div>
        </details>
      </div>`;
    }).join('')}
  </div>`;
  }

  // Show XP popup (with server-returned xpData) before revealing results
  if (_xpData && _xpData.xpEarned > 0 && sessionToken) {
    showXPPopup(_xpData, _renderResults);
  } else {
    _renderResults();
  }
}

// ══════════════════════════════════
// MANUAL QUESTION UPLOAD
// ══════════════════════════════════
function toggleManualContext(){
  const isSit=document.querySelector('input[name="mn-type"]:checked')?.value==='situational';
  document.getElementById('mn-context-wrap').style.display=isSit?'block':'none';
}
function updateManualPreview(){
  const el=document.getElementById('mn-preview');
  if(!manualBatch.length){el.innerHTML='';return;}
  el.innerHTML=manualBatch.map((q,i)=>`
    <div class="mn-prev-item">
      <span style="font-weight:700;color:var(--gold);font-family:var(--fm);flex-shrink:0;">Q${i+1}</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${h(q.q.slice(0,80))}${q.q.length>80?'…':''}</span>
      <button class="mn-rm" onclick="removeManualQ(${i})">✕</button>
    </div>`).join('');
}
function removeManualQ(i){
  manualBatch.splice(i,1);
  updateManualPreview();
}
function addManualQ(){
  const qText=document.getElementById('mn-q').value.trim();
  if(!qText){document.getElementById('mn-q').focus();document.getElementById('mn-status').innerHTML='<div style="color:var(--danger);font-size:12px;padding:4px 0;">⚠️ Enter the question text first.</div>';return;}
  const type=document.querySelector('input[name="mn-type"]:checked')?.value||'situational';
  const context=type==='situational'?document.getElementById('mn-context').value.trim():'';
  const rawPoints=document.getElementById('mn-points').value.trim();
  const keyPoints=rawPoints?rawPoints.split('\n').map(l=>l.trim()).filter(Boolean):[];
  manualBatch.push({
    q:qText,
    context,
    modelAnswer:document.getElementById('mn-answer').value.trim(),
    keyPoints,
    type,
  });
  // Auto-increment number, clear question-specific fields
  manualQNum++;
  document.getElementById('mn-num').value=manualQNum;
  document.getElementById('mn-q').value='';
  document.getElementById('mn-context').value='';
  document.getElementById('mn-answer').value='';
  document.getElementById('mn-points').value='';
  document.getElementById('mn-status').innerHTML='';
  updateManualPreview();
}
function onMnSubjectChange(val) {
  const inp = document.getElementById('mn-name');
  if (!inp) return;
  inp.placeholder = val === 'custom'
    ? 'e.g. Midterm Exam — Special Topic (Manual)'
    : 'e.g. 2023 Bar — Civil Law (Manual)';
}

async function saveManualBatch(){
  if(!manualBatch.length){document.getElementById('mn-status').innerHTML='<div style="color:var(--danger);font-size:12px;padding:4px 0;">⚠️ Add at least one question first.</div>';return;}
  const name=document.getElementById('mn-name').value.trim();
  if(!name){document.getElementById('mn-name').focus();document.getElementById('mn-status').innerHTML='<div style="color:var(--danger);font-size:12px;padding:4px 0;">⚠️ Enter a batch name.</div>';return;}
  const subject=document.getElementById('mn-subject').value;
  const year=document.getElementById('mn-year').value.trim();
  const sta=document.getElementById('mn-status');
  sta.innerHTML='<div style="color:var(--gold-l);font-size:12px;padding:4px 0;">⏳ Saving…</div>';
  try{
    const r=await fetch('/api/admin/pastbar/manual',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':adminKey},body:JSON.stringify({name,subject,year,questions:manualBatch})});
    const d=await r.json();
    if(d.error)throw new Error(d.error);
    sta.innerHTML=`<div style="color:var(--teal);font-size:12px;padding:4px 0;">✅ Saved ${d.questionsAdded} question${d.questionsAdded===1?'':'s'} to Knowledge Base.</div>`;
    manualBatch=[];manualQNum=1;
    document.getElementById('mn-num').value=1;
    document.getElementById('mn-name').value='';
    updateManualPreview();
    await loadKB();refreshAdminKB();renderPastBarList();
  }catch(e){sta.innerHTML=`<div style="color:var(--danger);font-size:12px;padding:4px 0;">⚠️ ${h(e.message)}</div>`;}
}

function renderPastBarList(){
  const el=document.getElementById('pb-list');if(!el)return;
  if(!KB.pastBar?.length){el.innerHTML=`<div style="font-size:13px;color:var(--muted);text-align:center;padding:12px 0;">No past bar materials uploaded yet.</div>`;return;}
  el.innerHTML=KB.pastBar.map(pb=>{
    const isCustom = pb.subject === 'custom';
    const sub = isCustom ? {cls:'sg-gen',name:'Custom Subject'} : (SUBJS.find(s=>s.key===pb.subject)||{cls:'sg-gen',name:pb.subject});
    const icon = isCustom ? '📁' : '📜';
    const badge = isCustom
      ? `<span class="sbg" style="background:rgba(136,153,170,.15);color:#8899aa;border:1px solid rgba(136,153,170,.3);">📁 Custom</span>`
      : `<span class="sbg ${sub.cls}">${h(sub.name)}</span>`;
    return `<div class="r-item" style="cursor:default;"><div class="r-ic">${icon}</div><div class="r-info"><div class="r-title">${h(pb.name)}</div><div class="r-sub">${pb.year} · ${pb.qCount} question${pb.qCount===1?'':'s'}</div></div>${badge}</div>`;
  }).join('');
}

// ══════════════════════════════════
// PRINT / EMAIL RESULTS
// ══════════════════════════════════
function buildResultsHtml(){
  const e=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
  const dateStr=mockSessionDate?formatDate(mockSessionDate instanceof Date?mockSessionDate.toISOString():mockSessionDate):formatDate(new Date().toISOString());
  const subjStr=(!mockSubjectsUsed.length||mockSubjectsUsed.includes('all'))?'All Subjects':mockSubjectsUsed.map(s=>SUBJS.find(x=>x.key===s)?.name||s).join(', ');
  const userName=window.currentUser?.name||window.loggedInUser?.name||window.user?.name||document.querySelector('.user-name,.topbar-name,#user-display-name,.sidebar-user-name')?.textContent?.trim()||localStorage.getItem('bb_user_name')||(()=>{try{return JSON.parse(localStorage.getItem('bb_user')||'{}').name||'';}catch(e){return'';}})()||'Bar Examinee';
  const answered=mockAnswers.filter(a=>a?.trim()).length;
  const rawSc=mockScores.reduce((a,s)=>a+effectiveScore(s),0);
  const numQ=mockQs.length||mockScores.length||1;
  const maxSc=numQ*10;
  const pct=maxSc>0?Math.round(rawSc/maxSc*100):0;
  const passColor=pct>=70?'#1a7a5e':pct>=55?'#8b6914':'#b32d2d';

  const alacTr=(label,c,max)=>c?`<tr><td style="padding:6px 8px;border:1px solid #d0b870;font-weight:600;">${label}</td><td style="padding:6px 8px;border:1px solid #d0b870;text-align:center;font-weight:bold;">${c.score!=null?fmt(c.score)+'/'+max:'—'}</td><td style="padding:6px 8px;border:1px solid #d0b870;">${e(c.feedback||'')}</td></tr>`:'';

  const qHtml=mockQs.map((q,i)=>{
    const s={...mockScores[i]||{}};
    if(!s.modelAnswer&&q.modelAnswer) s.modelAnswer=q.modelAnswer; // fallback to stored model answer
    if(!s.alacModelAnswer&&q.alacModelAnswer) s.alacModelAnswer=q.alacModelAnswer;
    const sub=SUBJS.find(x=>x.key===q.subject)||{name:q.subject||'Unknown'};
    const qText=q.prompt||q.q||'';
    const ans=mockAnswers[i]||'';
    const al=s.alac||{};
    const hasAlac=!!(al.answer||al.legalBasis||al.application||al.conclusion);
    const isSit=(q.type==='situational')&&q.context;
    const pageBreak=i<mockQs.length-1?'page-break-after:always;':'';
    const qEffScore=effectiveScore(s);
    const qScoreStr=`${+qEffScore.toFixed(1)}/10`;
    const qGrade=gradeFromScore(qEffScore);
    const scoreColor=qEffScore>=7?'#1a7a5e':qEffScore>=5?'#8b6914':'#b32d2d';

    // Normalise fields that the AI sometimes nests inside breakdown
    const _bd=s.breakdown||{};
    const _overallFeedback=s.overallFeedback||(typeof _bd.overallFeedback==='string'?_bd.overallFeedback:'')||'';
    const _keyMissed=s.keyMissed?.length?s.keyMissed:(Array.isArray(_bd.keyMissed)?_bd.keyMissed:[]);

    let card='';
    if(ans.trim()){
      // Score + overall feedback
      card+=`<div style="margin-bottom:8px;"><span style="font-size:15px;font-weight:bold;color:${scoreColor};">${e(qScoreStr)} — ${e(qGrade)}</span></div>`;
      if(_overallFeedback) card+=`<div style="border:1px solid #d0b870;border-radius:6px;padding:12px 16px;margin:8px 0 12px;background:#fffbf0;page-break-inside:avoid;"><div style="font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#7a6128;margin-bottom:6px;">Overall Feedback</div><div style="font-size:13px;line-height:1.7;color:#333;">${e(_overallFeedback)}</div></div>`;

      // Writing & Mechanics card (non-scoring — below overall feedback)
      const _wf = s.writingFeedback || null;
      if(_wf && (_wf.spelling?.length || _wf.grammar?.length || _wf.overall)){
        card+=`<div style="border:1px solid #c9a84c;border-radius:6px;padding:12px 16px;margin:8px 0 12px;background:#fdf8e8;page-break-inside:avoid;"><div style="font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#7a6128;margin-bottom:6px;">✍️ Writing &amp; Mechanics <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#8b6914;">(non-scoring)</span></div>`;
        if(_wf.spelling?.length) card+=`<div style="margin-bottom:6px;"><strong style="font-size:12px;color:#5a3e1b;">Spelling:</strong><ul style="margin:2px 0 0 0;padding-left:18px;font-size:13px;line-height:1.7;color:#333;">${_wf.spelling.map(x=>`<li>${e(x)}</li>`).join('')}</ul></div>`;
        if(_wf.grammar?.length) card+=`<div style="margin-bottom:6px;"><strong style="font-size:12px;color:#5a3e1b;">Grammar:</strong><ul style="margin:2px 0 0 0;padding-left:18px;font-size:13px;line-height:1.7;color:#333;">${_wf.grammar.map(x=>`<li>${e(x)}</li>`).join('')}</ul></div>`;
        if(_wf.overall) card+=`<div style="font-size:13px;line-height:1.7;color:#333;font-style:italic;">${e(_wf.overall)}</div>`;
        card+=`</div>`;
      }

      // ALAC breakdown table
      if(hasAlac){
        card+=`<div style="font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#7a6128;margin:10px 0 5px;">ALAC SCORECARD</div>`;
        card+=`<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px;">
          <tr style="background:#f5efe0;"><th style="text-align:left;padding:6px 8px;border:1px solid #d0b870;font-size:11px;">Component</th><th style="padding:6px 8px;border:1px solid #d0b870;font-size:11px;">Score</th><th style="text-align:left;padding:6px 8px;border:1px solid #d0b870;font-size:11px;">Feedback</th></tr>
          ${alacTr('A — Answer',al.answer,1.5)}
          ${alacTr('L — Legal Basis',al.legalBasis,3.0)}
          ${alacTr('A — Application',al.application,4.0)}
          ${alacTr('C — Conclusion',al.conclusion,1.5)}
        </table>`;
      }

      // Generic breakdown table (definition, enumeration)
      if(s.breakdown&&!hasAlac){
        // Only include actual scoring components (must have numeric score+max); skip misplaced top-level fields
        const bParts=Object.entries(s.breakdown).filter(([,v])=>v&&typeof v==='object'&&v.score!=null&&v.max!=null);
        if(bParts.length){
          card+=`<div style="font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#7a6128;margin:10px 0 5px;">COMPONENT BREAKDOWN</div>`;
          card+=`<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px;">
            <tr style="background:#f5efe0;"><th style="text-align:left;padding:6px 8px;border:1px solid #d0b870;font-size:11px;">Component</th><th style="padding:6px 8px;border:1px solid #d0b870;font-size:11px;">Score</th><th style="text-align:left;padding:6px 8px;border:1px solid #d0b870;font-size:11px;">Feedback</th></tr>
            ${bParts.map(([key,val])=>`<tr><td style="padding:6px 8px;border:1px solid #d0b870;font-weight:600;text-transform:capitalize;">${e(key)}</td><td style="padding:6px 8px;border:1px solid #d0b870;text-align:center;">${val.score!=null?fmt(val.score)+'/'+(val.max||'?'):'—'}</td><td style="padding:6px 8px;border:1px solid #d0b870;">${e(val.feedback||'')}</td></tr>`).join('')}
          </table>`;
        }
      }

      // Strengths
      if(s.strengths?.length) card+=`<div style="background:#f0faf0;border-left:3px solid #4caf50;padding:8px 12px;margin:8px 0;border-radius:4px;"><strong style="color:#2e7d32;font-size:12px;">✅ STRENGTHS</strong><ul style="margin:4px 0 0 0;padding-left:18px;font-size:13px;">${s.strengths.map(x=>`<li style="margin:2px 0;">${e(x)}</li>`).join('')}</ul></div>`;

      // Improvements
      if(s.improvements?.length) card+=`<div style="background:#fffbf0;border-left:3px solid #ff9800;padding:8px 12px;margin:8px 0;border-radius:4px;"><strong style="color:#e65100;font-size:12px;">⚠️ AREAS FOR IMPROVEMENT</strong><ul style="margin:4px 0 0 0;padding-left:18px;font-size:13px;">${s.improvements.map(x=>`<li style="margin:2px 0;">${e(x)}</li>`).join('')}</ul></div>`;

      // Key points missed
      if(_keyMissed.length) card+=`<div style="background:#fff5f5;border-left:3px solid #f44336;padding:8px 12px;margin:8px 0;border-radius:4px;"><strong style="color:#c62828;font-size:12px;">❌ KEY POINTS MISSED</strong><ul style="margin:4px 0 0 0;padding-left:18px;font-size:13px;">${_keyMissed.map(k=>`<li style="margin:2px 0;">${e(k)}</li>`).join('')}</ul></div>`;

      // Model answer — render with ALAC sections if structured
      card+=`<div style="font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#7a6128;margin:12px 0 5px;">MODEL ANSWER</div>`;
      const _showBadge=s.showMatchedBadge&&s.matchedAlternativeNumber>0;
      if(_showBadge) card+=`<div style="background:#e8f5e9;border:1px solid #81c784;border-radius:4px;padding:6px 10px;margin-bottom:8px;font-size:12px;color:#2e7d32;">✅ Matched to Alternative Answer ${s.matchedAlternativeNumber} — scored against this version</div>`;
      const _printAlacHeader=_showBadge?`Alternative Answer ${s.matchedAlternativeNumber} (ALAC Format)`:'Model Answer (ALAC Format)';
      (()=>{
        // 0. Prefer matchedAlternativeAlac if present
        const altAc=s.matchedAlternativeAlac;
        if(altAc&&(altAc.answer||altAc.legalBasis||altAc.application||altAc.conclusion)){
          const DEFS=[['A — Answer',altAc.answer],['L — Legal Basis',altAc.legalBasis],['A — Application',altAc.application],['C — Conclusion',altAc.conclusion]];
          let sec=`<div class="alac-model-answer"><div class="alac-model-header">${_printAlacHeader}</div>`;
          DEFS.forEach(([label,content])=>{
            if(content) sec+=`<div class="alac-section"><div class="alac-section-label">${label}</div><div class="alac-section-content">${e(content)}</div></div>`;
          });
          sec+='</div>';
          card+=sec;
          return;
        }
        // 1. Prefer structured alacModelAnswer components
        const ac=s.alacModelAnswer;
        if(ac&&(ac.answer||ac.legalBasis||ac.application||ac.conclusion)){
          const DEFS=[['A — Answer',ac.answer],['L — Legal Basis',ac.legalBasis],['A — Application',ac.application],['C — Conclusion',ac.conclusion]];
          let sec=`<div class="alac-model-answer"><div class="alac-model-header">${_printAlacHeader}</div>`;
          DEFS.forEach(([label,content])=>{
            if(content) sec+=`<div class="alac-section"><div class="alac-section-label">${label}</div><div class="alac-section-content">${e(content)}</div></div>`;
          });
          sec+='</div>';
          card+=sec;
          return;
        }
        // 2. Structured conceptual model answer
        const cm=s.conceptualModelAnswer;
        if(cm&&(cm.accuracy||cm.completeness||cm.clarity)){
          const CDEFS=[['Accuracy',cm.accuracy,'✅'],['Completeness',cm.completeness,'📋'],['Clarity',cm.clarity,'💡']];
          let sec='<div class="alac-model-answer"><div class="alac-model-header">Model Answer (Conceptual Breakdown)</div>';
          if(cm.overview) sec+=`<div class="alac-section"><div class="alac-section-label">Overview</div><div class="alac-section-content">${e(cm.overview)}</div></div>`;
          CDEFS.forEach(([label,comp,icon])=>{
            if(comp&&comp.content){
              sec+=`<div class="alac-section"><div class="alac-section-label">${icon} ${label}</div><div class="alac-section-content">${e(comp.content)}</div>`;
              if(comp.keyPoints&&comp.keyPoints.length) sec+=`<ul style="margin:4px 0 0 0;padding-left:18px;font-size:12px;">${comp.keyPoints.map(p=>`<li style="margin:2px 0;">${e(p)}</li>`).join('')}</ul>`;
              sec+=`</div>`;
            }
          });
          if(cm.conclusion) sec+=`<div class="alac-section"><div class="alac-section-label">Conclusion</div><div class="alac-section-content">${e(cm.conclusion)}</div></div>`;
          if(cm.keyProvisions&&cm.keyProvisions.length) sec+=`<div class="alac-section"><div class="alac-section-label">Key Provisions</div><ul style="margin:4px 0 0 0;padding-left:18px;font-size:12px;">${cm.keyProvisions.map(p=>`<li style="margin:2px 0;">${e(p)}</li>`).join('')}</ul></div>`;
          sec+='</div>';
          card+=sec;
          return;
        }
        // 3. Fall back to plain text with ALAC string parsing
        const ma=s.modelAnswerFormatted||s.modelAnswer||'';
        if(!ma){card+=`<div style="background:#f0f8f0;border:1px solid #b0d8b0;border-radius:4px;padding:10px 14px;font-size:13px;line-height:1.7;margin-bottom:10px;">—</div>`;return;}
        const PSEC=[{k:'ANSWER',l:'A — Answer'},{k:'LEGAL BASIS',l:'L — Legal Basis'},{k:'APPLICATION',l:'A — Application'},{k:'CONCLUSION',l:'C — Conclusion'}];
        const up=ma.toUpperCase();
        const found=PSEC.map(ps=>({...ps,idx:up.indexOf(ps.k+':')})).filter(ps=>ps.idx!==-1).sort((a,b)=>a.idx-b.idx);
        if(found.length<2){card+=`<div style="background:#f0f8f0;border:1px solid #b0d8b0;border-radius:4px;padding:10px 14px;font-size:13px;line-height:1.7;margin-bottom:10px;">${e(ma)}</div>`;return;}
        let sec=`<div class="alac-model-answer"><div class="alac-model-header">${_printAlacHeader}</div>`;
        found.forEach((f,i)=>{
          const end=f.idx+f.k.length+1;
          const next=found[i+1]?found[i+1].idx:ma.length;
          const content=ma.slice(end,next).trim();
          if(content) sec+=`<div class="alac-section"><div class="alac-section-label">${f.l}</div><div class="alac-section-content">${e(content)}</div></div>`;
        });
        sec+='</div>';
        card+=sec;
      })();

      // Student answer
      card+=`<div style="font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#7a6128;margin:12px 0 5px;">STUDENT ANSWER</div>`;
      card+=`<div style="background:#f9f9f9;border:1px solid #ddd;border-radius:4px;padding:10px 14px;font-size:13px;line-height:1.7;">${e(ans)}</div>`;
    } else {
      card='<div style="color:#999;font-style:italic;font-size:13px;margin:8px 0;">— Not Answered —</div>';
    }

    return `<div style="padding:22px 0;${pageBreak}${i>0?'border-top:1px solid #e0d0a0;':''}">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">
        <span style="font-size:17px;font-weight:bold;color:#7a6128;">Q${i+1}</span>
        <span style="background:#eee;border-radius:4px;padding:2px 8px;font-size:12px;color:#333;">${e(sub.name)}</span>
        <span style="color:#666;font-size:12px;">${q.isReal?'📜 Past Bar '+(q.year||q.source||''):q.source==='Pre-generated'?'📚 Pre-generated':'🤖 AI Generated'}</span>
        ${ans.trim()?`<span style="margin-left:auto;font-weight:bold;color:${scoreColor};font-size:14px;">${e(qScoreStr)}</span>`:''}
      </div>
      ${isSit?`<div style="background:#f0f4ff;border-left:3px solid #3a5abf;padding:10px 14px;margin-bottom:12px;border-radius:4px;"><div style="font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:.08em;color:#3a5abf;margin-bottom:5px;">FACTS</div><div style="font-size:13px;line-height:1.7;">${e(q.context)}</div></div>`:''}
      <div style="font-size:14px;font-weight:bold;line-height:1.7;margin-bottom:14px;">${e(qText)}</div>
      ${card}
    </div>`;
  }).join('');

  return `<div style="font-family:Georgia,serif;color:#111;max-width:800px;margin:0 auto;padding:20px;">
    <h1 style="font-size:22px;color:#7a6128;border-bottom:2px solid #7a6128;padding-bottom:8px;margin-bottom:4px;">BarBuddy — Mock Bar Examination Results</h1>
    <p style="font-size:1rem;color:#5a3e1b;margin:4px 0 16px 0;"><strong>Examinee:</strong> ${e(userName)}</p>
    <div style="font-size:13px;color:#333;margin-bottom:14px;line-height:2;">
      <div><strong>Date:</strong> ${e(dateStr)}</div>
      <div><strong>Subject:</strong> ${e(subjStr)}</div>
      <div><strong>Questions:</strong> ${answered} answered / ${numQ} total</div>
    </div>
    <div style="font-size:2.5rem;font-weight:bold;color:${passColor};margin:10px 0 2px;word-break:break-word;">${fmt(rawSc)}/${maxSc}</div>
    <div style="font-size:16px;font-weight:bold;color:${passColor};margin:0 0 5px;">${pct}% — ${pct>=70?'✅ PASSED':pct>=55?'📖 KEEP STUDYING':'❌ NEEDS MORE REVIEW'}</div>
    <div style="font-size:12px;color:#888;margin-bottom:20px;">Passing score: 70% (${Math.ceil(maxSc*0.7)} / ${maxSc} points)</div>
    ${qHtml}
    <div style="margin-top:30px;padding-top:12px;border-top:1px solid #ccc;font-size:11px;color:#666;text-align:center;">Generated by BarBuddy — Philippine Bar Exam Companion</div>
  </div>`;
}

// Standalone HTML document wrapping the results body. Shared by the download
// and by printMockResults, so a saved file and a printed page look identical.
// Deliberately self-contained with inline styles and no app CSS: the file has
// to survive being opened from disk months later with no network.
function _buildResultsDocument(){
  const body=buildResultsHtml();
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BarBuddy Results</title><style>
    body{font-family:Georgia,serif;color:#111;}
    @media print{@page{margin:1.5cm;} .alac-model-answer,.alac-section{page-break-inside:avoid;break-inside:avoid;max-height:none;overflow:visible;height:auto;}}
    ul{margin:4px 0 8px 0;padding-left:20px;}
    li{margin:2px 0;line-height:1.5;}
    table{width:100%;border-collapse:collapse;margin-bottom:12px;font-size:12px;}
    th{background:#f5efe0;color:#5a3e1b;padding:6px 8px;text-align:left;font-weight:600;border:1px solid #d0b870;}
    td{padding:5px 8px;border:1px solid #e8e0d0;vertical-align:top;}
    tr:nth-child(even) td{background:#faf7f2;}
    .alac-model-answer{border:1px solid #d4c5a0;border-radius:6px;margin:8px 0;background:#fffdf5;page-break-inside:avoid;break-inside:avoid;overflow:visible;}
    .alac-model-header{background:#f5f0e8;padding:8px 12px;font-size:.85rem;font-weight:700;color:#5a3e1b;border-bottom:1px solid #d4c5a0;border-radius:6px 6px 0 0;}
    .alac-section{padding:10px 12px;border-bottom:1px solid #e8e0d0;page-break-inside:avoid;break-inside:avoid;}
    .alac-section:last-child{border-bottom:none;}
    .alac-section-label{font-size:.78rem;font-weight:700;color:#5a3e1b;text-transform:uppercase;margin-bottom:4px;}
    .alac-section-content{font-size:.88rem;color:#333;line-height:1.6;white-space:pre-line;padding-left:10px;border-left:2px solid #d4c5a0;}
    .plain-model-answer{font-size:.88rem;color:#333;line-height:1.6;white-space:pre-line;}
  </style></head><body>${body}</body></html>`;
}

// Saves the results as a file instead of routing through the print dialog.
// A pop-up blocker can silently kill window.open; a blob download cannot.
function downloadMockResults(){
  if(!mockQs.length)return;
  const subj = (window.lastExamSubject || currentSubject || 'results')
    .replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'');
  const date = new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Manila'}); // YYYY-MM-DD
  const name = `BarBuddy-${subj}-${date}.html`;
  try{
    const blob = new Blob([_buildResultsDocument()], {type:'text/html;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    // Revoke on the next tick — revoking synchronously can cancel the download.
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
    showToast(`Saved ${name}`, 'success');
  }catch(e){
    showToast('Could not save the file — please try again', 'error');
  }
}

// Kept for the browser's own print path and any future caller.
function printMockResults(){
  if(!mockQs.length)return;
  const w=window.open('','_blank');
  if(!w){alert('Pop-up blocked. Please allow pop-ups to print results.');return;}
  w.document.write(_buildResultsDocument());
  w.document.close();w.focus();
  setTimeout(()=>w.print(),600);
}

// Mock Bar is launched from a subject, so "back" means that subject's
// flashcards. Falls back to Overview when the subject is unknown (for example
// a resumed session after a reload).
function backToFlashcards(){
  const subj = window.lastExamSubject || currentSubject;
  if (subj && subj !== 'overview') navToSubject(subj, 'flashcards');
  else navToOverview();
}

async function sendEmailResults(){
  const to='barbuddyphilippines@gmail.com';
  const subject=document.getElementById('email-subject').value.trim();
  const sta=document.getElementById('email-status');
  const btn=document.getElementById('emailSendBtn');
  if(!to){sta.style.display='block';sta.style.background='rgba(155,35,53,.15)';sta.style.color='var(--danger)';sta.textContent='⚠️ Enter an email address.';return;}
  btn.disabled=true;btn.textContent='⏳ Sending…';
  sta.style.display='block';sta.style.background='rgba(201,168,76,.1)';sta.style.color='var(--gold-l)';sta.textContent='Sending…';
  try{
    const r=await fetch('/api/email-results',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to,subject,htmlBody:buildResultsHtml()})});
    const d=await r.json();
    if(d.error){
      sta.style.background='rgba(155,35,53,.15)';sta.style.color='var(--danger)';
      sta.innerHTML=`⚠️ ${h(d.error)}${d.error.includes('not configured')?'<br><small style="display:block;margin-top:5px;opacity:.8;">Go to Railway → Variables → add EMAIL_USER and EMAIL_PASS (Gmail app password).</small>':''}`;
    }else{
      sta.style.background='rgba(20,180,160,.1)';sta.style.color='var(--teal)';
      sta.textContent=`✅ Results sent to ${to}`;
    }
  }catch(err){sta.style.background='rgba(155,35,53,.15)';sta.style.color='var(--danger)';sta.textContent='⚠️ '+err.message;}
  btn.disabled=false;btn.textContent='📧 Send Results';
}

// ══════════════════════════════════
// ADMIN
// ══════════════════════════════════
// ══════════════════════════════════
// TAB ACCESS CONTROL
// ══════════════════════════════════
let pendingTabSettings = null;
let currentAccessUserId = null;
let currentAccessUserName = '';
let pendingUserTabSettings = null;

function getDefaultTabSettings() {
  return {
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
}

async function applyTabSettings() {
  try {
    // Students get merged (global + per-user) settings; admins get global only
    // Use both adminKey AND isAdmin flag — a student should NEVER get global-only settings
    const isAdm = !!adminKey && currentUser?.isAdmin;
    const url     = (!isAdm && sessionToken) ? '/api/user/tab-settings' : '/api/tab-settings';
    const headers = (!isAdm && sessionToken) ? {'x-session-token': sessionToken} : {};
    const r = await fetch(url, { headers });
    const settings = await r.json();
    window.TAB_SETTINGS = settings;
    const isAdmin = isAdm;
    // Update sidebar subject rows — dim if all modes disabled, show lock icon
    SUBJS.forEach(s => {
      const subjEl = document.getElementById(`sb-subj-${s.key}`);
      if (!subjEl) return;
      const allModes = ['learn','quiz','mockbar','speeddrill'];
      const allDisabled = ['learn','quiz','mockbar'].every(m => settings.subjects?.[s.key]?.[m] === false);
      const anyDisabled = allModes.some(m => settings.subjects?.[s.key]?.[m] === false);
      if (!isAdmin && allDisabled) {
        subjEl.style.display = 'none';
      } else {
        subjEl.style.display = '';
        subjEl.style.opacity = allDisabled ? '0.35' : '';
      }
      const lockEl = subjEl.querySelector('.sb-lock-icon');
      if (lockEl) lockEl.style.display = allDisabled ? '' : 'none';
      // Partial label
      let partialEl = subjEl.querySelector('.sb-partial-label');
      if (anyDisabled && !allDisabled && isAdmin) {
        if (!partialEl) {
          partialEl = document.createElement('span');
          partialEl.className = 'sb-partial-label';
          partialEl.style.cssText = 'font-size:9px;opacity:.5;margin-left:4px;color:var(--muted);flex-shrink:0;';
          partialEl.textContent = '(partial)';
          subjEl.appendChild(partialEl);
        }
      } else if (partialEl) {
        partialEl.remove();
      }
    });
    // Custom subject — check both global tab setting AND per-user toggle
    const customEl = document.getElementById('sb-subj-custom');
    if (customEl) {
      const cEnabled = isCustomSubjectEnabled();
      if (!isAdmin && !cEnabled) customEl.style.display = 'none';
      else { customEl.style.display = ''; customEl.style.opacity = cEnabled ? '' : '0.35'; }
      const lockIcon = customEl.querySelector('.sb-lock-icon');
      if (lockIcon) lockIcon.style.display = (!cEnabled) ? '' : 'none';
    }
    // If currently on subject page, refresh its tab bar to reflect new permissions
    if (currentSubject && document.querySelector('#page-subject.on')) {
      renderSubjectTabs(currentSubject, currentMode || 'learn');
      // If current tab just got disabled, auto-switch
      if (settings.subjects?.[currentSubject]?.[currentMode] === false) {
        const first = ['learn','quiz','mockbar','speeddrill'].find(m => settings.subjects?.[currentSubject]?.[m] !== false);
        if (first) switchSubjectTab(currentSubject, first);
      }
    }
    // Enforce spaced repetition toggle (global + per-user)
    if (!isSREnabled()) {
      refreshNotifications();   // drops the due-review notification + badge
    }
    updateAccessControlBadge();
  } catch(e) { console.warn('Tab settings load failed:', e.message); }
}

function initTabControls() {
  if (window.TAB_SETTINGS) {
    pendingTabSettings = JSON.parse(JSON.stringify(window.TAB_SETTINGS));
  } else {
    pendingTabSettings = getDefaultTabSettings();
  }
  renderTabControls();
}

function renderTabControls() {
  const container = document.getElementById('tabToggleList');
  if (!container) return;
  const s = pendingTabSettings || getDefaultTabSettings();
  const modeLabels = { learn: '📖 Learn', quiz: '✏️ Quiz', mockbar: '⏱ Mock Bar', speeddrill: '⚡ Speed Drill', flashcards: '🎴 Flashcards' };
  let html = '';
  // Global shortcuts
  html += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
    <button class="tab-global-btn" onclick="setAllTabs(true)">✅ Enable All</button>
    <button class="tab-global-btn" onclick="setAllTabs(false)">🔒 Disable All</button>
    <button class="tab-global-btn" onclick="setAllOfMode('learn',false)">Hide All Learn</button>
    <button class="tab-global-btn" onclick="setAllOfMode('quiz',false)">Hide All Quiz</button>
    <button class="tab-global-btn" onclick="setAllOfMode('mockbar',false)">Hide All Mock Bar</button>
    <button class="tab-global-btn" onclick="setAllOfMode('speeddrill',false)">Hide All Speed Drill</button>
    <button class="tab-global-btn" onclick="setAllOfMode('flashcards',false)">Hide All Flashcards</button>
    <button class="tab-global-btn" onclick="setCustomSubjectToggle(false)" style="background:rgba(0,180,180,.1);border-color:rgba(0,180,180,.3);color:#00b4b4;">Hide All Custom Sub</button>
    <button class="tab-global-btn" onclick="setSpacedRepToggle(true)">🧠 Spaced Rep ON</button>
    <button class="tab-global-btn" onclick="setSpacedRepToggle(false)">🧠 Spaced Rep OFF</button>
    <button class="tab-global-btn" style="margin-left:auto;color:var(--muted);" onclick="resetTabSettings()">↺ Reset Defaults</button>
  </div>`;
  // Per-subject rows
  SUBJS.forEach(subj => {
    const ss = s.subjects?.[subj.key] || {};
    const subjModes = ['learn','quiz','mockbar','speeddrill','flashcards'];
    html += `<div class="tab-ctrl-subject-header">
      <span class="tab-ctrl-subject-dot" style="background:${subj.color};"></span>
      <span style="font-size:13px;font-weight:600;">${subj.name}</span>
    </div>
    <div style="padding-left:16px;margin-bottom:12px;">`;
    subjModes.forEach(mode => {
      const on = ss[mode] !== false;
      html += `<div class="tab-ctrl-row">
        <span style="font-size:12px;min-width:100px;color:var(--muted);">${modeLabels[mode]}</span>
        <div class="tab-ctrl-btns">
          <button class="tct-on${on?' tct-active':''}" onclick="setTabSetting('${subj.key}','${mode}',true)">ON</button>
          <button class="tct-off${!on?' tct-active':''}" onclick="setTabSetting('${subj.key}','${mode}',false)">OFF</button>
        </div>
      </div>`;
    });
    html += `</div>`;
  });
  // Custom Subject — all 4 modes (same as regular subjects)
  const cs = s.subjects?.custom || {};
  html += `<div class="tab-ctrl-subject-header">
    <span class="tab-ctrl-subject-dot" style="background:#8899aa;"></span>
    <span style="font-size:13px;font-weight:600;">Custom Subject</span>
  </div>
  <div style="padding-left:16px;margin-bottom:12px;">`;
  ['learn','quiz','mockbar','speeddrill','flashcards'].forEach(mode => {
    const on = cs[mode] !== false;
    html += `<div class="tab-ctrl-row">
      <span style="font-size:12px;min-width:100px;color:var(--muted);">${modeLabels[mode]}</span>
      <div class="tab-ctrl-btns">
        <button class="tct-on${on?' tct-active':''}" onclick="setTabSetting('custom','${mode}',true)">ON</button>
        <button class="tct-off${!on?' tct-active':''}" onclick="setTabSetting('custom','${mode}',false)">OFF</button>
      </div>
    </div>`;
  });
  html += `</div>`;
  // Spaced Repetition global toggle card
  const srOn = s.spaced_repetition !== false;
  html += `<div style="margin-top:16px;padding:16px;border:1px solid var(--bdr2);border-radius:12px;background:rgba(26,138,116,.04);">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="font-size:16px;">🧠</span>
      <span style="font-size:14px;font-weight:700;color:var(--teal);">Spaced Repetition Review</span>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:12px;line-height:1.5;">Controls student access to the Review Session feature globally</div>
    <div class="tab-ctrl-row">
      <span style="font-size:12px;min-width:140px;color:var(--muted);">Spaced Repetition</span>
      <div class="tab-ctrl-btns">
        <button class="tct-on${srOn?' tct-active':''}" onclick="setSpacedRepToggle(true)">ON</button>
        <button class="tct-off${!srOn?' tct-active':''}" onclick="setSpacedRepToggle(false)">OFF</button>
      </div>
    </div>
  </div>`;
  container.innerHTML = html;
}

function setSpacedRepToggle(value) {
  if (!pendingTabSettings) pendingTabSettings = getDefaultTabSettings();
  pendingTabSettings.spaced_repetition = value;
  renderTabControls();
}

function setCustomSubjectToggle(value) {
  if (!pendingTabSettings) pendingTabSettings = getDefaultTabSettings();
  if (!pendingTabSettings.subjects) pendingTabSettings.subjects = {};
  if (!pendingTabSettings.subjects.custom) pendingTabSettings.subjects.custom = {};
  ['learn','quiz','mockbar','speeddrill'].forEach(m => { pendingTabSettings.subjects.custom[m] = value; });
  renderTabControls();
}

function setTabSetting(subject, mode, value) {
  if (!pendingTabSettings) pendingTabSettings = getDefaultTabSettings();
  if (!pendingTabSettings.subjects) pendingTabSettings.subjects = {};
  if (!pendingTabSettings.subjects[subject]) pendingTabSettings.subjects[subject] = {};
  pendingTabSettings.subjects[subject][mode] = value;
  renderTabControls();
}

function setAllTabs(value) {
  if (!pendingTabSettings) pendingTabSettings = getDefaultTabSettings();
  pendingTabSettings.spaced_repetition = value;
  SUBJS.forEach(s => {
    if (!pendingTabSettings.subjects[s.key]) pendingTabSettings.subjects[s.key] = {};
    ['learn','quiz','mockbar','speeddrill'].forEach(m => { pendingTabSettings.subjects[s.key][m] = value; });
  });
  // Custom subject — all 4 modes
  if (!pendingTabSettings.subjects.custom) pendingTabSettings.subjects.custom = {};
  ['learn','quiz','mockbar','speeddrill'].forEach(m => { pendingTabSettings.subjects.custom[m] = value; });
  renderTabControls();
}

function setAllOfMode(mode, value) {
  if (!pendingTabSettings) pendingTabSettings = getDefaultTabSettings();
  SUBJS.forEach(s => {
    if (!pendingTabSettings.subjects[s.key]) pendingTabSettings.subjects[s.key] = {};
    pendingTabSettings.subjects[s.key][mode] = value;
  });
  // Also apply to custom subject
  if (!pendingTabSettings.subjects.custom) pendingTabSettings.subjects.custom = {};
  pendingTabSettings.subjects.custom[mode] = value;
  renderTabControls();
}

async function saveTabSettings() {
  const btn = document.getElementById('saveTabBtn');
  btn.disabled = true; btn.textContent = '⏳ Saving…';
  try {
    const r = await fetch('/api/admin/tab-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
      body: JSON.stringify(pendingTabSettings)
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    window.TAB_SETTINGS = JSON.parse(JSON.stringify(pendingTabSettings));
    await applyTabSettings();
    btn.textContent = '✅ Saved!';
    setTimeout(() => { btn.disabled = false; btn.textContent = '💾 Save Access Settings'; }, 2000);
  } catch(e) { btn.textContent = '⚠️ ' + e.message; btn.disabled = false; }
}

function resetTabSettings() {
  if (!confirm('Reset all tab settings to defaults (everything enabled)?')) return;
  pendingTabSettings = getDefaultTabSettings();
  renderTabControls();
}

function updateAccessControlBadge() {
  const badge = document.getElementById('accessControlBadge');
  if (!badge) return;
  const s = window.TAB_SETTINGS;
  if (!s || !adminKey) { badge.style.display = 'none'; return; }
  const anyDisabled = SUBJS.some(subj =>
    ['learn','quiz','mockbar','speeddrill'].some(m => s.subjects?.[subj.key]?.[m] === false)
  ) || ['learn','quiz','mockbar','speeddrill'].some(m => s.subjects?.custom?.[m] === false) || s.spaced_repetition === false;
  badge.style.display = anyDisabled ? '' : 'none';
}

function scrollToTabControl() {
  navToAdmin();
  setTimeout(() => {
    const el = document.getElementById('tabAccessControlPanel');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 150);
}

// SUBJECT OVERVIEW GRID (admin)
// ══════════════════════════════════
function renderSubjectOverview() {
  const container = document.getElementById('subjOvGridContent');
  if (!container) return;
  const allSubjs = [...SUBJS, CUSTOM_SUBJ];
  container.innerHTML = allSubjs.map(s => {
    const isCustom = s.key === 'custom';
    const refs   = isCustom ? (KB.customRefs   || 0) : (KB.references?.filter(r=>r.subject===s.key).length || 0);
    const pbSets = isCustom ? (KB.customPastBar || 0) : (KB.pastBar?.filter(p=>p.subject===s.key).length || 0);
    const qs     = isCustom ? (KB.customQuestions || 0)
                            : (KB.pastBar?.filter(p=>p.subject===s.key).reduce((a,p)=>a+(p.qCount||0),0) || 0);
    const topics = isCustom ? 0 : (KB.syllabusTopics?.find(t=>t.key===s.key)?.topics?.length || 0);
    return `<div class="subj-ov-card">
      <div class="subj-ov-name">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${s.color};margin-right:6px;flex-shrink:0;"></span>
        ${s.name}
      </div>
      <div class="subj-ov-stats">
        <span title="References">📄 ${refs} refs</span>
        <span title="Past Bar Sets">🗂 ${pbSets} sets</span>
        <span title="Past Bar Questions">❓ ${qs} Qs</span>
        ${!isCustom ? `<span title="Topics">📋 ${topics} topics</span>` : ''}
      </div>
      <div class="subj-ov-btns">
        <button class="subj-ov-btn" onclick="quickAddRef('${s.key}')">+ Reference</button>
        <button class="subj-ov-btn" onclick="quickAddPastBar('${s.key}')">+ Past Bar</button>
      </div>
    </div>`;
  }).join('');
}

function quickAddRef(subjKey) {
  // Scroll to reference upload panel and pre-select subject
  navToAdmin();
  setTimeout(() => {
    const el = document.getElementById('ref-subject');
    if (el) { el.value = subjKey; el.dispatchEvent(new Event('change')); }
    const panel = document.querySelector('.admin-card');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 150);
}

function quickAddPastBar(subjKey) {
  // Scroll to past bar upload panel and pre-select subject
  navToAdmin();
  setTimeout(() => {
    const el = document.getElementById('pb-subject');
    if (el) { el.value = subjKey; el.dispatchEvent(new Event('change')); }
    const panels = document.querySelectorAll('.admin-card');
    if (panels[1]) panels[1].scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 150);
}

// Sends both session token and legacy admin key for backward compat
function adminFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
      'x-session-token': sessionToken || '',
      'x-admin-key': window._adminKey || '',
    }
  });
}

function updateSidebarAdminVisibility() {
  const sbAdmin = document.getElementById('sb-admin');
  if (!sbAdmin) return;
  // Show admin button if user has isAdmin flag OR legacy key is set
  sbAdmin.style.display = (currentUser?.isAdmin || window._adminKey) ? '' : 'none';
}

async function unlockAdmin(){
  adminKey=document.getElementById('adminKeyInput').value.trim();
  if(!adminKey)return;
  window._adminKey=adminKey;
  localStorage.setItem('bb_admin_key', adminKey);
  document.getElementById('adminStatus').textContent='Checking…';
  try{
    // loadKB() both validates connectivity and refreshes the in-memory KB state
    await loadKB();
    document.getElementById('adminLocked').style.display='none';
    document.getElementById('adminUnlocked').style.display='block';
    document.getElementById('adminStatus').textContent='✓ Unlocked';
    refreshAdminKB();
    updateSidebarAdminVisibility();
    // Update registration toggle label
    fetch('/api/settings').then(r=>r.json()).then(s=>{
      const btn=document.getElementById('regToggleBtn');
      if(btn)btn.textContent=s.registrationOpen?'Close Registration':'Open Registration';
    }).catch(()=>{});
    showAdminTab('overview');
  }catch(e){document.getElementById('adminStatus').textContent='Error: '+e.message;}
}

async function readFile(input,targetId){
  const f=input.files[0];if(!f)return;
  const ext=f.name.split('.').pop().toLowerCase();
  if(ext==='pdf'||ext==='doc'||ext==='docx'){
    const fd=new FormData();fd.append('file',f);
    const statusId=targetId.replace('-content','-status');
    const sta=document.getElementById(statusId);
    if(sta)sta.innerHTML=`<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--gold-l);padding:8px;"><div class="spin" style="width:14px;height:14px;border-width:2px;"></div>Extracting text from ${ext.toUpperCase()}…</div>`;
    try{
      const r=await fetch('/api/admin/parse-file',{method:'POST',headers:{'x-admin-key':adminKey},body:fd});
      const d=await r.json();
      if(d.error)throw new Error(d.error);
      document.getElementById(targetId).value=d.text;
      if(sta)sta.innerHTML=`<div style="color:var(--teal);font-size:12px;padding:4px 8px;">✓ Extracted ${d.text.length.toLocaleString()} characters from ${h(f.name)}</div>`;
    }catch(e){
      if(sta)sta.innerHTML=`<div style="color:var(--danger);font-size:13px;padding:8px;">⚠️ ${h(e.message)}</div>`;
    }
  }else{
    const r=new FileReader();r.onload=e=>document.getElementById(targetId).value=e.target.result;r.readAsText(f);
  }
}
function countLeafTopics(topics) {
  let n = 0;
  function walk(items) {
    (items || []).forEach(t => {
      if (t.type === 'topic' || (!t.type && !t.isGroup)) n++;
      walk(t.children || []);
      if (!t.type) walk(t.subtopics || []); // legacy compat
    });
  }
  walk(topics); return n;
}
function updateSyllabusStatus(){
  // Legacy function — syllabus status is now shown inline in the builder panel
}

async function adminPost(url,body,status){
  const sta=document.getElementById(status);
  sta.innerHTML=`<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--gold-l);padding:10px;"><div class="spin" style="width:16px;height:16px;border-width:2px;"></div>Processing…</div>`;
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':adminKey},body:JSON.stringify(body)});
  return r.json();
}

async function uploadSyllabus(){
  const name=document.getElementById('syl-name').value.trim();
  const content=document.getElementById('syl-content').value.trim();
  const subject=document.getElementById('syllabusSubject')?.value||'';
  if(!content){alert('Paste or upload syllabus content.');return;}
  try{
    const r=await adminPost('/api/admin/syllabus',{name,content,subject},'syl-status');
    if(r.error){
      const staEl=document.getElementById('syl-status');
      let msg=h(r.error);
      if(r.raw){msg+=`<br><br><span style="color:rgba(var(--txt2-rgb),.4);font-size:11px;">Claude returned: &ldquo;${h(r.raw)}&hellip;&rdquo;</span><br><span style="color:rgba(var(--txt2-rgb),.4);font-size:11px;">Tip: Try uploading again. If this keeps happening, try breaking the syllabus into smaller sections by subject.</span>`;}
      staEl.innerHTML=`<div style="color:var(--danger);font-size:13px;line-height:1.7;padding:12px;background:rgba(155,35,53,.1);border:1px solid rgba(155,35,53,.3);border-radius:10px;">⚠️ ${msg}</div>`;
      return;
    }
    // Reset dropdown for next upload
    const subjEl=document.getElementById('syllabusSubject');
    if(subjEl) subjEl.value='';

    const bdEl=document.getElementById('syl-breakdown');
    if(r.parseMethod==='subject-override'){
      // Single-subject confirmation card
      document.getElementById('syl-status').innerHTML=`<div style="background:rgba(20,180,160,.1);border:1px solid rgba(20,180,160,.3);border-radius:12px;padding:16px;"><div style="font-family:var(--fd);font-size:16px;font-weight:700;color:var(--teal-d);margin-bottom:8px;">✅ ${h(r.breakdown[0].name)} syllabus saved</div><div style="font-size:13px;color:rgba(var(--txt2-rgb),.7);">${r.totalTopics} topics loaded · Pre-generation queued</div></div>`;
      if(bdEl) bdEl.style.display='none';
    } else {
      // Multi-subject success
      const _methodBadge={'regex':'⚡ Fast (outline detected)','ai':'🤖 AI parsed','fallback-split':'⚠️ Basic split (verify results)'};
      const _methodLabel=_methodBadge[r.parseMethod]?` &nbsp;·&nbsp; <span style="font-size:11px;opacity:.65;">${_methodBadge[r.parseMethod]}</span>`:'';
      document.getElementById('syl-status').innerHTML=`<div style="color:var(--teal);font-size:13px;padding:8px;">✅ Saved! ${r.subjects} subjects, ${r.totalTopics} topics. Pre-generating content now…${_methodLabel}</div>`;
      if(bdEl && r.breakdown?.length){
        const clr={civil:'#4a9eff',criminal:'var(--danger)',political:'#50d090',labor:'#f0a040',commercial:'#a070e0',taxation:'#40c0b0',remedial:'#e0c050',ethics:'#c0a080',custom:'#8899aa'};
        const rows=r.breakdown.map(s=>`<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${clr[s.key]||'#888'};flex-shrink:0;"></span><span style="flex:1;color:rgba(var(--txt2-rgb),.8);">${h(s.name)}</span><span style="color:var(--muted);font-family:var(--fm);">${s.topicCount} topics</span></div>`).join('');
        const unknownHtml=r.unknownTopics?.length?`<div style="margin-top:8px;padding:8px;background:rgba(155,35,53,.1);border-radius:6px;font-size:11px;color:var(--danger);">⚠️ ${r.unknownTopics.length} unrecognized subject(s) skipped: ${r.unknownTopics.map(h).join(', ')}</div>`:'';
        let warningsHtml='';
        if(r.warnings?.length){
          const items=r.warnings.map(w=>`<div class="sw-item">⚠ <strong>${h(w.topic)}</strong> is under <em>${h(w.assignedTo)}</em> but keywords suggest <em>${h(w.possiblyBelongsTo)}</em> (matched: ${w.matchedKeywords.map(h).join(', ')})</div>`).join('');
          warningsHtml=`<div class="syllabus-warnings" style="margin-top:10px;"><div class="sw-header" onclick="this.nextElementSibling.classList.toggle('open')">⚠️ ${r.warningCount} topic assignment warning${r.warningCount>1?'s':''} — click to review<span style="margin-left:auto;font-size:10px;opacity:.6;">Topics kept as-is. Review if needed.</span></div><div class="sw-body">${items}</div></div>`;
        }
        bdEl.innerHTML=`<div style="background:rgba(var(--ovl),.03);border:1px solid rgba(var(--ovl),.07);border-radius:10px;padding:12px 14px;"><div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px;">Subjects Parsed</div>${rows}${unknownHtml}</div>${warningsHtml}`;
        bdEl.style.display='';
      }
    }
    document.getElementById('adminGenPanel').style.display='block';
    document.getElementById('adminGenDone').style.display='none';
    await loadKB();updateSyllabusStatus();renderSyllabusTree();refreshSidebarDots();
  }catch(e){document.getElementById('syl-status').innerHTML=`<div style="color:var(--danger);font-size:13px;padding:8px;">⚠️ ${h(e.message)}</div>`;}
}
function showRefGeneralWarning(val) {
  const el = document.getElementById('refGeneralWarning');
  if (el) el.style.display = val === 'general' ? '' : 'none';
}
function showPbGeneralWarning(val) {
  const el = document.getElementById('pbGeneralWarning');
  if (el) el.style.display = val === 'general' ? '' : 'none';
}

async function uploadReference(){
  const name=document.getElementById('ref-name').value.trim(),content=document.getElementById('ref-content').value.trim();
  const subject=document.getElementById('ref-subject').value,type=document.getElementById('ref-type').value;
  if(!name||!content){alert('Enter name and content.');return;}
  const sta=document.getElementById('ref-status');
  const spin=`<div class="spin" style="width:14px;height:14px;border-width:2px;flex-shrink:0;"></div>`;
  try{
    const r=await adminPost('/api/admin/reference',{name,subject,type,content},'ref-status');
    if(r.error)throw new Error(r.error);
    document.getElementById('ref-name').value='';document.getElementById('ref-content').value='';
    await loadKB();refreshAdminKB();
    sta.innerHTML=`<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--gold-l);padding:10px;">${spin}⏳ Saved "${h(r.name)}" — summarising in background…</div>`;
    pollJob(r.jobId,sta,(err)=>{
      if(err){
        sta.innerHTML=`<div style="color:var(--warn);font-size:13px;padding:8px;">⚠️ Saved "${h(r.name)}" but summarisation failed: ${h(err)}</div>`;
      }else{
        sta.innerHTML=`<div style="color:var(--teal);font-size:13px;padding:8px;">✅ "${h(r.name)}" saved and summarised. Re-generating ${h(subject)} content…</div>`;
      }
    });
  }catch(e){sta.innerHTML=`<div style="color:var(--danger);font-size:13px;padding:8px;">⚠️ ${h(e.message)}</div>`;}
}
async function uploadPastBar(){
  const name=document.getElementById('pb-name').value.trim();
  const content=document.getElementById('pb-content').value.trim();
  const subject=document.getElementById('pb-subject').value;
  const year=document.getElementById('pb-year').value.trim();
  const sta=document.getElementById('pb-status');
  if(!name||!content){
    sta.innerHTML=`<div style="color:var(--danger);font-size:13px;padding:8px;">⚠️ Enter a name and paste or upload content first.</div>`;
    return;
  }
  const spin=`<div class="spin" style="width:14px;height:14px;border-width:2px;flex-shrink:0;"></div>`;
  sta.innerHTML=`<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--gold-l);padding:10px;">${spin}Saving…</div>`;
  try{
    const r=await fetch('/api/admin/pastbar',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':adminKey},body:JSON.stringify({name,content,subject,year})});
    const d=await r.json();
    if(d.error)throw new Error(d.error);
    document.getElementById('pb-name').value='';
    document.getElementById('pb-content').value='';
    await loadKB();refreshAdminKB();renderPastBarList();
    sta.innerHTML=`<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--gold-l);padding:10px;">${spin}⏳ Saved "${h(d.name)}" — extracting questions…</div>`;
    pollJob(d.jobId,sta,(err,result)=>{
      if(err){
        sta.innerHTML=`<div style="color:var(--warn);font-size:13px;padding:8px;">⚠️ Saved "${h(d.name)}" but extraction failed: ${h(err)}</div>`;
      }else if(!result?.questionsExtracted){
        sta.innerHTML=`<div style="color:var(--warn);font-size:13px;padding:8px;">⚠️ Saved "${h(d.name)}" but 0 questions were extracted. Try pasting as plain text.</div>`;
      }else{
        sta.innerHTML=`<div style="color:var(--teal);font-size:13px;padding:8px;">✅ "${h(d.name)}" — ${result.questionsExtracted} questions extracted.</div>`;
      }
      loadKB();refreshAdminKB();renderPastBarList();refreshSidebarDots();
    });
  }catch(e){sta.innerHTML=`<div style="color:var(--danger);font-size:13px;padding:8px;">⚠️ ${h(e.message)}</div>`;}
}
// Generic job poller — polls /api/job/:jobId every 8s
// onDone(errorMsg|null, result|null)
function pollJob(jobId,sta,onDone){
  const spin=`<div class="spin" style="width:14px;height:14px;border-width:2px;flex-shrink:0;"></div>`;
  let attempts=0;
  const iv=setInterval(async()=>{
    attempts++;
    try{
      const r=await fetch(`/api/job/${jobId}`,{headers:{'x-admin-key':adminKey}});
      const d=await r.json();
      if(d.status==='done'){
        clearInterval(iv);onDone(null,d.result);
      }else if(d.status==='failed'){
        clearInterval(iv);onDone(d.error,null);
      }else if(attempts>=38){ // ~5 min max
        clearInterval(iv);
        sta.innerHTML=`<div style="color:var(--muted);font-size:13px;padding:8px;">⏳ Still processing on server. Check back later.</div>`;
      }else{
        const elapsed=attempts*8;
        sta.innerHTML=`<div style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--gold-l);padding:10px;">${spin}Processing… (${elapsed<60?elapsed+'s':Math.floor(elapsed/60)+'m '+elapsed%60+'s'} elapsed)</div>`;
      }
    }catch(e){if(attempts>=38)clearInterval(iv);}
  },8000);
}
function toggleDownloadPicker(id){
  document.querySelectorAll('.dl-picker').forEach(el=>{if(el.id!==`dl-picker-${id}`)el.style.display='none';});
  const p=document.getElementById(`dl-picker-${id}`);
  if(p) p.style.display=p.style.display==='flex'?'none':'flex';
}
async function downloadKBItem(id,format){
  const r=await fetch(`/api/admin/pastbar/${id}/download?format=${format}`,{headers:{'x-admin-key':adminKey}});
  if(!r.ok){alert('Download failed: '+(await r.text()));return;}
  if(format==='pdf'){
    // Open HTML page in new tab — it auto-prints
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    window.open(url,'_blank');
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    return;
  }
  const blob=await r.blob();
  const objUrl=URL.createObjectURL(blob);
  const cd=r.headers.get('content-disposition')||'';
  const fname=cd.match(/filename="?([^"]+)"?/)?.[1]||`questions-${id}.${format}`;
  const a=document.createElement('a');a.href=objUrl;a.download=fname;a.click();
  URL.revokeObjectURL(objUrl);
}
async function downloadAllQuestions(){
  const r=await fetch('/api/admin/pastbar/download-all?format=txt',{headers:{'x-admin-key':adminKey}});
  if(!r.ok){alert('Download failed: '+(await r.text()));return;}
  const blob=await r.blob();
  const objUrl=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=objUrl;a.download='barbuddy-all-questions.txt';a.click();
  URL.revokeObjectURL(objUrl);
}
async function refreshAdminKB(){
  // Always fetch fresh data from the server before rendering
  await loadKB();
  loadStorageInfo();
  const el=document.getElementById('adminKbList');if(!el)return;
  const items=[
    ...(KB.hasSyllabus?[{name:KB.syllabusName||'Syllabus',subject:'all',type:'syllabus',id:'_syl'}]:[]),
    ...(KB.references||[]).map(r=>({...r,_cat:'ref'})),
    ...(KB.pastBar||[]).map(p=>({...p,_cat:'pb'})),
  ];
  if(!items.length){el.innerHTML=`<div style="font-size:12px;color:var(--muted);">No questions uploaded yet.</div>`;return;}
  el.innerHTML=items.map(i=>{
    const isPB=i._cat==='pb';
    const isManual=isPB&&i.source==='manual';
    const subLabel=[i.subject||'',i.year?'· '+i.year:'',i.qCount!=null?'· '+i.qCount+' Qs':i.type?'· '+i.type:'',isManual?'· <em style="color:var(--teal);">Manual Entry</em>':''].filter(Boolean).join(' ');
    const item=`<div class="kb-list-item" style="${isPB?'border-radius:9px 9px 0 0;margin-bottom:0;':''}">
      <div style="font-size:15px;">${i.type==='syllabus'?'📋':isPB?'📜':'📂'}</div>
      <div style="flex:1;min-width:0;"><div class="kl-name">${h(i.name)}</div><div class="kl-sub">${subLabel}</div></div>
      ${isPB?`<button class="kl-dl" onclick="toggleDownloadPicker('${i.id}')">⬇ Download</button>`:''}
      ${i.id!=='_syl'?`<button class="kl-del" onclick="deleteItem('${i.id}',this)">✕</button>`:`<button class="kl-del" onclick="deleteSyllabus(this)">✕</button>`}
    </div>`;
    const picker=isPB?`<div class="dl-picker" id="dl-picker-${i.id}">
      <span style="font-size:11px;color:var(--muted);">Download as:</span>
      <button class="kl-dl" onclick="downloadKBItem('${i.id}','pdf')">📄 PDF</button>
      <button class="kl-dl" onclick="downloadKBItem('${i.id}','json')">📋 JSON</button>
      <button class="kl-dl" onclick="downloadKBItem('${i.id}','txt')">📝 TXT</button>
    </div>`:'';
    return item+picker;
  }).join('');
}
async function loadStorageInfo(){
  if(!adminKey)return;
  const el=document.getElementById('storageIndicator');if(!el)return;
  try{
    const r=await fetch('/api/storage-info',{headers:{'x-admin-key':adminKey}});
    if(!r.ok){el.innerHTML='<span style="color:var(--muted);">Storage info unavailable.</span>';return;}
    const d=await r.json();
    const kb=d.files['kb.json'],ct=d.files['content.json'];
    const fmt=b=>b>=1024*1024?(b/1024/1024).toFixed(1)+'MB':b>=1024?(b/1024).toFixed(1)+'KB':b+'B';
    const persistColor=d.persistent?'var(--teal-d)':'#e09050';
    const persistLabel=d.persistent?'✅ Persistent (Railway Volume)':'⚠️ Ephemeral — data lost on redeploy';
    el.innerHTML=`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="color:${persistColor};font-weight:600;">${persistLabel}</span>
    </div>
    <div style="color:rgba(var(--txt2-rgb),.6);line-height:1.7;">
      📄 kb.json: ${kb.exists?fmt(kb.bytes):'not found'} &nbsp;|&nbsp;
      📄 content.json: ${ct.exists?fmt(ct.bytes):'not found'}<br>
      📁 Path: <code style="font-size:11px;background:rgba(var(--ovl),.06);padding:1px 5px;border-radius:4px;">${h(d.storageDir)}</code>
    </div>
    ${!d.persistent?`<div style="margin-top:8px;padding:8px 10px;background:rgba(224,144,80,.08);border:1px solid rgba(224,144,80,.25);border-radius:8px;color:#e09050;line-height:1.6;">
      <strong>To enable persistent storage on Railway:</strong><br>
      1. Add a Volume to your Railway service (Storage → Add Volume)<br>
      2. Set mount path (e.g. <code style="font-size:11px;">/data</code>)<br>
      3. Add env var: <code style="font-size:11px;">PERSISTENT_STORAGE_PATH=/data</code><br>
      4. Redeploy — your KB will survive future redeploys.
    </div>`:''}`;
  }catch(e){el.innerHTML=`<span style="color:var(--muted);">Storage info unavailable.</span>`;}
}
async function runKBDiagnostic(){
  const out=document.getElementById('kbDiagOutput');
  if(!out)return;
  out.style.display='block';out.textContent='Running diagnostic…';
  try{
    const r=await fetch('/api/admin/debug/kb',{headers:{'x-admin-key':adminKey}});
    const d=await r.json();
    if(d.error){out.textContent='Error: '+d.error;return;}
    const lines=[
      `KB Path: ${d.kbPath}`,
      `File exists: ${d.fileExists} (${d.fileSizeBytes} bytes)`,
      `Top-level keys: ${(d.topLevelKeys||[]).join(', ')||'(none)'}`,
      `Past bar items (file): ${d.pastBarCount}`,
      `Past bar items (memory): ${d.inMemoryKB?.pastBarCount}`,
      `Memory matches file: ${d.memoryMatchesFile}`,
      `References: ${d.referenceCount}`,
      `Syllabus subjects: ${(d.syllabusSubjects||[]).join(', ')||'(none)'}`,
      '',
      '── Past Bar Items ──',
      ...(d.pastBarItems||[]).map(pb=>`  [${pb.source||'upload'}] ${pb.name} (${pb.subject}, ${pb.questionCount}q) — id:${pb.id}`),
      d.pastBarItems?.length===0?'  (none)':'',
      '',
      '── Alternate Paths ──',
      ...(d.alternatePaths||[]).map(p=>`  ${p.exists?'✓':'✗'} ${p.path}${p.exists?' → '+p.pastBarCount+' items':''}`),
    ];
    out.textContent=lines.join('\n');
  }catch(e){out.textContent='Fetch error: '+e.message;}
}

async function deleteItem(id,btn){
  if(!confirm('Delete this material?'))return;btn.disabled=true;
  await fetch('/api/admin/reference/'+id,{method:'DELETE',headers:{'x-admin-key':adminKey}});
  await loadKB();refreshAdminKB();renderPastBarList();
}
async function deleteSyllabus(btn){
  if(!confirm('Delete syllabus? All generated content will also be cleared.'))return;btn.disabled=true;
  await fetch('/api/admin/syllabus',{method:'DELETE',headers:{'x-admin-key':adminKey}});
  CACHE={};saveLocalCache();
  await loadKB();refreshAdminKB();renderSyllabusTree();updateSyllabusStatus();
}
// ── ALAC Cache Backfill ───────────────────────────────────────
let _backfillPollInterval = null;
async function startAlacBackfill() {
  const btn = document.getElementById('backfillAlacBtn');
  const status = document.getElementById('backfillAlacStatus');
  const progressWrap = document.getElementById('backfillAlacProgress');
  const bar = document.getElementById('backfillAlacBar');
  const label = document.getElementById('backfillAlacLabel');
  const tok = sessionToken || '';

  btn.disabled = true;
  status.textContent = 'Starting…';

  try {
    const r = await fetch('/api/admin/backfill-alac-cache', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-token': tok } });
    const d = await r.json();
    if (d.error) { status.textContent = '❌ ' + d.error; btn.disabled = false; return; }
    if (!d.started) { status.textContent = d.message || 'Nothing to cache.'; btn.disabled = false; return; }

    progressWrap.style.display = 'block';
    status.textContent = '';

    // Poll for progress
    clearInterval(_backfillPollInterval);
    _backfillPollInterval = setInterval(async () => {
      try {
        const pr = await fetch('/api/admin/backfill-alac-cache/status', { headers: { 'x-session-token': tok } });
        const ps = await pr.json();
        const pct = ps.total > 0 ? Math.round((ps.done / ps.total) * 100) : 0;
        bar.style.width = pct + '%';
        if (ps.complete) {
          label.textContent = `✅ All ${ps.done} questions cached${ps.errors ? ` (${ps.errors} errors)` : ''}.`;
          status.textContent = '';
          clearInterval(_backfillPollInterval);
          btn.disabled = false;
          btn.textContent = '⚡ Re-run Backfill';
        } else {
          label.textContent = `Caching ${ps.done} / ${ps.total} questions…`;
        }
      } catch(e) { /* ignore poll errors */ }
    }, 1500);
  } catch(e) {
    status.textContent = '❌ ' + e.message;
    btn.disabled = false;
  }
}

let _conceptualBackfillPollInterval = null;
async function startConceptualBackfill() {
  const btn = document.getElementById('backfillConceptualBtn');
  const status = document.getElementById('backfillConceptualStatus');
  const progressWrap = document.getElementById('backfillConceptualProgress');
  const bar = document.getElementById('backfillConceptualBar');
  const label = document.getElementById('backfillConceptualLabel');
  const tok = sessionToken || '';

  btn.disabled = true;
  status.textContent = 'Starting…';

  try {
    const r = await fetch('/api/admin/backfill-conceptual-cache', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-token': tok } });
    const d = await r.json();
    if (d.error) { status.textContent = '❌ ' + d.error; btn.disabled = false; return; }
    if (!d.started) { status.textContent = d.message || 'Nothing to cache.'; btn.disabled = false; return; }

    progressWrap.style.display = 'block';
    status.textContent = '';

    clearInterval(_conceptualBackfillPollInterval);
    _conceptualBackfillPollInterval = setInterval(async () => {
      try {
        const pr = await fetch('/api/admin/backfill-conceptual-cache/status', { headers: { 'x-session-token': tok } });
        const ps = await pr.json();
        const pct = ps.total > 0 ? Math.round((ps.done / ps.total) * 100) : 0;
        bar.style.width = pct + '%';
        if (ps.complete) {
          label.textContent = `✅ All ${ps.done} conceptual questions cached${ps.errors ? ` (${ps.errors} errors)` : ''}.`;
          status.textContent = '';
          clearInterval(_conceptualBackfillPollInterval);
          btn.disabled = false;
          btn.textContent = '⚡ Re-run Backfill';
        } else {
          label.textContent = `Caching ${ps.done} / ${ps.total} conceptual questions…`;
        }
      } catch(e) { /* ignore poll errors */ }
    }, 1500);
  } catch(e) {
    status.textContent = '❌ ' + e.message;
    btn.disabled = false;
  }
}

let _altAlacBackfillPollInterval = null;
async function startAltAlacBackfill() {
  const btn = document.getElementById('backfillAltAlacBtn');
  const status = document.getElementById('backfillAltAlacStatus');
  const progressWrap = document.getElementById('backfillAltAlacProgress');
  const bar = document.getElementById('backfillAltAlacBar');
  const label = document.getElementById('backfillAltAlacLabel');
  const tok = sessionToken || '';

  btn.disabled = true;
  status.textContent = 'Starting…';

  try {
    const r = await fetch('/api/admin/backfill-alternative-alac', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-token': tok } });
    const d = await r.json();
    if (d.error) { status.textContent = '❌ ' + d.error; btn.disabled = false; return; }
    if (!d.started) { status.textContent = d.message || 'Nothing to cache.'; btn.disabled = false; return; }

    progressWrap.style.display = 'block';
    status.textContent = '';

    clearInterval(_altAlacBackfillPollInterval);
    _altAlacBackfillPollInterval = setInterval(async () => {
      try {
        const pr = await fetch('/api/admin/backfill-alternative-alac/status', { headers: { 'x-session-token': tok } });
        const ps = await pr.json();
        const pct = ps.total > 0 ? Math.round((ps.done / ps.total) * 100) : 0;
        bar.style.width = pct + '%';
        if (ps.complete) {
          label.textContent = `✅ All ${ps.total} alternative ALAC pairs generated${ps.errors ? ` (${ps.errors} errors)` : ''}.`;
          status.textContent = '';
          clearInterval(_altAlacBackfillPollInterval);
          btn.disabled = false;
          btn.textContent = '⚡ Re-run Backfill';
        } else {
          label.textContent = `Generating alternative ALAC… ${ps.done} / ${ps.total} pairs complete`;
        }
      } catch(e) { /* ignore poll errors */ }
    }, 1500);
  } catch(e) {
    status.textContent = '❌ ' + e.message;
    btn.disabled = false;
  }
}

// ── Retry Failed Evaluations ──────────────────────────────────
let _retryEvalsPollInterval = null;
async function previewFailedEvals() {
  const tok = sessionToken || '';
  const days = Math.max(1, Math.min(365, parseInt(document.getElementById('retryEvalsDaysInput').value) || 90));
  const status = document.getElementById('retryEvalsStatus');
  const box = document.getElementById('retryEvalsPreviewBox');
  status.textContent = 'Scanning…';
  box.style.display = 'none';
  try {
    const r = await fetch(`/api/admin/failed-evaluations/preview?daysBack=${days}`, { headers: { 'x-session-token': tok } });
    const d = await r.json();
    if (d.error) { status.textContent = '❌ ' + d.error; return; }
    status.textContent = '';
    box.style.display = 'block';
    box.innerHTML = `
      <div><strong>Scanned:</strong> ${d.scanned} results in last ${d.daysBack} days</div>
      <div><strong>With failed evaluations:</strong> ${d.resultsWithFailures}</div>
      <div><strong>Retryable</strong> (have stored answers): <span style="color:#7dd3a3">${d.retryable}</span></div>
      <div><strong>Not retryable</strong> (pre-fix, no stored answers): <span style="color:#ff9b6b">${d.notRetryable}</span></div>
      ${d.sample?.length ? `<div style="margin-top:8px;color:var(--muted);">First ${d.sample.length} candidates:</div>
      <ul style="margin:4px 0 0 18px;padding:0;font-size:11px;line-height:1.6;">
        ${d.sample.map(c => `<li>${c.id.slice(0,16)}… · ${c.subject||'—'} · ${c.failedCount} failed · ${c.hasRetryData ? '✓ retryable' : '✗ no data'}</li>`).join('')}
      </ul>` : ''}
    `;
  } catch(e) {
    status.textContent = '❌ ' + e.message;
  }
}

async function startRetryFailedEvals() {
  const tok = sessionToken || '';
  const days = Math.max(1, Math.min(365, parseInt(document.getElementById('retryEvalsDaysInput').value) || 90));
  if (!confirm(`Retry all failed evaluations from the last ${days} days?\n\nThis will re-run any question scored "Evaluation temporarily unavailable" through the eval queue and update the affected result records. Pre-fix results with no stored answers will be skipped.`)) return;
  const btn = document.getElementById('retryEvalsBtn');
  const status = document.getElementById('retryEvalsStatus');
  const progressWrap = document.getElementById('retryEvalsProgress');
  const bar = document.getElementById('retryEvalsBar');
  const label = document.getElementById('retryEvalsLabel');
  btn.disabled = true;
  status.textContent = 'Starting…';
  try {
    const r = await fetch('/api/admin/retry-failed-evaluations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-token': tok },
      body: JSON.stringify({ daysBack: days }),
    });
    const d = await r.json();
    if (d.error) { status.textContent = '❌ ' + d.error; btn.disabled = false; return; }
    if (!d.started) { status.textContent = d.message || 'Already running.'; btn.disabled = false; return; }
    if (d.totalResults === 0) { status.textContent = '✅ No failed evaluations found.'; btn.disabled = false; return; }
    progressWrap.style.display = 'block';
    status.textContent = '';
    clearInterval(_retryEvalsPollInterval);
    _retryEvalsPollInterval = setInterval(async () => {
      try {
        const pr = await fetch('/api/admin/retry-failed-evaluations/status', { headers: { 'x-session-token': tok } });
        const ps = await pr.json();
        const pct = ps.totalResults > 0 ? Math.round((ps.scannedResults / ps.totalResults) * 100) : 0;
        bar.style.width = pct + '%';
        if (ps.complete) {
          label.innerHTML = `✅ Complete. <strong>${ps.succeeded}</strong> questions recovered, <strong>${ps.stillFailing}</strong> still failing, <strong>${ps.noDataForRetry}</strong> had no stored answers. <strong>${ps.updatedResults}</strong> result records updated${ps.errors?.length ? ` (${ps.errors.length} errors)` : ''}.`;
          status.textContent = '';
          clearInterval(_retryEvalsPollInterval);
          btn.disabled = false;
          btn.textContent = '🔁 Re-run Retry';
        } else {
          label.textContent = `Processing ${ps.scannedResults} / ${ps.totalResults} results · ${ps.succeeded} recovered, ${ps.stillFailing} still failing`;
        }
      } catch(e) { /* ignore poll errors */ }
    }, 2000);
  } catch(e) {
    status.textContent = '❌ ' + e.message;
    btn.disabled = false;
  }
}

async function retriggerGen(){
  if(!confirm('Regenerate all content? This replaces all existing lessons and quizzes.'))return;
  // Clear local cache
  CACHE={};saveLocalCache();buildQuizPool();renderSyllabusTree();
  await fetch('/api/admin/content',{method:'DELETE',headers:{'x-admin-key':adminKey}});
  const r=await fetch('/api/admin/generate',{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':adminKey},body:JSON.stringify({})});
  const d=await r.json();
  document.getElementById('adminGenPanel').style.display='block';
  document.getElementById('adminGenDone').style.display='none';
  alert(`Re-generation started! ${d.total||0} topics queued.`);
}
async function clearContent(){
  if(!confirm('Clear all browser-cached content? Server content is preserved.'))return;
  CACHE={};saveLocalCache();buildQuizPool();renderSyllabusTree();
  alert('Browser cache cleared. Click topics to reload from server.');
}


// ══════════════════════════════════
// UTILS
// ══════════════════════════════════
function h(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// ══════════════════════════════════
// AUTH STATE
// ══════════════════════════════════
let currentUser  = null;
let sessionToken = null;

function switchAuthTab(tab) {
  document.getElementById('authFormLogin').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('authFormRegister').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('authFormForgot').style.display   = 'none';
  const tabRow = document.getElementById('authTabRow');
  if (tabRow) tabRow.style.display = 'flex';
  document.querySelectorAll('.auth-tab-btn').forEach((b,i) => b.classList.toggle('active', (i===0&&tab==='login')||(i===1&&tab==='register')));
}

async function doLogin() {
  const email    = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl    = document.getElementById('loginErr');
  const btn      = document.getElementById('loginBtn');
  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Please fill in all fields.'; return; }
  btn.disabled = true; btn.textContent = 'Logging in…';
  try {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email, password }) });
    const d = await r.json();
    if (!r.ok) {
      if (d.error === 'pending_approval') {
        errEl.textContent = '⏳ Your account is pending admin approval. You will be notified by email once access is granted.';
      } else if (d.error === 'account_disabled') {
        errEl.textContent = '🚫 Your account has been disabled. Please contact the admin.';
      } else {
        errEl.textContent = d.error || 'Login failed.';
      }
      return;
    }
    startLoadingScreen();
    setLoadingMsg('Logging you in...');
    onAuthSuccess(d.token, d.user);
  } catch(e) { errEl.textContent = 'Network error. Try again.'; }
  finally { btn.disabled = false; btn.textContent = 'Log In'; }
}

async function doRegister() {
  const firstName = document.getElementById('regFirstName')?.value.trim();
  const lastName  = document.getElementById('regLastName')?.value.trim();
  const name      = firstName && lastName ? `${firstName} ${lastName}` : firstName || lastName || '';
  const school   = document.getElementById('regSchool').value.trim();
  const email    = document.getElementById('regEmail').value.trim();
  const password = document.getElementById('regPassword').value;
  const errEl    = document.getElementById('regErr');
  const btn      = document.getElementById('regBtn');
  errEl.textContent = '';
  if (!firstName) { errEl.textContent = 'Please enter your first name.'; document.getElementById('regFirstName')?.focus(); return; }
  if (!lastName)  { errEl.textContent = 'Please enter your last name.';  document.getElementById('regLastName')?.focus();  return; }
  if (!email || !password) { errEl.textContent = 'Please fill in all fields.'; return; }
  if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }
  btn.disabled = true; btn.textContent = 'Creating account…';
  try {
    const r = await fetch('/api/auth/register', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name, email, password, school }) });
    const d = await r.json();
    if (!r.ok) { errEl.textContent = d.error || 'Registration failed.'; return; }
    if (d.token) { onAuthSuccess(d.token, d.user); return; }
    errEl.textContent = d.error || 'Registration failed.';
  } catch(e) { errEl.textContent = 'Network error. Try again.'; }
  finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = 'Create Account'; } }
}


async function onAuthSuccess(token, user) {
  sessionToken = token;
  currentUser  = user;
  localStorage.setItem('bb_token', token);
  localStorage.setItem('bb_user', JSON.stringify(user));
  if (user?.name) localStorage.setItem('bb_user_name', user.name);
  const aw = document.getElementById('authWall');
  aw.style.opacity = '0';
  setTimeout(() => { aw.style.display = 'none'; }, 260);
  updateUserDisplay();
  updateSidebarAdminVisibility();
  setLoadingMsg('Loading your dashboard...');
  // Start the SR due-reviews fetch BEFORE the Promise.allSettled below, so
  // it runs truly concurrently with the 5 boot-preamble fetches (including
  // the slow /api/kb, which can take 4+ seconds on cold load). If we started
  // it AFTER the allSettled, its ~400ms round-trip would stack serially on
  // top, producing the visible "SR card pops in later" effect on hard
  // refresh of the Progress page. Not awaited here — it populates the SR
  // cache (_srDueItems/_srStats) that the Progress page renders from, and
  // _renderProgressDashboardInto joins the in-flight promise if it's still
  // running when the user's last view was Progress.
  checkDueReviews().catch(() => {});
  loadFlashcardBundleOnBoot();
  // Prefetch KB and progress in parallel before rendering
  await Promise.allSettled([
    refreshKBState(),
    applyTabSettings(),
    syncProgressFromServer(),
    syncBookmarksFromServer(),
    fetch('/api/settings').then(r => r.json()).then(s => {
      if (s.barExamDate) window._barExamDate = s.barExamDate;
    }).catch(() => {}),
  ]);
  // Restore last view or land on overview
  try {
    const lastView = sessionStorage.getItem('bb_last_view');
    const lastSubj = sessionStorage.getItem('bb_last_subject');
    const lastTab  = sessionStorage.getItem('bb_last_tab');
    if (lastView === 'subject' && lastSubj) {
      navToSubject(lastSubj, lastTab || 'learn');
    } else if (lastView === 'admin') {
      navToAdmin();
    } else if (lastView === 'progress') {
      navToProgress(lastTab || 'progress');
    } else if (lastView === 'custom') {
      navToCustom();
    } else {
      navToOverview();
    }
  } catch(e) {
    navToOverview();
  }
  // Check for an interrupted exam session and show resume banner
  checkForInterruptedExam().catch(() => {});
  hideLoadingScreen();
}

function updateUserDisplay() {
  const disp    = document.getElementById('userNameDisplay');
  const logBtn  = document.getElementById('logoutBtn');
  const cpBtn   = document.getElementById('changePwdBtn');
  const sbXp    = document.getElementById('sbXpSection');
  if (currentUser) {
    disp.textContent     = currentUser.name;
    disp.style.display   = '';
    logBtn.style.display = '';
    if (cpBtn) cpBtn.style.display = '';
    // Populate sidebar XP section asynchronously
    if (sbXp && sessionToken) {
      sbXp.style.display = 'block';
      document.getElementById('sbXpName').textContent = currentUser.name;
      refreshSidebarXP();
    }
  } else {
    disp.style.display   = 'none';
    logBtn.style.display = 'none';
    if (cpBtn) cpBtn.style.display = 'none';
    if (sbXp) sbXp.style.display = 'none';
    closeNotifPanel();
  }
  refreshNotifications();
}

// force=true skips the cache — used after a session awards XP so the sidebar
// doesn't keep showing pre-session numbers.
async function refreshSidebarXP(force) {
  if (!sessionToken) return;
  try {
    const cached = _xpSummaryCache?.data;
    const fresh  = cached && !force && (Date.now() - _xpSummaryCache.at) < PROG_CACHE_TTL_MS;
    // Shares _xpSummaryCache with the XP & Level tab — boot used to fetch this
    // payload here and then again the moment the user opened that tab.
    const { xp, level, title, xpToNextLevel, progressPercent } = fresh ? cached : await _fetchXPSummary();
    const badge  = document.getElementById('sbLevelBadge');
    const lvlEl  = document.getElementById('sbXpLevel');
    const fill   = document.getElementById('sbXpFill');
    const nums   = document.getElementById('sbXpNums');
    if (badge)  badge.textContent  = `Lvl ${level}`;
    if (lvlEl)  lvlEl.textContent  = title;
    if (nums)   nums.textContent   = `${xp.toLocaleString()} XP`;
    if (fill)   setTimeout(() => { fill.style.width = progressPercent + '%'; }, 200);
    // Also update topbar display with level badge
    const disp = document.getElementById('userNameDisplay');
    if (disp && currentUser) {
      disp.innerHTML = `${h(currentUser.name)} <span class="sb-level-badge" style="margin-left:6px;">Lvl ${level}</span>`;
    }
  } catch(e) { /* non-critical */ }
}

async function doLogout() {
  if (sessionToken) {
    try { await fetch('/api/auth/logout', { method:'POST', headers:{'x-session-token': sessionToken} }); } catch(e) {}
  }
  sessionToken = null;
  currentUser  = null;
  adminKey = '';
  window._adminKey = '';
  localStorage.removeItem('bb_token');
  localStorage.removeItem('bb_user');
  localStorage.removeItem('bb_user_name');
  localStorage.removeItem('bb_admin_key');
  sessionStorage.clear();
  window.TAB_SETTINGS = null;
  // Flashcard caches are per-user (done flags, progress counts) — clear them
  // so the next login never sees the previous student's progress.
  _fcBundleCache = null;
  _fcDoneSet = new Set();
  _fcCardsCache.clear();
  _fcCardsInflight.clear();
  _fcSession = null;
  _fcEls = null;
  const aw = document.getElementById('authWall');
  aw.style.display = 'flex';
  requestAnimationFrame(() => { aw.style.opacity = '1'; });
  updateUserDisplay();
}

async function checkExistingSession() {
  const savedToken = localStorage.getItem('bb_token');
  if (!savedToken) return false;
  try {
    const r = await fetch('/api/auth/me', { headers:{'x-session-token': savedToken} });
    if (!r.ok) { localStorage.removeItem('bb_token'); localStorage.removeItem('bb_user'); return false; }
    const user = await r.json();
    sessionToken = savedToken;
    currentUser  = user;
    localStorage.setItem('bb_user', JSON.stringify(user));
    const aw = document.getElementById('authWall');
    aw.style.display = 'none';
    aw.style.opacity = '0';
    updateUserDisplay();
    updateSidebarAdminVisibility();
    return true;
  } catch(e) { return false; }
}

function showForgotPassword(show = true) {
  document.getElementById('authFormLogin').style.display    = show ? 'none' : '';
  document.getElementById('authFormRegister').style.display = 'none';
  document.getElementById('authFormForgot').style.display   = show ? '' : 'none';
  const tabRow = document.getElementById('authTabRow');
  if (tabRow) tabRow.style.display = show ? 'none' : 'flex';
  if (!show) switchAuthTab('login');
  document.getElementById('forgotError').style.display   = 'none';
  document.getElementById('forgotSuccess').style.display = 'none';
  document.getElementById('forgotEmail').value = '';
}

async function doForgotPassword() {
  const email     = document.getElementById('forgotEmail').value.trim();
  const errEl     = document.getElementById('forgotError');
  const btn       = document.getElementById('forgotBtn');
  const successEl = document.getElementById('forgotSuccess');
  errEl.style.display = 'none';
  if (!email) { errEl.textContent = 'Please enter your email address.'; errEl.style.display = 'block'; return; }
  btn.disabled = true; btn.textContent = '⏳ Submitting…';
  try {
    await fetch('/api/auth/forgot-password', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ email }) });
    successEl.style.display = 'block';
    btn.style.display = 'none';
  } catch(e) {
    errEl.textContent = '⚠️ Something went wrong. Try again.';
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = '📨 Submit Reset Request';
  }
}

function timeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)  return `${s} second${s===1?'':'s'} ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m} minute${m===1?'':'s'} ago`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr} hour${hr===1?'':'s'} ago`;
  const d = Math.floor(hr / 24);
  return `${d} day${d===1?'':'s'} ago`;
}

async function adminResetPassword(userId, requestId, inputId) {
  const newPassword = document.getElementById(inputId)?.value.trim();
  if (!newPassword || newPassword.length < 6) { alert('Password must be at least 6 characters.'); return; }
  const r = await fetch('/api/admin/reset-password', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-admin-key': window._adminKey || '' },
    body: JSON.stringify({ userId, newPassword, requestId }),
  });
  const d = await r.json();
  if (d.success) {
    alert(`✅ Password updated. Tell the user their new password is: ${newPassword}`);
    const searchVal = document.getElementById('adminUserSearch')?.value || '';
    loadAdminUsers({ search: searchVal });
  } else {
    alert('Error: ' + (d.error || 'Unknown error'));
  }
}

async function dismissResetRequest(requestId) {
  await fetch(`/api/admin/reset-requests/${requestId}`, { method:'DELETE', headers:{'x-admin-key': window._adminKey || ''} });
  const searchVal = document.getElementById('adminUserSearch')?.value || '';
  loadAdminUsers({ search: searchVal });
}

// ══════════════════════════════════
// SAVE MOCK BAR RESULTS
// ══════════════════════════════════
async function saveMockBarResults(scores, sessionType = 'mock_bar') {
  if (!sessionToken || !currentUser) return null;
  const total    = mockQs.length || scores.length;
  const scoreSum = scores.reduce((a,s) => a + (s.score||0), 0);
  const timeTaken = window.mockStartTime ? Date.now() - window.mockStartTime : null;
  console.log('Submitting exam:', {
    questionCount: total,
    answerCount: mockAnswers.filter(a => a?.trim()).length,
    subject: currentSubject,
    sessionType,
  });
  try {
    const r = await fetch('/api/results/save', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify({
        score:       parseFloat(scoreSum.toFixed(2)),
        total,
        subject:     currentSubject || 'Mock Bar',
        questions:   scores.map(s => ({ q: s.q, score: s.score, max: s.max, improvements: s.improvements||[], keyMissed: s.keyMissed||[] })),
        timeTakenMs: timeTaken,
        sessionType,
      }),
    });
    const data = await r.json();
    if (data.id) window.mockResultId = data.id;
    return data.xpResult || null;
  } catch(e) { console.warn('Could not save results:', e.message); return null; }
}

// ══════════════════════════════════
// ADMIN: USERS
// ══════════════════════════════════
let _adminUsersCache = [];
let _userSearchTimeout;

function onUserSearch(value) {
  clearTimeout(_userSearchTimeout);
  _userSearchTimeout = setTimeout(() => {
    loadAdminUsers({ search: value });
  }, 300);
}

function formatJoinDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', timeZone:'Asia/Manila' });
}

async function loadAdminUsers({ search = '' } = {}) {
  const el = document.getElementById('adminUserList');
  if (!el) return;
  try {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    // Fetch users and reset requests in parallel
    const [rUsers, rReset] = await Promise.all([
      fetch(`/api/admin/users?${params}`, { headers:{'x-admin-key': window._adminKey||''} }),
      fetch('/api/admin/reset-requests',  { headers:{'x-admin-key': window._adminKey||''} }),
    ]);
    const users   = await rUsers.json();
    const resets  = await rReset.json();
    const pending = resets.filter(r => r.status === 'pending');
    _adminUsersCache = users;

    // Password reset requests panel (only when there are pending ones)
    let resetHtml = '';
    if (pending.length) {
      resetHtml = `
        <div style="background:rgba(155,35,53,.08);border:1px solid rgba(155,35,53,.3);border-radius:12px;padding:14px 16px;margin-bottom:16px;">
          <div style="font-weight:700;font-size:14px;color:var(--danger);margin-bottom:10px;">🔑 Password Reset Requests <span style="background:rgba(155,35,53,.25);color:var(--danger);border-radius:5px;padding:1px 7px;font-size:11px;">${pending.length}</span></div>
          ${pending.map(req => `<div class="kb-list-item" style="flex-wrap:wrap;gap:8px;align-items:center;">
            <div style="flex:1;min-width:140px;">
              <div class="kl-name">${h(req.name)}</div>
              <div class="kl-sub">${h(req.email)} &nbsp;·&nbsp; ${timeAgo(req.requestedAt)}</div>
            </div>
            <input type="password" id="newpw_${req.id}" class="form-input" placeholder="New password" style="width:160px;padding:7px 10px;font-size:12px;margin:0;">
            <button onclick="adminResetPassword('${req.userId}','${req.id}','newpw_${req.id}')" class="kl-del" style="color:var(--teal-d);background:rgba(20,180,160,.1);white-space:nowrap;">✓ Set Password</button>
            <button onclick="dismissResetRequest('${req.id}')" class="kl-del" style="white-space:nowrap;">✕ Dismiss</button>
          </div>`).join('')}
        </div>`;
    }

    if (!users.length) {
      el.innerHTML = resetHtml + `<div style="font-size:12px;color:var(--muted);">${search ? 'No users matching "'+h(search)+'".' : 'No registered users yet.'}</div>`;
      return;
    }

    el.innerHTML = resetHtml + users.map(u => {
      const adminBadge = u.isAdmin ? ` <span class="badge-admin">👑 Admin</span>` : '';
      const srOff = u.spacedRepEnabled === false;
      const csOff = u.customSubjectEnabled === false;
      const restrictBadges = (srOff || csOff) ? ` <span style="color:#ff6b6b;font-size:10px;font-weight:500;">${srOff?'🧠SR off':''}${srOff&&csOff?' · ':''}${csOff?'📝CS off':''}</span>` : '';
      return `<div class="ur-row" onclick="openUserManagePanel('${u.id}')">
        <div style="flex:1;min-width:0;">
          <div class="ur-name">${h(u.name)}${adminBadge}${restrictBadges}</div>
          <div class="ur-meta">${h(u.email)} · Joined ${formatJoinDate(u.createdAt)}</div>
        </div>
        <button class="ur-act view" onclick="event.stopPropagation();openUserManagePanel('${u.id}')" style="white-space:nowrap;">Manage →</button>
      </div>`;
    }).join('') + (search ? '' : `<div style="font-size:11px;color:var(--muted);text-align:center;margin-top:10px;">Showing ${users.length} most recent user${users.length===1?'':'s'} · Search to find specific users</div>`);
  } catch(e) { el.innerHTML = '<div style="font-size:12px;color:var(--danger);">Failed to load users.</div>'; }
}

function openUserManagePanel(userId) {
  const u = _adminUsersCache.find(x => x.id === userId);
  if (!u) return;
  const panel = document.getElementById('userManagePanel');
  const backdrop = document.getElementById('userManageBackdrop');
  document.getElementById('umpName').textContent = u.name;
  const STATUS_LABEL = { active:'Active', pending:'Pending', rejected:'Rejected', disabled:'Disabled' };
  const st = u.status || (u.active ? 'active' : 'disabled');
  const avg = u.stats.totalAttempts ? (u.stats.totalScore / u.stats.totalAttempts).toFixed(2) : '—';
  const restrictSummary = getUserAccessSummary(u);
  const restrictCount = restrictSummary ? restrictSummary.match(/(\d+)/)?.[1] + ' restricted' : 'None';
  document.getElementById('umpInfo').innerHTML = `
    <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">${h(u.email)}</div>
    <div class="ump-info-row"><span class="ump-info-label">Joined</span><span class="ump-info-val">${formatJoinDate(u.createdAt)}</span></div>
    ${u.school ? `<div class="ump-info-row"><span class="ump-info-label">School</span><span class="ump-info-val">${h(u.school)}</span></div>` : ''}
    <div class="ump-info-row"><span class="ump-info-label">Status</span><span class="ump-info-val">${STATUS_LABEL[st]||st}</span></div>
    <div class="ump-info-row"><span class="ump-info-label">Role</span><span class="ump-info-val">${u.isAdmin ? '👑 Admin' : 'Student'}</span></div>
    <div class="ump-info-row"><span class="ump-info-label">Attempts</span><span class="ump-info-val">${u.stats.totalAttempts}</span></div>
    <div class="ump-info-row"><span class="ump-info-label">Avg Score</span><span class="ump-info-val">${avg}/10</span></div>
    <div class="ump-info-row"><span class="ump-info-label">Level</span><span class="ump-info-val">${u.level || 1}</span></div>
    <div class="ump-info-row"><span class="ump-info-label">XP</span><span class="ump-info-val">${(u.xp||0).toLocaleString()}</span></div>
    <div class="ump-info-row"><span class="ump-info-label">SR Access</span><span class="ump-info-val">${u.spacedRepEnabled !== false ? '🟢 ON' : '🔴 OFF'}</span></div>
    <div class="ump-info-row"><span class="ump-info-label">Custom Subject</span><span class="ump-info-val">${u.customSubjectEnabled !== false ? '🟢 ON' : '🔴 OFF'}</span></div>
    <div class="ump-info-row" style="border:none;"><span class="ump-info-label">Restrictions</span><span class="ump-info-val">${restrictCount}</span></div>`;
  const isSelf = u.id === currentUser?.id;
  document.getElementById('umpActions').innerHTML = `
    <button class="ump-act-btn" onclick="viewUserResults('${u.id}','${h(u.name)}')">📊 View Results</button>
    <button class="ump-act-btn" onclick="openUserAccessModal('${u.id}','${h(u.name)}')">🔒 Manage Access${restrictSummary ? ' ('+restrictCount+')' : ''}</button>
    <button class="ump-act-btn" onclick="toggleUserAdmin('${u.id}',${!u.isAdmin})" ${isSelf?'disabled style="opacity:.4;cursor:not-allowed;"':''}>${u.isAdmin ? '👑 Revoke Admin' : '👑 Grant Admin'}</button>
    <button class="ump-act-btn" onclick="toggleUserSR('${u.id}',${u.spacedRepEnabled !== false})">🧠 SR: ${u.spacedRepEnabled !== false ? 'ON → Turn OFF' : 'OFF → Turn ON'}</button>
    <button class="ump-act-btn" onclick="toggleUserCustomSubject('${u.id}',${u.customSubjectEnabled !== false})">📝 Custom Subject: ${u.customSubjectEnabled !== false ? 'ON → Turn OFF' : 'OFF → Turn ON'}</button>
    <button class="ump-act-btn${u.active?' danger':''}" onclick="toggleUserAccess('${u.id}',${!u.active})">${u.active ? '⛔ Disable Account' : '✅ Enable Account'}</button>
    <button class="ump-act-btn danger" onclick="deleteUser('${u.id}','${h(u.name)}')" ${isSelf?'disabled style="opacity:.4;cursor:not-allowed;"':''}>🗑️ Delete Account</button>`;
  backdrop.classList.add('on');
  panel.classList.add('on');
  window._umpUserId = userId;
}

function closeUserManagePanel() {
  document.getElementById('userManageBackdrop').classList.remove('on');
  document.getElementById('userManagePanel').classList.remove('on');
  window._umpUserId = null;
}

async function refreshUsersAndPanel() {
  const searchVal = document.getElementById('adminUserSearch')?.value || '';
  await loadAdminUsers({ search: searchVal });
  if (window._umpUserId) openUserManagePanel(window._umpUserId);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && window._umpUserId) closeUserManagePanel();
});

async function toggleUserAccess(userId, active) {
  await adminFetch(`/api/admin/users/${userId}`, { method:'PATCH', body: JSON.stringify({ active }) });
  await refreshUsersAndPanel();
}

async function toggleUserAdmin(userId, grantAdmin) {
  const action = grantAdmin ? 'grant admin access to' : 'revoke admin access from';
  if (!confirm(`Are you sure you want to ${action} this user?`)) return;
  try {
    const r = await adminFetch(`/api/admin/users/${userId}/role`, { method:'PATCH', body: JSON.stringify({ isAdmin: grantAdmin }) });
    const d = await r.json();
    if (d.success) { await refreshUsersAndPanel(); }
    else alert('Failed: ' + (d.error || 'Unknown error'));
  } catch(e) { alert('Error: ' + e.message); }
}

async function toggleUserSR(userId, currentState) {
  const newState = !currentState;
  if (!confirm(`${newState ? 'Enable' : 'Disable'} Spaced Repetition for this user?`)) return;
  try {
    const r = await adminFetch(`/api/admin/users/${userId}/spaced-repetition`, { method:'PATCH', body: JSON.stringify({ enabled: newState }) });
    const d = await r.json();
    if (d.ok) { showToast(newState ? '🧠 SR enabled for user' : '🧠 SR disabled for user'); await refreshUsersAndPanel(); }
    else alert('Failed: ' + (d.error || 'Unknown error'));
  } catch(e) { alert('Error: ' + e.message); }
}

async function toggleUserCustomSubject(userId, currentState) {
  const newState = !currentState;
  if (!confirm(`${newState ? 'Enable' : 'Disable'} Custom Subject for this user?`)) return;
  try {
    const r = await adminFetch(`/api/admin/users/${userId}/custom-subject`, { method:'PATCH', body: JSON.stringify({ enabled: newState }) });
    const d = await r.json();
    if (d.ok) { showToast(newState ? '📝 Custom Subject enabled for user' : '📝 Custom Subject disabled for user'); await refreshUsersAndPanel(); }
    else alert('Failed: ' + (d.error || 'Unknown error'));
  } catch(e) { alert('Error: ' + e.message); }
}

async function deleteUser(userId, name) {
  if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return;
  await adminFetch(`/api/admin/users/${userId}`, { method:'DELETE' });
  closeUserManagePanel();
  const searchVal = document.getElementById('adminUserSearch')?.value || '';
  loadAdminUsers({ search: searchVal });
}


async function toggleRegistration() {
  const r = await fetch('/api/settings');
  const s = await r.json();
  await fetch('/api/admin/settings', { method:'POST', headers:{'Content-Type':'application/json','x-admin-key':window._adminKey||''}, body:JSON.stringify({ registrationOpen: !s.registrationOpen }) });
  const newState = !s.registrationOpen;
  const btn = document.getElementById('regToggleBtn');
  if (btn) btn.textContent = newState ? 'Close Registration' : 'Open Registration';
  const searchVal = document.getElementById('adminUserSearch')?.value || '';
  loadAdminUsers({ search: searchVal });
}

// ══════════════════════════════════
// ADMIN: RESULTS
// ══════════════════════════════════
const _SUBJECT_NAMES = {
  civil:'Civil Law', criminal:'Criminal Law', political:'Political Law',
  labor:'Labor & Social Leg.', commercial:'Commercial Law',
  taxation:'Taxation', remedial:'Remedial Law',
  ethics:'Legal Ethics', custom:'Custom'
};
function _normalizeResult(row) {
  const userId     = row.userId       || row.user_id       || '';
  const score      = row.score        || 0;
  const total      = row.totalQuestions || row.total_questions || row.total || 0;
  const maxScore   = total * 10;
  const passed     = row.passed       ?? (maxScore > 0 && score / maxScore >= 0.7);
  const subjectKey = row.subject      || '';
  const subject    = _SUBJECT_NAMES[subjectKey] || subjectKey || 'Mock Bar';
  const finishedAt = row.finishedAt   || row.finished_at   || row.completedAt || row.submittedAt || '';
  const userName   = row.users?.name  || row.userName      || row.user_name   || row.name || userId || 'Unknown User';
  const pct        = maxScore > 0 ? Math.round(score / maxScore * 100) : 0;
  return { userId, score, total, maxScore, passed, subject, finishedAt, userName, pct };
}

let _resultsOffset = 0;
let _resultsTotal  = 0;
let _adminResultsCache = {};

async function loadAdminResults(reset = true) {
  const el     = document.getElementById('adminResultsList');
  const footer = document.getElementById('adminResultsFooter');
  if (!el) return;
  if (reset) {
    _resultsOffset = 0;
    _adminResultsCache = {};
    el.innerHTML = '<div style="font-size:12px;color:var(--muted);">Loading…</div>';
  }
  if (footer) footer.innerHTML = '<span style="font-size:12px;color:var(--muted);">Loading…</span>';
  try {
    const params = new URLSearchParams({ limit: 20, offset: _resultsOffset });
    const r    = await fetch('/api/admin/results?' + params, { headers:{'x-admin-key': window._adminKey||''} });
    const data = await r.json();
    const rows = data.results || [];
    rows.forEach(row => { _adminResultsCache[row.id] = row; });
    _resultsTotal = data.total || 0;
    if (reset && !rows.length) {
      el.innerHTML = '<div style="font-size:12px;color:var(--muted);">No results saved yet.</div>';
      if (footer) footer.innerHTML = '';
      return;
    }
    const html = rows.map(row => {
      const { userName, finishedAt, total, maxScore, score, pct, passed } = _normalizeResult(row);
      const dateStr = finishedAt ? new Date(finishedAt).toLocaleDateString('en-CA', {timeZone:'Asia/Manila'}) : '—';
      return `<div class="ur-row">
        <div><div class="ur-name">${h(userName)}</div><div class="ur-meta">${dateStr} &nbsp;·&nbsp; ${total} questions</div></div>
        <span class="ur-badge${passed?'':' off'}">${score}/${maxScore} (${pct}%)</span>
        <button class="ur-act view" onclick="viewResult('${row.id}')">View</button>
        <button class="ur-act del" onclick="deleteResult('${row.id}')">Delete</button>
      </div>`;
    }).join('');
    if (reset) el.innerHTML = html;
    else el.insertAdjacentHTML('beforeend', html);
    _resultsOffset += rows.length;
    if (footer) {
      if (_resultsOffset >= _resultsTotal) {
        footer.innerHTML = `<span style="font-size:12px;color:var(--muted);">All ${_resultsTotal} results loaded</span>`;
      } else {
        footer.innerHTML = `<span style="font-size:12px;color:var(--muted);">Showing ${_resultsOffset} of ${_resultsTotal} results</span>
          <button class="btn-og" onclick="loadAdminResults(false)" style="font-size:11px;">Load More Results</button>`;
      }
    }
  } catch(e) {
    el.innerHTML = '<div style="font-size:12px;color:var(--danger);">Failed to load results.</div>';
    if (footer) footer.innerHTML = '';
  }
}

// ── Admin Question Sources ────────────────────────────────────
async function loadAdminSources() {
  const el = document.getElementById('adminSourcesList');
  if (!el) return;
  el.innerHTML = '<div style="font-size:12px;color:var(--muted);">Loading…</div>';
  try {
    const r = await adminFetch('/api/kb');
    const d = await r.json();
    const batches = d.pastBar || [];
    if (!batches.length) { el.innerHTML = '<div style="font-size:12px;color:var(--muted);">No past bar batches uploaded yet.</div>'; return; }
    el.innerHTML = batches.map(pb => {
      const enabled = pb.enabled !== false;
      return `<div class="source-row ${enabled ? 'enabled' : 'disabled'}" id="src-row-${pb.id}">
        <div class="source-info">
          <div class="source-name">${h(pb.name || pb.label || pb.id)}</div>
          <div class="source-meta">${pb.qCount || 0} questions · ${pb.subject || 'all subjects'}</div>
        </div>
        <button class="toggle-btn ${enabled ? 'btn-disable' : 'btn-enable'}" onclick="toggleBatchSource('${pb.id}', ${!enabled})">
          ${enabled ? 'Disable' : 'Enable'}
        </button>
      </div>`;
    }).join('');
  } catch(e) { el.innerHTML = `<div style="font-size:12px;color:var(--danger);">Failed to load sources: ${e.message}</div>`; }
}

async function toggleBatchSource(id, enable) {
  try {
    const r = await adminFetch(`/api/admin/pastbar/${id}/toggle`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enable }) });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    // Update KB cache
    const entry = (KB.pastBar || []).find(p => p.id === id);
    if (entry) entry.enabled = d.enabled;
    // Refresh the list
    loadAdminSources();
  } catch(e) { alert('Error: ' + e.message); }
}

// ── Admin Questions Bank ─────────────────────────────────────
let _adminQOffset = 0;
let _adminQTotal  = 0;
const _ADMIN_Q_LIMIT = 20;

async function loadAdminQuestions(reset = true) {
  const el = document.getElementById('adminQList');
  if (!el) return;
  if (reset) {
    _adminQOffset = 0;
    el.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 0;">Loading…</div>';
  }

  // Populate subject dropdown once
  const subjSel = document.getElementById('adminQSubject');
  if (subjSel && subjSel.children.length === 1 && typeof SUBJS !== 'undefined') {
    SUBJS.forEach(s => {
      const o = document.createElement('option');
      o.value = s.key; o.textContent = s.name;
      subjSel.appendChild(o);
    });
  }

  const q       = (document.getElementById('adminQSearch')?.value || '').trim();
  const subject = document.getElementById('adminQSubject')?.value || '';
  const year    = document.getElementById('adminQYear')?.value || '';
  const type    = document.getElementById('adminQType')?.value || '';
  const params  = new URLSearchParams({ limit: _ADMIN_Q_LIMIT, offset: _adminQOffset });
  if (q)       params.set('q', q);
  if (subject) params.set('subject', subject);
  if (year)    params.set('year', year);
  if (type)    params.set('type', type);

  try {
    const r    = await fetch('/api/admin/questions?' + params, { headers: { 'x-admin-key': window._adminKey || '' } });
    const data = await r.json();
    _adminQTotal = data.total ?? 0;

    const totalEl = document.getElementById('adminQTotal');
    if (totalEl) totalEl.textContent = `${_adminQTotal} questions total`;

    if (!data.questions || data.questions.length === 0) {
      if (reset) el.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 0;">No questions found.</div>';
    } else {
      const html = data.questions.map(q => {
        const safeQ = h(q.question_text || '');
        const qJson = h(JSON.stringify(q));
        return `<div class="ur-row">
          <div style="flex:1;min-width:0;">
            <div class="ur-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;">${safeQ}</div>
            <div class="ur-meta">${h(q.subject || '—')} &nbsp;·&nbsp; ${h(q.year || '—')} &nbsp;·&nbsp; ${h(q.source || '—')}</div>
          </div>
          <span class="ur-badge">${h(q.type || 'essay')}</span>
          <button class="ur-act view" onclick='openEditQuestion(${qJson})'>Edit</button>
          <button class="ur-act del" onclick="deleteQuestion('${q.id}')">Delete</button>
        </div>`;
      }).join('');
      if (reset) el.innerHTML = html;
      else el.insertAdjacentHTML('beforeend', html);
      _adminQOffset += data.questions.length;
    }

    // Load More footer
    const pager = document.getElementById('adminQPager');
    if (pager) {
      if (_adminQOffset >= _adminQTotal || !data.questions?.length) {
        pager.innerHTML = _adminQOffset > 0
          ? `<span style="font-size:12px;color:var(--muted);">All ${_adminQTotal} questions loaded</span>`
          : '';
      } else {
        pager.innerHTML = `<span style="font-size:12px;color:var(--muted);">Showing ${_adminQOffset} of ${_adminQTotal} questions</span>
          <button class="btn-og" onclick="loadAdminQuestions(false)" style="font-size:11px;">Load More Questions</button>`;
      }
    }
  } catch(e) {
    el.innerHTML = `<div style="font-size:12px;color:var(--danger);">Failed to load questions: ${h(e.message)}</div>`;
  }
}

async function deleteQuestion(id) {
  if (!confirm('Delete this question? This cannot be undone.')) return;
  try {
    const r = await fetch(`/api/admin/questions/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { 'x-admin-key': window._adminKey || '' }
    });
    if (r.ok) loadAdminQuestions();
    else { const d = await r.json(); alert('Delete failed: ' + (d.error || r.status)); }
  } catch(e) { alert('Delete failed: ' + e.message); }
}

function openEditQuestion(q) {
  if (typeof q === 'string') { try { q = JSON.parse(q); } catch(_) { return; } }
  document.getElementById('editQId').value      = q.id || '';
  document.getElementById('editQText').value    = q.question_text || '';
  document.getElementById('editQContext').value = q.context || '';
  document.getElementById('editQAnswer').value  = q.model_answer || '';
  document.getElementById('editQType').value    = q.type || 'essay';
  document.getElementById('editQMax').value     = q.max_score || 10;
  for (let i = 1; i <= 5; i++) {
    const el = document.getElementById('editQAlt' + i);
    if (el) el.value = q['alternative_answer_' + i] || '';
  }
  document.getElementById('editQuestionModal').style.display = 'flex';
}

async function saveEditQuestion() {
  const id = document.getElementById('editQId').value;
  if (!id) return;
  const body = {
    question_text: document.getElementById('editQText').value,
    context:       document.getElementById('editQContext').value || null,
    model_answer:  document.getElementById('editQAnswer').value || null,
    type:          document.getElementById('editQType').value,
    max_score:     parseInt(document.getElementById('editQMax').value) || 10,
    alternative_answer_1: document.getElementById('editQAlt1').value || null,
    alternative_answer_2: document.getElementById('editQAlt2').value || null,
    alternative_answer_3: document.getElementById('editQAlt3').value || null,
    alternative_answer_4: document.getElementById('editQAlt4').value || null,
    alternative_answer_5: document.getElementById('editQAlt5').value || null,
  };
  try {
    const r = await fetch(`/api/admin/questions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': window._adminKey || '' },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      document.getElementById('editQuestionModal').style.display = 'none';
      loadAdminQuestions(_adminQPage);
    } else { const d = await r.json(); alert('Save failed: ' + (d.error || r.status)); }
  } catch(e) { alert('Save failed: ' + e.message); }
}

async function viewUserResults(userId, name) {
  const r    = await fetch(`/api/admin/results/${userId}`, { headers:{'x-admin-key': window._adminKey||''} });
  const rows = await r.json();
  const norm = (Array.isArray(rows) ? rows : []).map(_normalizeResult);
  document.getElementById('resultDetailTitle').textContent = `📊 ${name} — Results`;
  const avgPct = norm.length ? Math.round(norm.reduce((a,r)=>a+r.pct,0)/norm.length) : 0;
  document.getElementById('resultDetailStats').innerHTML = `
    <div class="res-dstat"><div class="res-dstat-val">${norm.length}</div><div class="res-dstat-lbl">Attempts</div></div>
    <div class="res-dstat"><div class="res-dstat-val">${norm.length ? avgPct+'%' : '—'}</div><div class="res-dstat-lbl">Avg Score</div></div>
    <div class="res-dstat"><div class="res-dstat-val">${norm.filter(r=>r.passed).length}</div><div class="res-dstat-lbl">Passed</div></div>`;
  document.getElementById('resultDetailBody').innerHTML = norm.map(r =>
    `<div style="padding:8px 0;border-bottom:1px solid var(--bdr2);font-size:12px;">${r.finishedAt?r.finishedAt.slice(0,10):'—'} &nbsp; <strong>${r.score}/${r.maxScore} (${r.pct}%)</strong></div>`
  ).join('') || '<div style="color:var(--muted);">No results.</div>';
  document.getElementById('resultDetailOverlay').classList.add('on');
}

async function viewResult(resultId) {
  let row = _adminResultsCache[resultId];
  if (!row) {
    // fallback: fetch paginated endpoint and scan first page
    const r    = await fetch('/api/admin/results?limit=20&offset=0', { headers:{'x-admin-key': window._adminKey||''} });
    const data = await r.json();
    const rows = data.results || [];
    rows.forEach(r2 => { _adminResultsCache[r2.id] = r2; });
    row = _adminResultsCache[resultId];
  }
  if (!row) return;
  const { userName, finishedAt, total, maxScore, score, pct } = _normalizeResult(row);
  const dateStr = finishedAt ? formatDate(finishedAt) : '—';
  document.getElementById('resultDetailTitle').textContent = `📊 ${userName} — ${dateStr}`;
  document.getElementById('resultDetailStats').innerHTML = `
    <div class="res-dstat"><div class="result-user" style="margin-bottom:8px;">👤 ${h(userName)}</div></div>
    <div class="res-dstat"><div class="res-dstat-val">${fmt(score)}/${maxScore}</div><div class="res-dstat-lbl">Score</div></div>
    <div class="res-dstat"><div class="res-dstat-val">${pct}%</div><div class="res-dstat-lbl">Percentage</div></div>
    <div class="res-dstat"><div class="res-dstat-val">${total}</div><div class="res-dstat-lbl">Questions</div></div>`;
  document.getElementById('resultDetailBody').innerHTML = (row.questions||[]).map((q,i)=>
    `<div style="padding:7px 0;border-bottom:1px solid var(--bdr2);font-size:12px;"><strong>Q${i+1}:</strong> ${h((q.q||'').slice(0,120))} &nbsp;<span style="color:var(--gold);">${fmt(q.score)||'—'}/${q.max||'—'}</span></div>`
  ).join('') || '<div style="color:var(--muted);">No question detail.</div>';
  document.getElementById('resultDetailOverlay').classList.add('on');
}

async function deleteResult(resultId) {
  if (!confirm('Delete this result?')) return;
  await fetch(`/api/admin/results/${resultId}`, { method:'DELETE', headers:{'x-admin-key':window._adminKey||''} });
  loadAdminResults();
}

// ══════════════════════════════════
// ADMIN: SYLLABUS BUILDER
// ══════════════════════════════════
async function loadSyllabusBuilder() {
  try {
    const r = await fetch('/api/syllabus', { headers: {'x-admin-key': adminKey||''} });
    const d = await r.json();
    syllabusData = d.subjects || {};
    // Sync into per-subject syllabus cache for Learn tab too
    Object.assign(syllabusCache, syllabusData);
    renderSyllabusBuilder();
  } catch(e) {
    const c = document.getElementById('syllabus-builder-container');
    if (c) c.innerHTML = `<div style="color:var(--danger);font-size:12px;padding:16px;">Failed to load syllabus.</div>`;
  }
}

function renderSyllabusBuilder() {
  const subj = syllabusBuilderSubject;
  const container = document.getElementById('syllabus-builder-container');
  if (!container) return;
  const sections = syllabusData[subj]?.sections || [];
  if (!sections.length) {
    container.innerHTML = `<div style="text-align:center;padding:32px;color:var(--muted);font-size:13px;"><div style="font-size:36px;margin-bottom:12px;">📋</div>No topics yet for this subject.<br>Click the button below to add the first section.</div>`;
    return;
  }
  container.innerHTML = sections.map((sec, si) => renderSectionAdmin(sec, si, sections.length)).join('');
}

function renderSectionAdmin(sec, si, total) {
  const children = sec.children || [];
  return `<div class="sb-section" id="sbsec-${sec.id}">
    <div class="sb-section-header">
      <span class="sb-roman">${h(sec.label)}.</span>
      <span class="sb-section-title">${h(sec.title)}</span>
      <div class="sb-actions">
        <button class="sb-btn-icon" title="Move up" onclick="moveSyllabusNode('${sec.id}',-1)" ${si===0?'disabled':''}>▲</button>
        <button class="sb-btn-icon" title="Move down" onclick="moveSyllabusNode('${sec.id}',1)" ${si===total-1?'disabled':''}>▼</button>
        <button class="sb-btn-edit" onclick="editSyllabusNode('${sec.id}')">✏️</button>
        <button class="sb-btn-delete" onclick="deleteSyllabusNode('${sec.id}')">🗑</button>
      </div>
    </div>
    <div class="sb-children">${children.map((child, ci) => renderNodeAdmin(child, ci, children.length, sec.id, 0)).join('')}</div>
    <button class="sb-add-child-btn" onclick="showAddNodeForm('${sec.id}','${sec.id}')">+ Add topic under ${h(sec.label)}</button>
    <div id="addform-${sec.id}"></div>
  </div>`;
}

function renderNodeAdmin(node, idx, total, parentId, depth) {
  const indent = depth * 18 + 16;
  const isGroup = (node.children||[]).length > 0;
  const hasPDF = !!node.pdfId;
  const children = node.children || [];
  return `<div class="sb-node ${isGroup?'sb-group':'sb-leaf'}" id="sbnode-${node.id}">
    <div class="sb-node-row" style="padding-left:${indent}px">
      <span class="sb-label">${h(node.label)}.</span>
      <span class="sb-node-title">${h(node.title)}</span>
      <div class="sb-node-badges" style="flex-shrink:0;">${hasPDF ? `<span class="sb-pdf-badge" title="${h(node.pdfName||'')}">📄 PDF</span>` : '<span class="sb-no-pdf">No PDF</span>'}</div>
      <div class="sb-actions">
        <button class="sb-btn-icon" title="Move up" onclick="moveSyllabusNode('${node.id}',-1)" ${idx===0?'disabled':''}>▲</button>
        <button class="sb-btn-icon" title="Move down" onclick="moveSyllabusNode('${node.id}',1)" ${idx===total-1?'disabled':''}>▼</button>
        <button class="sb-btn-pdf" onclick="managePDF('${node.id}','${node.pdfId||''}','${(node.pdfName||'').replace(/'/g,"\\'")}',event)">${hasPDF?'🔄 PDF':'📤 PDF'}</button>
        <button class="sb-btn-add" title="Add child" onclick="showAddNodeForm('${node.id}','${node.id}')">+</button>
        <button class="sb-btn-edit" onclick="editSyllabusNode('${node.id}')">✏️</button>
        <button class="sb-btn-delete" onclick="deleteSyllabusNode('${node.id}')">🗑</button>
      </div>
    </div>
    ${isGroup ? `<div class="sb-children">${children.map((c,ci)=>renderNodeAdmin(c,ci,children.length,node.id,depth+1)).join('')}</div>` : ''}
    <div id="addform-${node.id}"></div>
  </div>`;
}

function showAddSectionForm() {
  sbInputModal({
    title: '+ Add Section',
    fields: [
      { id:'label', label:'Roman Numeral Label', placeholder:'e.g. I, II, III…' },
      { id:'title', label:'Section Title', placeholder:'e.g. NATIONAL TERRITORY' },
    ],
    onSave: async (vals) => {
      if (!vals.label || !vals.title) { alert('Label and title required.'); return false; }
      await fetch(`/api/admin/syllabus/${syllabusBuilderSubject}/section`, {
        method: 'POST',
        headers: {'Content-Type':'application/json','x-admin-key':adminKey||''},
        body: JSON.stringify({ label: vals.label.toUpperCase(), title: vals.title.toUpperCase() }),
      });
      await loadSyllabusBuilder();
    },
  });
}

function showAddNodeForm(parentId, containerId) {
  document.querySelectorAll('.sb-add-form').forEach(f => f.remove());
  const container = document.getElementById('addform-' + containerId);
  if (!container) return;
  container.innerHTML = `<div class="sb-add-form">
    <div style="display:flex;gap:8px;margin-bottom:8px;">
      <div style="flex:0 0 72px">
        <label class="sb-field-label">LABEL</label>
        <input type="text" id="new-node-label-${containerId}" placeholder="A, B, 1…" class="sb-field-input" style="text-align:center;">
      </div>
      <div style="flex:1">
        <label class="sb-field-label">TITLE</label>
        <input type="text" id="new-node-title-${containerId}" placeholder="Topic title…" class="sb-field-input">
      </div>
    </div>
    <div style="display:flex;gap:8px;">
      <button class="sb-save-btn" onclick="submitAddNode('${parentId}','${containerId}')">✓ Add</button>
      <button class="sb-cancel-btn" onclick="this.closest('.sb-add-form').remove()">Cancel</button>
    </div>
  </div>`;
  document.getElementById(`new-node-title-${containerId}`)?.focus();
}

async function submitAddNode(parentId, containerId) {
  const label = document.getElementById(`new-node-label-${containerId}`)?.value?.trim();
  const title = document.getElementById(`new-node-title-${containerId}`)?.value?.trim();
  if (!label || !title) { alert('Label and title are required.'); return; }
  await fetch(`/api/admin/syllabus/${syllabusBuilderSubject}/node`, {
    method: 'POST',
    headers: {'Content-Type':'application/json','x-admin-key':adminKey||''},
    body: JSON.stringify({ parentId, label, title }),
  });
  await loadSyllabusBuilder();
}

function editSyllabusNode(nodeId) {
  const sections = syllabusData[syllabusBuilderSubject]?.sections || [];
  function findNode(arr) {
    for (const n of arr) {
      if (n.id === nodeId) return n;
      if (n.children?.length) { const f = findNode(n.children); if (f) return f; }
    }
    return null;
  }
  const node = findNode(sections);
  if (!node) return;
  sbInputModal({
    title: '✏️ Edit',
    fields: [
      { id:'label', label:'Label', defaultValue: node.label },
      { id:'title', label:'Title', defaultValue: node.title },
    ],
    onSave: async (vals) => {
      await fetch(`/api/admin/syllabus/${syllabusBuilderSubject}/node/${nodeId}`, {
        method: 'PATCH',
        headers: {'Content-Type':'application/json','x-admin-key':adminKey||''},
        body: JSON.stringify({ label: vals.label||node.label, title: vals.title||node.title }),
      });
      await loadSyllabusBuilder();
    },
  });
}

async function deleteSyllabusNode(nodeId) {
  if (!confirm('Delete this topic and ALL its children and attached PDFs? Cannot be undone.')) return;
  await fetch(`/api/admin/syllabus/${syllabusBuilderSubject}/node/${nodeId}`, {
    method: 'DELETE', headers: {'x-admin-key': adminKey||''},
  });
  await loadSyllabusBuilder();
}

async function moveSyllabusNode(nodeId, dir) {
  await fetch(`/api/admin/syllabus/${syllabusBuilderSubject}/reorder`, {
    method: 'POST',
    headers: {'Content-Type':'application/json','x-admin-key':adminKey||''},
    body: JSON.stringify({ nodeId, direction: dir }),
  });
  await loadSyllabusBuilder();
}

function managePDF(nodeId, currentPdfId, currentPdfName, evt) {
  if (evt) evt.stopPropagation();
  const hasPDF = !!currentPdfId;
  const modal = document.createElement('div');
  modal.className = 'sb-modal-overlay';
  modal.innerHTML = `<div class="sb-modal">
    <div class="sb-modal-header">📄 Review Material PDF</div>
    ${hasPDF ? `
      <div class="sb-pdf-current">
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px;">Current file:</div>
        <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:rgba(20,180,160,.07);border:1px solid rgba(20,180,160,.18);border-radius:9px;">
          <span style="font-size:18px;">📄</span>
          <span style="font-size:13px;flex:1;">${h(currentPdfName)}</span>
          <a href="/api/syllabus/pdf/${nodeId}" target="_blank" style="font-size:11px;color:var(--teal);text-decoration:none;font-weight:700;">Preview ↗</a>
        </div>
        <button class="sb-delete-pdf-btn" onclick="deletePDF('${nodeId}')">🗑 Remove PDF</button>
      </div>
    ` : `<div style="text-align:center;padding:14px 0;color:var(--muted);font-size:13px;">No PDF attached yet.</div>`}
    <div>
      <div style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:7px;">${hasPDF?'Replace PDF':'Upload PDF'}</div>
      <input type="file" id="pdf-file-input-${nodeId}" accept=".pdf" style="display:none" onchange="uploadPDF('${nodeId}',this)">
      <button class="sb-upload-pdf-btn" onclick="document.getElementById('pdf-file-input-${nodeId}').click()">📤 Choose PDF File</button>
      <div id="pdf-upload-status-${nodeId}" style="font-size:12px;color:var(--muted);margin-top:7px;"></div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px;">
      <button class="sb-cancel-btn" onclick="this.closest('.sb-modal-overlay').remove()">Close</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function uploadPDF(nodeId, input) {
  const file = input.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.pdf')) { alert('Please select a PDF file.'); return; }
  const statusEl = document.getElementById('pdf-upload-status-' + nodeId);
  if (statusEl) statusEl.textContent = 'Uploading…';
  const formData = new FormData();
  formData.append('pdf', file);
  try {
    const r = await fetch(`/api/admin/syllabus/${syllabusBuilderSubject}/node/${nodeId}/pdf`, {
      method: 'POST', headers: {'x-admin-key': adminKey||''}, body: formData,
    });
    const d = await r.json();
    if (d.pdfId) {
      if (statusEl) { statusEl.textContent = '✅ ' + d.pdfName; statusEl.style.color = 'var(--teal)'; }
      setTimeout(async () => { document.querySelector('.sb-modal-overlay')?.remove(); await loadSyllabusBuilder(); }, 900);
    } else { throw new Error(d.error || 'Upload failed'); }
  } catch(e) {
    if (statusEl) { statusEl.textContent = '❌ ' + e.message; statusEl.style.color = 'var(--danger)'; }
  }
}

async function deletePDF(nodeId) {
  if (!confirm('Remove the PDF for this topic?')) return;
  await fetch(`/api/admin/syllabus/${syllabusBuilderSubject}/node/${nodeId}/pdf`, {
    method: 'DELETE', headers: {'x-admin-key': adminKey||''},
  });
  document.querySelector('.sb-modal-overlay')?.remove();
  await loadSyllabusBuilder();
}

function sbInputModal({ title, fields, onSave }) {
  const modal = document.createElement('div');
  modal.className = 'sb-modal-overlay';
  modal.innerHTML = `<div class="sb-modal">
    <div class="sb-modal-header">${title}</div>
    ${fields.map(f => `<div style="margin-bottom:12px;">
      <label class="sb-field-label">${f.label}</label>
      <input type="text" id="sbm-${f.id}" class="sb-field-input" placeholder="${f.placeholder||''}" value="${h(f.defaultValue||'')}">
    </div>`).join('')}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
      <button class="sb-cancel-btn" onclick="this.closest('.sb-modal-overlay').remove()">Cancel</button>
      <button class="sb-save-btn" id="sbm-save-btn">Save</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  modal.querySelector('#sbm-save-btn').addEventListener('click', async () => {
    const vals = {};
    fields.forEach(f => { vals[f.id] = document.getElementById('sbm-'+f.id)?.value?.trim(); });
    const shouldClose = await onSave(vals);
    if (shouldClose !== false) modal.remove();
  });
  // Enter key submits
  modal.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') modal.querySelector('#sbm-save-btn').click(); });
  });
  modal.querySelector('input')?.focus();
}

// ══════════════════════════════════
// PER-USER TAB ACCESS CONTROL
// ══════════════════════════════════
function getDefaultUserTabSettings() {
  return {
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
      custom:     { learn: true, quiz: false, mockbar: true, speeddrill: true },
    },
  };
}

function getUserAccessSummary(u) {
  if (!u.tabSettings) return '';
  const s = u.tabSettings;
  let restrictions = 0;
  const allSubjs = [...(SUBJS || []), CUSTOM_SUBJ];
  allSubjs.forEach(subj => {
    ['learn','quiz','mockbar','speeddrill'].forEach(mode => {
      if (s.subjects?.[subj.key]?.[mode] === false) restrictions++;
    });
  });
  if (s.overview === false) restrictions++;
  if (!restrictions) return '';
  return `<span style="font-size:10px;background:rgba(155,35,53,.18);color:var(--danger);border-radius:4px;padding:1px 7px;margin-left:7px;font-weight:600;">${restrictions} restricted</span>`;
}

async function openUserAccessModal(userId, userName) {
  currentAccessUserId = userId;
  currentAccessUserName = userName;
  const modal = document.getElementById('userAccessModal');
  modal.style.display = 'flex';
  document.getElementById('userAccessModalTitle').textContent = 'User: ' + userName;
  document.getElementById('userAccessGrid').innerHTML = '<div style="color:var(--muted);font-size:12px;padding:12px 0;">Loading…</div>';
  const saveBtn = document.getElementById('saveUserAccessBtn');
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Save Access'; }
  try {
    const r = await fetch(`/api/admin/users/${userId}/tab-settings`, { headers: {'x-admin-key': window._adminKey||''} });
    const d = await r.json();
    pendingUserTabSettings = d.tabSettings || getDefaultUserTabSettings();
    renderUserAccessGrid();
  } catch(e) {
    document.getElementById('userAccessGrid').innerHTML = '<div style="color:var(--danger);font-size:12px;">Failed to load settings.</div>';
  }
}

function closeUserAccessModal() {
  document.getElementById('userAccessModal').style.display = 'none';
  currentAccessUserId = null;
  currentAccessUserName = '';
  pendingUserTabSettings = null;
}

function renderUserAccessGrid() {
  const container = document.getElementById('userAccessGrid');
  if (!container) return;
  const s = pendingUserTabSettings || getDefaultUserTabSettings();
  const globalS = window.TAB_SETTINGS || {};
  const modeLabels = { learn: '📖 Learn', quiz: '✏️ Quiz', mockbar: '⏱ Mock Bar', speeddrill: '⚡ Speed Drill' };
  let html = '';
  const allSubjs = [...SUBJS, CUSTOM_SUBJ];
  allSubjs.forEach(subj => {
    const modes = ['learn', 'quiz', 'mockbar', 'speeddrill'];
    const pillsHtml = modes.map(mode => {
      const globalLocked = globalS.subjects?.[subj.key]?.[mode] === false;
      const personalEnabled = s.subjects?.[subj.key]?.[mode] !== false;
      const enabled = personalEnabled && !globalLocked;
      const lockTip = globalLocked ? ' title="Disabled globally — cannot override"' : '';
      return `<label style="display:flex;align-items:center;gap:5px;font-size:12px;color:${enabled ? 'var(--text,var(--white))' : 'var(--muted)'};cursor:${globalLocked ? 'not-allowed' : 'pointer'};background:${enabled ? 'rgba(var(--ovl),.05)' : 'transparent'};border:1px solid ${enabled ? 'var(--bdr2)' : 'transparent'};border-radius:6px;padding:4px 9px;transition:all .15s;"${lockTip}>
        <input type="checkbox" ${enabled ? 'checked' : ''} ${globalLocked ? 'disabled' : ''} onchange="toggleUserSubjTab('${subj.key}','${mode}',this.checked)" style="accent-color:var(--gold);cursor:${globalLocked ? 'not-allowed' : 'pointer'};">
        ${modeLabels[mode]}${globalLocked ? ' 🔒' : ''}
      </label>`;
    }).join('');
    html += `<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:10px;background:rgba(var(--ovl),.025);border:1px solid var(--bdr2);margin-bottom:6px;flex-wrap:wrap;">
      <div style="flex:1;min-width:120px;font-size:13px;font-weight:600;color:var(--text,var(--white));">${subj.name}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">${pillsHtml}</div>
    </div>`;
  });
  container.innerHTML = html;
}

function toggleUserSubjTab(subj, mode, value) {
  if (!pendingUserTabSettings) pendingUserTabSettings = getDefaultUserTabSettings();
  if (!pendingUserTabSettings.subjects) pendingUserTabSettings.subjects = {};
  if (!pendingUserTabSettings.subjects[subj]) pendingUserTabSettings.subjects[subj] = {};
  pendingUserTabSettings.subjects[subj][mode] = value;
  renderUserAccessGrid();
}

function setAllUserTabs(val) {
  pendingUserTabSettings = getDefaultUserTabSettings();
  if (!val) {
    const allSubjs = [...SUBJS, CUSTOM_SUBJ];
    allSubjs.forEach(subj => {
      ['learn', 'quiz', 'mockbar', 'speeddrill'].forEach(mode => { pendingUserTabSettings.subjects[subj.key][mode] = false; });
    });
    pendingUserTabSettings.overview = false;
  }
  renderUserAccessGrid();
}

function setAllUserMode(mode, val) {
  if (!pendingUserTabSettings) pendingUserTabSettings = getDefaultUserTabSettings();
  const allSubjs = [...SUBJS, CUSTOM_SUBJ];
  allSubjs.forEach(subj => {
    if (!pendingUserTabSettings.subjects[subj.key]) pendingUserTabSettings.subjects[subj.key] = {};
    pendingUserTabSettings.subjects[subj.key][mode] = val;
  });
  renderUserAccessGrid();
}

async function saveUserAccess() {
  if (!currentAccessUserId) return;
  const btn = document.getElementById('saveUserAccessBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const r = await fetch(`/api/admin/users/${currentAccessUserId}/tab-settings`, {
      method: 'PATCH',
      headers: {'Content-Type':'application/json','x-admin-key': window._adminKey||''},
      body: JSON.stringify({ tabSettings: pendingUserTabSettings }),
    });
    if (!r.ok) throw new Error('Save failed');
    if (btn) { btn.textContent = '✅ Saved!'; setTimeout(() => { btn.disabled = false; btn.textContent = '💾 Save Access'; }, 2000); }
    refreshUsersAndPanel();
  } catch(e) {
    if (btn) { btn.textContent = '⚠️ Error'; btn.disabled = false; }
  }
}

async function resetUserAccess() {
  if (!currentAccessUserId || !confirm(`Reset "${currentAccessUserName}" to global defaults? This removes all personal tab restrictions.`)) return;
  const btn = document.getElementById('saveUserAccessBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Resetting…'; }
  try {
    await fetch(`/api/admin/users/${currentAccessUserId}/tab-settings`, {
      method: 'DELETE',
      headers: {'x-admin-key': window._adminKey||''},
    });
    pendingUserTabSettings = getDefaultUserTabSettings();
    renderUserAccessGrid();
    if (btn) { btn.textContent = '✅ Reset!'; setTimeout(() => { btn.disabled = false; btn.textContent = '💾 Save Access'; }, 2000); }
    refreshUsersAndPanel();
  } catch(e) {
    if (btn) { btn.disabled = false; }
  }
}

async function exportResultsCSV() {
  const r    = await fetch('/api/admin/results?limit=9999&offset=0', { headers:{'x-admin-key': window._adminKey||''} });
  const data = await r.json();
  const rows = data.results || (Array.isArray(data) ? data : []);
  const lines = ['Name,Date,Subject,Score,Total,Pct,Passed'];
  rows.forEach(row => {
    const { userName, finishedAt, subject, score, total, pct, passed } = _normalizeResult(row);
    lines.push(`"${userName}","${finishedAt?finishedAt.slice(0,10):''}","${subject}","${score}","${total}","${pct}%","${passed?'Yes':'No'}"`);
  });
  const blob = new Blob([lines.join('\n')], { type:'text/csv' });
  const a    = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'barbuddy_results.csv'; a.click();
}

// ══════════════════════════════════
// ADMIN: IMPROVE ITEMS INSIGHTS
// ══════════════════════════════════
let _improveData   = [];  // raw items from server (accumulated across pages)
let _improveOffset = 0;
let _improveTotal  = 0;

async function loadImproveItems(reset = true) {
  const tbody  = document.getElementById('improveTableBody');
  const footer = document.getElementById('improveFooter');
  if (reset) {
    _improveData   = [];
    _improveOffset = 0;
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="padding:16px;color:var(--muted);">Loading…</td></tr>';
  }
  if (footer) footer.innerHTML = '<span style="font-size:12px;color:var(--muted);">Loading…</span>';
  try {
    // Pass filters to server so it returns filtered results
    const subj     = document.getElementById('improveSubject')?.value  || '';
    const dateFrom = document.getElementById('improveDateFrom')?.value || '';
    const dateTo   = document.getElementById('improveDateTo')?.value   || '';
    const params = new URLSearchParams({ limit: 20, offset: _improveOffset });
    if (subj)     params.set('subject', subj);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo)   params.set('dateTo', dateTo);
    const r    = await fetch('/api/admin/improve-items?' + params, { headers:{'x-admin-key': window._adminKey||''} });
    const data = await r.json();
    const newItems = Array.isArray(data.items) ? data.items : [];
    _improveTotal  = data.total || 0;
    _improveData   = [..._improveData, ...newItems];
    _improveOffset += 20;  // advance by results fetched (server uses limit=20 results)
    renderImproveTable();
    if (footer) {
      const moreAvailable = _improveOffset < _improveTotal;
      if (!moreAvailable || !newItems.length) {
        footer.innerHTML = _improveData.length > 0
          ? `<span style="font-size:12px;color:var(--muted);">All ${_improveTotal} results loaded</span>`
          : '';
      } else {
        footer.innerHTML = `<span style="font-size:12px;color:var(--muted);">Loaded from ${Math.min(_improveOffset, _improveTotal)} of ${_improveTotal} results</span>
          <button class="btn-og" onclick="loadImproveItems(false)" style="font-size:11px;">Load More Insights</button>`;
      }
    }
  } catch(e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" style="padding:16px;color:var(--danger);">Failed to load: ${h(e.message)}</td></tr>`;
    if (footer) footer.innerHTML = '';
  }
}

function _improveFiltered() {
  const kw      = (document.getElementById('improveSearch')?.value   || '').toLowerCase().trim();
  const subj    = (document.getElementById('improveSubject')?.value  || '');
  const dateFrom = document.getElementById('improveDateFrom')?.value || '';
  const dateTo   = document.getElementById('improveDateTo')?.value   || '';
  return _improveData.filter(item => {
    if (subj && item.subject !== subj) return false;
    const d = item.date ? item.date.slice(0,10) : '';
    if (dateFrom && d < dateFrom) return false;
    if (dateTo   && d > dateTo)   return false;
    if (kw) {
      const haystack = [item.studentName, item.subject, item.question, ...(item.improvements||[]), ...(item.keyMissed||[])].join(' ').toLowerCase();
      if (!haystack.includes(kw)) return false;
    }
    return true;
  });
}

function renderImproveTable() {
  const filtered = _improveFiltered();
  const tbody = document.getElementById('improveTableBody');
  const countEl = document.getElementById('improveCount');

  // Flatten to individual improve rows for count
  let totalItems = 0;
  const studentSet = new Set();
  filtered.forEach(item => {
    totalItems += (item.improvements||[]).length + (item.keyMissed||[]).length;
    if (item.studentName) studentSet.add(item.studentName);
  });
  if (countEl) countEl.textContent = `${filtered.length} question(s) · ${totalItems} item(s) from ${studentSet.size} student(s)`;

  if (!filtered.length) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="5" style="padding:16px;color:var(--muted);">No improve items found.</td></tr>';
    _renderImproveInsights([]);
    return;
  }

  const subjNames = {civil:'Civil Law',criminal:'Criminal Law',political:'Political Law',labor:'Labor Law',commercial:'Commercial Law',taxation:'Taxation',remedial:'Remedial Law',ethics:'Legal Ethics'};

  if (tbody) tbody.innerHTML = filtered.map(item => {
    const improveBullets = (item.improvements||[]).map(x => `<li style="margin:2px 0;color:#f5f0e8;">${h(x)}</li>`).join('');
    const missedBullets  = (item.keyMissed||[]).map(x => `<li style="margin:2px 0;color:#f5c6a0;">📚 ${h(x)}</li>`).join('');
    const allBullets = improveBullets + missedBullets;
    return `<tr style="border-bottom:1px solid var(--bdr2);vertical-align:top;">
      <td style="padding:8px 10px;white-space:nowrap;color:var(--text);">${h(item.studentName)}</td>
      <td style="padding:8px 10px;white-space:nowrap;"><span style="background:rgba(184,134,11,.15);color:var(--gold);border-radius:5px;padding:2px 7px;font-size:11px;">${h(subjNames[item.subject]||item.subject)}</span></td>
      <td style="padding:8px 10px;max-width:240px;color:var(--muted);font-size:11px;">${h((item.question||'').slice(0,80))}${item.question?.length>80?'…':''}</td>
      <td style="padding:8px 10px;"><ul style="margin:0;padding-left:16px;font-size:12px;">${allBullets}</ul></td>
      <td style="padding:8px 10px;white-space:nowrap;color:var(--muted);">${item.date?new Date(item.date).toLocaleDateString('en-CA',{timeZone:'Asia/Manila'}):'—'}</td>
    </tr>`;
  }).join('');

  _renderImproveInsights(filtered);
}

function _renderImproveInsights(filtered) {
  const panel = document.getElementById('improveInsights');
  const list  = document.getElementById('improveInsightsList');
  if (!panel || !list) return;

  // Count frequency of each unique improve item (normalize to lowercase for grouping)
  const freq = {};
  filtered.forEach(item => {
    [...(item.improvements||[]), ...(item.keyMissed||[])].forEach(txt => {
      const key = txt.trim().toLowerCase();
      if (!key) return;
      freq[key] = freq[key] || { text: txt.trim(), count: 0 };
      freq[key].count++;
    });
  });

  const ranked = Object.values(freq).sort((a, b) => b.count - a.count).slice(0, 10);
  if (!ranked.length) { panel.style.display = 'none'; return; }

  panel.style.display = 'block';
  const maxCount = ranked[0].count;
  list.innerHTML = ranked.map((item, i) => {
    const barW = Math.max(4, Math.round(item.count / maxCount * 100));
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
    return `<div style="margin-bottom:10px;">
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:3px;">
        <span style="font-size:13px;min-width:28px;">${medal}</span>
        <span style="font-size:12px;color:var(--text);flex:1;">${h(item.text)}</span>
        <span style="font-size:12px;font-weight:700;color:var(--gold);min-width:32px;text-align:right;">${item.count}×</span>
      </div>
      <div style="height:5px;background:rgba(var(--ovl),.07);border-radius:3px;margin-left:36px;">
        <div style="height:100%;width:${barW}%;background:var(--gold);border-radius:3px;transition:width .3s;"></div>
      </div>
    </div>`;
  }).join('');
}

async function exportImproveCSV() {
  const filtered = _improveFiltered();
  const lines = ['student_name,subject,question,improve_item,type,date'];
  filtered.forEach(item => {
    const row = (type, text) => {
      const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
      lines.push([esc(item.studentName), esc(item.subject), esc(item.question), esc(text), esc(type), esc(item.date?item.date.slice(0,10):'')].join(','));
    };
    (item.improvements||[]).forEach(t => row('improve', t));
    (item.keyMissed   ||[]).forEach(t => row('missed',  t));
  });
  const blob = new Blob([lines.join('\n')], { type:'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'barbuddy_improve_items.csv'; a.click();
}

// ── CHANGE PASSWORD ──────────────────────────────────────────
function openChangePassword() {
  ['cp-current','cp-new','cp-confirm'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const errEl  = document.getElementById('cp-error');
  const succEl = document.getElementById('cp-success');
  if (errEl)  { errEl.style.display  = 'none'; errEl.textContent = ''; }
  if (succEl) { succEl.style.display = 'none'; }
  document.getElementById('cpOverlay').classList.add('on');
  setTimeout(() => document.getElementById('cp-current')?.focus(), 80);
}

async function submitChangePassword() {
  const current = document.getElementById('cp-current').value;
  const newPass = document.getElementById('cp-new').value;
  const confirm = document.getElementById('cp-confirm').value;
  const errEl   = document.getElementById('cp-error');
  const succEl  = document.getElementById('cp-success');
  const btn     = document.getElementById('cp-submit-btn');

  errEl.style.display = 'none'; succEl.style.display = 'none';

  if (!current || !newPass || !confirm) {
    errEl.textContent = 'All fields are required.'; errEl.style.display = 'block'; return;
  }
  if (newPass.length < 8) {
    errEl.textContent = 'New password must be at least 8 characters.'; errEl.style.display = 'block'; return;
  }
  if (newPass !== confirm) {
    errEl.textContent = 'New passwords do not match.'; errEl.style.display = 'block';
    document.getElementById('cp-confirm').focus(); return;
  }
  if (newPass === current) {
    errEl.textContent = 'New password must be different from current password.'; errEl.style.display = 'block'; return;
  }

  btn.disabled = true; btn.textContent = 'Changing…';
  try {
    const res  = await fetch('/api/user/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-token': sessionToken || '' },
      body: JSON.stringify({ currentPassword: current, newPassword: newPass }),
    });
    const data = await res.json();
    if (res.ok && data.success) {
      succEl.style.display = 'block';
      ['cp-current','cp-new','cp-confirm'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      setTimeout(() => closeModal('cpOverlay'), 2000);
    } else {
      errEl.textContent = data.error || 'Failed to change password.'; errEl.style.display = 'block';
    }
  } catch(e) {
    errEl.textContent = 'Network error. Please try again.'; errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = '🔒 Change Password';
  }
}

// Submit on Enter key while modal is open
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('cpOverlay')?.classList.contains('on')) {
    submitChangePassword();
  }
});

// Close on backdrop click
document.getElementById('cpOverlay')?.addEventListener('click', e => {
  if (e.target.id === 'cpOverlay') closeModal('cpOverlay');
});

// ══════════════════════════════════════════════════════════════
// MOCK BAR — Q-MARKER RENDERER (flag-aware)
// ══════════════════════════════════════════════════════════════
function renderQMarkers() {
  const el = document.getElementById('qMarkers');
  if (!el) return;
  el.innerHTML = mockQs.map((_,i) => {
    const flagged = window.flaggedQuestions?.has(i);
    const done    = mockAnswers[i]?.trim();
    const current = i === mockIdx;
    const cls = 'q-marker'+(done?' done':'')+(current?' current':'')+(flagged?' flagged':'');
    return `<div class="${cls}" id="qm${i}" onclick="jumpMock(${i})">${i+1}${flagged?'<span style="font-size:8px;margin-left:1px;">🚩</span>':''}</div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════
// FEATURE 1 — TEXT HIGHLIGHTING
// ══════════════════════════════════════════════════════════════
(function initHighlighting() {
  // Show toolbar on text selection within exam-content
  document.addEventListener('mouseup', (e) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      hideHighlightToolbar(); return;
    }
    const examContent = document.getElementById('exam-content');
    if (!examContent?.contains(selection.anchorNode)) {
      hideHighlightToolbar(); return;
    }
    const range = selection.getRangeAt(0);
    const rect  = range.getBoundingClientRect();
    const toolbar = document.getElementById('highlight-toolbar');
    if (!toolbar) return;
    toolbar.style.display = 'flex';
    toolbar.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 230) + 'px';
    toolbar.style.top  = (rect.top + window.scrollY - 48) + 'px';
    document.getElementById('hl-remove-btn').style.display = 'none';
    window._pendingSelection = range.cloneRange();
  });

  // Color button clicks
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.hl-color-btn');
    if (!btn) return;
    e.stopPropagation();
    applyHighlight(btn.dataset.color);
    hideHighlightToolbar();
  });

  // Remove button click
  document.getElementById('hl-remove-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window._highlightToRemove) {
      const hl = window._highlightToRemove;
      hl.outerHTML = hl.innerHTML;
      window._highlightToRemove = null;
      saveHighlightsForCurrentQuestion();
    }
    hideHighlightToolbar();
  });

  // Hide toolbar on mousedown outside it
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#highlight-toolbar')) hideHighlightToolbar();
  });

  // Right-click on existing highlight to show remove option
  document.addEventListener('contextmenu', (e) => {
    const hl = e.target.closest('.exam-highlight');
    if (!hl) return;
    e.preventDefault();
    const rect = hl.getBoundingClientRect();
    const toolbar = document.getElementById('highlight-toolbar');
    if (!toolbar) return;
    toolbar.style.display = 'flex';
    toolbar.style.left = Math.min(rect.left + window.scrollX, window.innerWidth - 230) + 'px';
    toolbar.style.top  = (rect.top + window.scrollY - 48) + 'px';
    document.getElementById('hl-remove-btn').style.display = 'inline-block';
    window._highlightToRemove = hl;
    window._pendingSelection = null;
  });
})();

function applyHighlight(color) {
  const range = window._pendingSelection;
  if (!range) return;
  const span = document.createElement('span');
  span.className = 'exam-highlight';
  span.dataset.color = color;
  span.style.backgroundColor = color;
  span.style.color = '#111';
  span.title = 'Right-click to remove';
  try {
    range.surroundContents(span);
  } catch(e) {
    // Partial selection across nodes — extract and wrap
    const fragment = range.extractContents();
    span.appendChild(fragment);
    range.insertNode(span);
  }
  saveHighlightsForCurrentQuestion();
  window._pendingSelection = null;
  window.getSelection()?.removeAllRanges();
}

function hideHighlightToolbar() {
  const t = document.getElementById('highlight-toolbar');
  if (t) t.style.display = 'none';
}

function saveHighlightsForCurrentQuestion() {
  const container = document.getElementById('exam-content');
  if (!container) return;
  if (!window.examHighlights) window.examHighlights = {};
  window.examHighlights[mockIdx] = container.innerHTML;
  if (window.activeExamSession) {
    window.activeExamSession.highlights = window.examHighlights;
    ExamSession.saveLocal(window.activeExamSession);
  }
}

function restoreHighlightsForQuestion(idx) {
  if (!window.examHighlights?.[idx]) return;
  const container = document.getElementById('exam-content');
  if (!container) return;
  container.innerHTML = window.examHighlights[idx];
}

// ══════════════════════════════════════════════════════════════
// FEATURE 2 — FLAG QUESTION FOR REVIEW
// ══════════════════════════════════════════════════════════════
function toggleFlagQuestion() {
  const idx = mockIdx;
  if (!window.flaggedQuestions) window.flaggedQuestions = new Set();
  if (window.flaggedQuestions.has(idx)) {
    window.flaggedQuestions.delete(idx);
  } else {
    window.flaggedQuestions.add(idx);
  }
  updateFlagButton(idx);
  // Update just this marker without full re-render
  const marker = document.getElementById('qm' + idx);
  if (marker) {
    const flagged = window.flaggedQuestions.has(idx);
    const done    = mockAnswers[idx]?.trim();
    marker.className = 'q-marker'+(done?' done':'')+(idx===mockIdx?' current':'')+(flagged?' flagged':'');
    marker.innerHTML = (idx+1)+(flagged?'<span style="font-size:8px;margin-left:1px;">🚩</span>':'');
  }
  if (window.activeExamSession) {
    window.activeExamSession.flagged = Array.from(window.flaggedQuestions);
    ExamSession.saveLocal(window.activeExamSession);
  }
}

function updateFlagButton(idx) {
  const btn = document.getElementById('flag-btn');
  if (!btn) return;
  const isFlagged = window.flaggedQuestions?.has(idx);
  if (isFlagged) {
    btn.style.background   = 'rgba(249,115,22,0.15)';
    btn.style.color        = '#fb923c';
    btn.style.borderColor  = 'rgba(249,115,22,0.4)';
    btn.innerHTML = '🚩 Flagged';
  } else {
    btn.style.background   = 'transparent';
    btn.style.color        = '#888';
    btn.style.borderColor  = '#2a3347';
    btn.innerHTML = '🚩 Flag';
  }
}

function showSubmitConfirmModal(onConfirm) {
  const answered = mockAnswers.filter(a => a?.trim()).length;
  const total = mockQs.length;
  const unanswered = total - answered;
  const isSD = window.isSpeedDrill;
  const title = isSD ? 'Submit Speed Drill?' : 'Submit for Evaluation?';
  const overlay = document.createElement('div');
  overlay.id = 'submit-confirm-modal';
  overlay.innerHTML = `
  <div style="position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10001;display:flex;align-items:center;justify-content:center;padding:20px;">
    <div style="background:#0f1923;border:1px solid rgba(201,168,76,0.3);border-radius:16px;padding:32px;max-width:400px;width:90%;text-align:center;">
      <div style="font-size:32px;margin-bottom:16px;">⚖️</div>
      <h3 style="color:var(--amber);margin:0 0 12px;font-size:18px;">${title}</h3>
      <p style="color:#e0dcd4;margin:0 0 8px;font-size:14px;">✅ Answered: ${answered}/${total} question${total!==1?'s':''}</p>
      ${unanswered > 0 ? `<p style="color:#ff9800;font-size:13px;margin:0 0 16px;">⚠️ ${unanswered} unanswered — will be scored 0</p>` : '<div style="margin-bottom:16px;"></div>'}
      <p style="color:#888;font-size:12px;margin:0 0 24px;">This action cannot be undone.</p>
      <div style="display:flex;gap:12px;justify-content:center;">
        <button onclick="document.getElementById('submit-confirm-modal')?.remove();" style="flex:1;padding:12px 20px;border-radius:10px;border:1px solid rgba(var(--ovl),0.2);background:transparent;color:#ccd;cursor:pointer;font-size:14px;">Cancel</button>
        <button id="confirmSubmitYes" style="flex:1;padding:12px 20px;border-radius:10px;border:none;background:linear-gradient(135deg,var(--amber),#d4a017);color:#1a1200;cursor:pointer;font-size:14px;font-weight:bold;">Yes, Submit</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  document.getElementById('confirmSubmitYes').onclick = () => { overlay.remove(); onConfirm(); };
}

function checkFlaggedBeforeSubmit() {
  const flagged = window.flaggedQuestions;
  if (!flagged || flagged.size === 0) { showSubmitConfirmModal(() => endMockSession()); return; }
  const flaggedList = Array.from(flagged).sort((a,b) => a-b);
  const modal = document.createElement('div');
  modal.id = 'flagged-review-modal';
  modal.innerHTML = `
  <div style="position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;">
    <div style="background:#0f1923;border:1px solid #2a3347;border-radius:16px;padding:28px;max-width:480px;width:100%;max-height:80vh;overflow-y:auto;">
      <h3 style="color:var(--amber);font-size:1.2rem;margin:0 0 6px;">🚩 Flagged Questions</h3>
      <p style="color:#888;font-size:0.85rem;margin:0 0 20px;">You flagged ${flagged.size} question${flagged.size>1?'s':''} for review. Jump to any before submitting.</p>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:24px;">
        ${flaggedList.map(idx => {
          const q = mockQs[idx];
          const answered = mockAnswers[idx]?.trim()?.length > 0;
          const qText = (q?.prompt || q?.q || 'Question '+(idx+1)).slice(0,80);
          return `<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:#1a2235;border-radius:10px;border:1px solid #2a3347;cursor:pointer;" onclick="goToFlaggedQuestion(${idx})">
            <div style="width:32px;height:32px;border-radius:8px;background:rgba(249,115,22,0.15);border:1px solid #fb923c;color:#fb923c;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.85rem;flex-shrink:0;">${idx+1}</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:0.85rem;color:#ccd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${h(qText)}…</div>
              <div style="font-size:0.75rem;margin-top:2px;color:${answered?'#4caf50':'#f87171'};">${answered?'✅ Answered':'⚠️ Not answered'}</div>
            </div>
            <span style="color:#888;font-size:1.2rem;">→</span>
          </div>`;
        }).join('')}
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button onclick="document.getElementById('flagged-review-modal')?.remove();showSubmitConfirmModal(()=>endMockSession());" style="flex:1;padding:12px;background:linear-gradient(135deg,var(--amber),#d4a017);color:#1a1200;border:none;border-radius:10px;font-weight:700;cursor:pointer;font-size:0.9rem;">Submit Anyway</button>
        <button onclick="document.getElementById('flagged-review-modal')?.remove();" style="flex:1;padding:12px;background:#1a2235;color:#ccd;border:1px solid #2a3347;border-radius:10px;font-weight:600;cursor:pointer;font-size:0.9rem;">Continue Reviewing</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(modal);
}

function goToFlaggedQuestion(idx) {
  document.getElementById('flagged-review-modal')?.remove();
  saveMock();
  mockIdx = idx;
  renderMockQ();
}

// ══════════════════════════════════
// XP POPUP & LEVEL UP MODAL
// ══════════════════════════════════

function showXPPopup(xpResult, onContinue) {
  const { xpEarned, highScoreCount, highScoreBonus, newLevel, newXP, progressPercent, xpToNextLevel } = xpResult;
  const sessionBase = xpEarned - (highScoreBonus || 0);

  // The session just changed XP, results and spaced-repetition state. Drop the
  // caches so Progress/XP don't serve pre-session numbers, and repaint the
  // sidebar bar + topbar level badge, which previously stayed stale until the
  // next full page load.
  invalidateProgressCaches();
  refreshSidebarXP(true).catch(() => {});

  const lines = [];
  if (sessionBase > 0)       lines.push({ label: 'Session Complete', value: sessionBase });
  if (highScoreCount > 0)    lines.push({ label: `${highScoreCount}× High Score (×${XP_CLIENT.HIGH_SCORE_BONUS})`, value: highScoreBonus });

  const overlay = document.createElement('div');
  overlay.className = 'xp-popup-overlay';
  overlay.id = 'xpPopupOverlay';
  overlay.innerHTML = `
    <div class="xp-popup">
      <div class="xp-popup-title">✨ XP Earned!</div>
      ${lines.map((l, i) => `
        <div class="xp-line-item" id="xp-line-${i}">
          <span class="xp-line-label">${h(l.label)}</span>
          <span class="xp-line-value">+${l.value} XP</span>
        </div>`).join('')}
      <div class="xp-line-divider"></div>
      <div class="xp-line-total" id="xp-line-total">
        <span>Total</span>
        <span class="xp-line-value">+${xpEarned} XP</span>
      </div>
      <div class="xp-popup-bar-wrap">
        <div class="xp-popup-bar-label">
          <span>Level ${newLevel}</span>
          <span>${progressPercent}% · ${xpToNextLevel > 0 ? xpToNextLevel.toLocaleString() + ' XP to next level' : 'Max level!'}</span>
        </div>
        <div class="xp-popup-bar-track">
          <div class="xp-popup-bar-fill" id="xpPopupBarFill"></div>
        </div>
      </div>
      <button class="btn-view-results" id="xpPopupContinueBtn">View Results →</button>
    </div>`;
  document.body.appendChild(overlay);

  // Stagger-animate line items
  lines.forEach((_, i) => {
    setTimeout(() => {
      document.getElementById(`xp-line-${i}`)?.classList.add('visible');
    }, 200 + i * 250);
  });
  setTimeout(() => {
    document.getElementById('xp-line-total')?.classList.add('visible');
  }, 200 + lines.length * 250);
  // Animate XP bar
  setTimeout(() => {
    const fill = document.getElementById('xpPopupBarFill');
    if (fill) fill.style.width = progressPercent + '%';
  }, 300 + lines.length * 250);

  document.getElementById('xpPopupContinueBtn').onclick = () => {
    overlay.remove();
    if (xpResult.leveledUp || xpResult.titleChanged) {
      showLevelUpModal(xpResult, onContinue);
    } else {
      onContinue();
    }
  };
}

function showLevelUpModal(xpResult, onContinue) {
  const { oldLevel, newLevel, oldTitle, newTitle, titleChanged, progressPercent } = xpResult;
  const overlay = document.createElement('div');
  overlay.className = 'lvlup-overlay';
  overlay.id = 'lvlupOverlay';

  if (titleChanged) {
    overlay.innerHTML = `
      <div class="lvlup-modal">
        <div class="lvlup-icon">⭐</div>
        <div class="lvlup-heading">NEW TITLE UNLOCKED!</div>
        <div class="lvlup-sub">You are now a…</div>
        <div class="lvlup-new-title">${h(newTitle).toUpperCase()}</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:22px;">(was ${h(oldTitle)})</div>
        <button class="lvlup-btn" onclick="document.getElementById('lvlupOverlay').remove();${onContinue ? '(window._lvlupCb&&window._lvlupCb())' : ''}">Continue</button>
      </div>`;
  } else {
    overlay.innerHTML = `
      <div class="lvlup-modal">
        <div class="lvlup-icon">🎉</div>
        <div class="lvlup-heading">LEVEL UP!</div>
        <div class="lvlup-arrow">Level ${oldLevel} → Level ${newLevel}</div>
        <div class="lvlup-new-title">${h(newTitle)}</div>
        <div class="lvlup-bar-wrap">
          <div class="lvlup-bar-track"><div class="lvlup-bar-fill" id="lvlupBarFill"></div></div>
        </div>
        <button class="lvlup-btn" onclick="document.getElementById('lvlupOverlay').remove();${onContinue ? '(window._lvlupCb&&window._lvlupCb())' : ''}">Continue</button>
      </div>`;
  }
  document.body.appendChild(overlay);
  window._lvlupCb = onContinue;

  // Animate bar
  setTimeout(() => {
    const fill = document.getElementById('lvlupBarFill');
    if (fill) fill.style.width = progressPercent + '%';
  }, 500);
}
