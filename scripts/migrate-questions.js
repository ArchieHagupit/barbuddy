require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function migrate() {
  console.log('Fetching all past_bar rows...');
  const { data: batches, error: fetchErr } = await supabase
    .from('past_bar')
    .select('id, subject, year, source, questions');

  if (fetchErr) {
    console.error('Failed to fetch past_bar:', fetchErr.message);
    process.exit(1);
  }

  console.log(`Found ${batches.length} batches.\n`);

  let total = 0;
  let skipped = 0;

  for (const batch of batches) {
    if (!Array.isArray(batch.questions) || batch.questions.length === 0) {
      console.log(`Batch ${batch.id}: no questions, skipping`);
      skipped++;
      continue;
    }

    const rows = batch.questions.map((q, i) => ({
      id: `q_${batch.id}_${i}`,
      batch_id: batch.id,
      subject: q.subject || batch.subject || '',
      year: q.year || batch.year || '',
      source: q.source || batch.source || '',
      type: q.type || 'essay',
      question_text: q.q || q.question || q.question_text || '',
      context: q.context || q.facts || null,
      model_answer: q.modelAnswer || q.answer || q.model_answer || null,
      key_points: q.keyPoints || q.key_points || null,
      max_score: q.max || q.maxScore || q.max_score || 10,
    }));

    const { error } = await supabase
      .from('questions')
      .upsert(rows, { onConflict: 'id' });

    if (error) {
      console.error(`Batch ${batch.id}: ERROR — ${error.message}`);
    } else {
      total += rows.length;
      console.log(`Batch ${batch.id}: ${rows.length} questions (subject: ${batch.subject}, year: ${batch.year})`);
    }
  }

  console.log(`\nSkipped ${skipped} batches with no questions.`);

  // Print final count from questions table
  const { count, error: countErr } = await supabase
    .from('questions')
    .select('*', { count: 'exact', head: true });

  if (countErr) {
    console.error('Could not fetch final count:', countErr.message);
  } else {
    console.log(`\nMigration complete. Inserted/updated ${total} questions this run.`);
    console.log(`Total questions in DB: ${count}`);
  }
}

migrate().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
