const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

async function run() {
  console.log('Reading kb.json from Railway volume...')
  
  const raw = fs.readFileSync(
    '/data/uploads/kb.json', 'utf8')
  const kb = JSON.parse(raw)
  
  console.log('Past bar items:', 
    kb.pastBar?.length || 0)
  console.log('Subjects:', 
    [...new Set((kb.pastBar||[])
      .map(pb => pb.subject))].join(', '))
  
  // Migrate past bar
  for (const pb of (kb.pastBar || [])) {
    const { error } = await supabase
      .from('past_bar')
      .upsert([{
        id: pb.id,
        name: pb.name,
        subject: pb.subject,
        year: pb.year || 'Unknown',
        source: pb.source || 'upload',
        questions: pb.questions || [],
        q_count: pb.questions?.length || 0,
        uploaded_at: pb.uploadedAt || 
          new Date().toISOString()
      }], { onConflict: 'id' })
    
    if (error) {
      console.error('Error:', pb.name, error.message)
    } else {
      console.log('✓ PastBar:', pb.name, 
        '|', pb.subject, 
        '|', pb.questions?.length + 'q')
    }
  }
  
  // Migrate syllabus
  const subjects = kb.syllabus?.subjects || {}
  for (const [subj, data] of 
      Object.entries(subjects)) {
    const { error } = await supabase
      .from('syllabus')
      .upsert([{
        subject: subj,
        sections: data.sections || [],
        updated_at: new Date().toISOString()
      }], { onConflict: 'subject' })
    
    if (error) {
      console.error('Syllabus error:', subj, error.message)
    } else {
      console.log('✓ Syllabus:', subj)
    }
  }
  
  // Migrate users
  console.log('\nReading users.json...')
  const usersRaw = fs.readFileSync(
    '/data/uploads/users.json', 'utf8')
  const users = JSON.parse(usersRaw)
  console.log('Users found:', users.length)
  
  for (const u of users) {
    const { error } = await supabase
      .from('users')
      .upsert([{
        id: u.id,
        name: u.name,
        email: (u.email||'').toLowerCase(),
        password_hash: u.passwordHash || 
                       u.password_hash || '',
        is_admin: u.isAdmin || false,
        is_active: u.isActive !== false,
        joined_at: u.joinedAt || 
          new Date().toISOString(),
        tab_settings: u.tabSettings || {},
        progress: u.progress || {},
        mock_bar_count: u.mockBarCount || 0,
        avg_score: u.avgScore || 0
      }], { onConflict: 'id' })
    
    if (error) {
      console.error('User error:', u.name, error.message)
    } else {
      console.log('✓ User:', u.name,
        u.isAdmin ? '(admin)' : '')
    }
  }

  // Migrate results if they exist
  try {
    const resultsRaw = fs.readFileSync(
      '/data/uploads/results.json', 'utf8')
    const results = JSON.parse(resultsRaw)
    console.log('\nMigrating', results.length, 'results...')
    
    for (const r of results) {
      const { error } = await supabase
        .from('results')
        .upsert([{
          id: r.id || 'result_' + Date.now(),
          user_id: r.userId || r.user_id,
          subject: r.subject,
          score: r.score || 0,
          total_questions: r.totalQuestions || 0,
          passed: r.passed || false,
          started_at: r.startedAt || null,
          finished_at: r.finishedAt || 
            new Date().toISOString(),
          questions: r.questions || [],
          answers: r.answers || {},
          evaluations: r.evaluations || [],
          sources: r.sources || []
        }], { onConflict: 'id' })
      
      if (error && !error.message.includes('foreign key')) {
        console.error('Result error:', r.id, error.message)
      } else if (!error) {
        console.log('✓ Result:', r.id)
      }
    }
  } catch(e) {
    console.log('No results.json or error:', e.message)
  }
  
  // Final verification
  const { count: pbCount } = await supabase
    .from('past_bar')
    .select('*', { count: 'exact', head: true })
  const { count: uCount } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
  const { count: sCount } = await supabase
    .from('syllabus')
    .select('*', { count: 'exact', head: true })
    
  console.log('\n════ Migration Complete ════')
  console.log('Past bar in Supabase:', pbCount)
  console.log('Users in Supabase:', uCount)
  console.log('Syllabus subjects:', sCount)
}

run().catch(console.error)
