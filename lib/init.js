// App initialisation — extracted from server.js, behavior unchanged.
//
// Loads boot state from Supabase:
//   - KB.pastBar, KB.syllabus, KB.references (mutations via passed-in reference)
//   - TAB_SETTINGS (let-reassigned in server.js; setter closure required)
//   - SETTINGS.* (shared object in lib/db-settings; mutated in place)
//   - RESET_REQUESTS (let-reassigned in server.js; setter closure required)
//
// Then runs cleanupSessions() and loadSettingsFromDB() before resolving.
//
// Called once at boot from server.js:
//   require('./lib/init').initializeApp({
//     KB,
//     setTabSettings: (v) => { TAB_SETTINGS = v; },
//     setResetRequests: (v) => { RESET_REQUESTS = v; },
//   }).then(() => { app.listen(...); });

const { supabase } = require('../config/supabase');
const { mapPastBar } = require('./mappers');
const { getAllSubjectsWithSections } = require('./syllabus-tree');
const { SETTINGS, loadSettingsFromDB, getSetting } = require('./db-settings');
const { cleanupSessions } = require('./db-sessions');
const { deepMerge } = require('./deep-merge');
const { DEFAULT_TAB_SETTINGS } = require('./tab-config');

async function initializeApp({ KB, setTabSettings, setResetRequests }) {
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
  if (savedTS) setTabSettings(deepMerge(JSON.parse(JSON.stringify(DEFAULT_TAB_SETTINGS)), savedTS));

  // App settings
  const regOpen   = await getSetting('registration_open');
  const mbPublic  = await getSetting('mock_bar_public');
  const examDate  = await getSetting('bar_exam_date');
  if (regOpen  !== null) SETTINGS.registrationOpen = !!regOpen;
  if (mbPublic !== null) SETTINGS.mockBarPublic    = !!mbPublic;
  if (examDate && typeof examDate === 'string') SETTINGS.barExamDate = examDate;

  // Reset requests
  const rr = await getSetting('reset_requests');
  setResetRequests(Array.isArray(rr) ? rr : []);

  await cleanupSessions();
  await loadSettingsFromDB();

  const totalQ = KB.pastBar.reduce((a, pb) => a + (pb.questions?.length || pb.qCount || 0), 0);
  console.log(`✅ Supabase loaded — ${KB.pastBar.length} past bar batches, ${totalQ} questions, ${KB.references.length} refs`);
}

module.exports = { initializeApp };
