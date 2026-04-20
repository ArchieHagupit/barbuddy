// Question fetching — extracted from server.js, behavior unchanged.
// Both functions return null when no enabled questions exist (caller falls back to KB).

const { supabase } = require('../config/supabase');
const { mapQRow } = require('./mappers');

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

module.exports = { getQuestionsForSubject, getQuestionsForSubjects };
