// Settings store — extracted from server.js, behavior unchanged.
// SETTINGS is a SHARED MUTABLE OBJECT; callers mutate it in place.
// Node's require cache ensures all importers see the same reference.

const { supabase } = require('../config/supabase');

// Per CLAUDE.md the bar exam is September 6, 2026.
const SETTINGS = { registrationOpen: true, mockBarPublic: true, barExamDate: '2026-09-06' };

async function loadSettingsFromDB() {
  try {
    const keys = ['registrationOpen', 'mockBarPublic', 'barExamDate'];
    const { data } = await supabase.from('settings').select('key, value').in('key', keys);
    (data || []).forEach(row => {
      if (row.key in SETTINGS) SETTINGS[row.key] = row.value;
    });
    console.log('[settings] Loaded from DB:', SETTINGS);
  } catch (e) {
    console.warn('[settings] Load failed, using defaults:', e.message);
  }
}

async function getSetting(key) {
  const { data } = await supabase.from('settings').select('value').eq('key', key).single();
  return data ? data.value : null;
}

async function saveSetting(key, value) {
  await supabase.from('settings').upsert([{ key, value, updated_at: new Date().toISOString() }], { onConflict: 'key' });
}

module.exports = { SETTINGS, loadSettingsFromDB, getSetting, saveSetting };
