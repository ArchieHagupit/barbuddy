// Syllabus + past-bar DB helpers — extracted from server.js, behavior unchanged.

const { supabase } = require('../config/supabase');

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

  const rows = questions.map((q, i) => ({
    id:            `q_${batch.id}_${i}`,
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
  }));

  // Single batch upsert — one round-trip instead of N.
  const { error } = await supabase.from('questions').upsert(rows, { onConflict: 'id' });
  if (error) {
    console.error(`[syncQuestions] Batch ${batch.id} upsert failed:`, error.message);
    throw error;
  }

  console.log(`Synced ${rows.length} questions from ${batch.name}`);
}

async function deletePastBarEntry(id) {
  await supabase.from('past_bar').delete().eq('id', id);
}

module.exports = { saveSyllabusSubject, savePastBarEntry, syncQuestionsFromBatch, deletePastBarEntry };
