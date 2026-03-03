require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

// ── FIND FILE HELPER ──
function findFile(candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const size = fs.statSync(p).size
      console.log(`  ✓ Found: ${p} (${size} bytes)`)
      return p
    } else {
      console.log(`  ✗ Not found: ${p}`)
    }
  }
  return null
}

// ── READ JSON HELPER ──
function readJSON(candidates, label) {
  console.log(`\nLooking for ${label}...`)
  const p = findFile(candidates)
  if (!p) {
    console.log(`  ⚠ ${label} not found`)
    return null
  }
  try {
    const raw = fs.readFileSync(p, 'utf8')
    if (!raw || raw.trim() === '') {
      console.log(`  ⚠ ${label} is empty`)
      return null
    }
    const data = JSON.parse(raw)
    console.log(`  ✓ Parsed ${label} successfully`)
    return data
  } catch(e) {
    console.error(`  ✗ Failed to parse ${label}:`, e.message)
    return null
  }
}

async function migrate() {
  console.log('═══════════════════════════════')
  console.log('  BarBuddy → Supabase Migration')
  console.log('═══════════════════════════════')

  // Test Supabase connection first
  console.log('\nTesting Supabase connection...')
  try {
    const { error } = await supabase
      .from('users')
      .select('id')
      .limit(1)
    if (error) throw error
    console.log('  ✓ Supabase connected')
  } catch(e) {
    console.error('  ✗ Supabase connection failed:', e.message)
    console.error('  Check SUPABASE_URL and SUPABASE_SERVICE_KEY')
    process.exit(1)
  }

  let totalMigrated = 0
  let totalErrors = 0

  // ══════════════════════════════════
  // MIGRATE USERS
  // ══════════════════════════════════
  const usersData = readJSON([
    '/data/uploads/users.json',
    '/data/users.json',
    './uploads/users.json',
    './users.json'
  ], 'users.json')

  if (usersData) {
    const users = Array.isArray(usersData)
      ? usersData
      : Object.values(usersData)

    console.log(`\nMigrating ${users.length} users...`)

    for (const u of users) {
      try {
        const { error } = await supabase
          .from('users')
          .upsert([{
            id: u.id,
            name: u.name,
            email: (u.email || '').toLowerCase().trim(),
            password_hash: u.passwordHash ||
              u.password_hash || '',
            is_admin: u.isAdmin ||
              u.is_admin || false,
            is_active: u.isActive !== false &&
              u.is_active !== false,
            joined_at: u.joinedAt ||
              u.joined_at ||
              new Date().toISOString(),
            tab_settings: u.tabSettings ||
              u.tab_settings || {},
            progress: u.progress || {},
            active_exam_session:
              u.activeExamSession ||
              u.active_exam_session || null,
            mock_bar_count: u.mockBarCount ||
              u.mock_bar_count || 0,
            avg_score: u.avgScore ||
              u.avg_score || 0
          }], { onConflict: 'id' })

        if (error) throw error
        console.log(`  ✓ User: ${u.name}`,
          u.isAdmin || u.is_admin ? '👑 admin' : '')
        totalMigrated++
      } catch(e) {
        console.error(`  ✗ User ${u.name}:`, e.message)
        totalErrors++
      }
    }
  }

  // ══════════════════════════════════
  // MIGRATE PAST BAR QUESTIONS
  // ══════════════════════════════════
  const kb = readJSON([
    '/data/uploads/kb.json',
    '/data/kb.json',
    './uploads/kb.json',
    './kb.json'
  ], 'kb.json')

  if (kb) {
    // Combine pastBar and manual arrays
    const pastBar = [
      ...(kb.pastBar || []),
      ...(kb.manual || []).filter(m =>
        !(kb.pastBar || []).find(pb => pb.id === m.id)
      )
    ]

    console.log(`\nMigrating ${pastBar.length} past bar batches...`)

    for (const pb of pastBar) {
      try {
        const qCount = pb.questions?.length ||
          pb.qCount || pb.q_count || 0

        const { error } = await supabase
          .from('past_bar')
          .upsert([{
            id: pb.id,
            name: pb.name,
            subject: pb.subject,
            year: pb.year || 'Unknown',
            source: pb.source || 'upload',
            questions: pb.questions || [],
            q_count: qCount,
            uploaded_at: pb.uploadedAt ||
              pb.uploaded_at ||
              new Date().toISOString()
          }], { onConflict: 'id' })

        if (error) throw error
        console.log(
          `  ✓ ${pb.name}`,
          `| ${pb.subject}`,
          `| ${qCount} questions`)
        totalMigrated++
      } catch(e) {
        console.error(`  ✗ PastBar ${pb.name}:`, e.message)
        totalErrors++
      }
    }

    // ══════════════════════════════
    // MIGRATE SYLLABUS
    // ══════════════════════════════
    const subjects = kb.syllabus?.subjects || {}
    const subjKeys = Object.keys(subjects)

    if (subjKeys.length > 0) {
      console.log(`\nMigrating syllabus for ${subjKeys.length} subjects...`)

      for (const subj of subjKeys) {
        try {
          const sections = subjects[subj]?.sections || []
          const { error } = await supabase
            .from('syllabus')
            .upsert([{
              subject: subj,
              sections: sections,
              updated_at: new Date().toISOString()
            }], { onConflict: 'subject' })

          if (error) throw error
          console.log(`  ✓ Syllabus: ${subj} (${sections.length} sections)`)
          totalMigrated++
        } catch(e) {
          console.error(`  ✗ Syllabus ${subj}:`, e.message)
          totalErrors++
        }
      }
    } else {
      console.log('\nNo syllabus data found')
    }

    // ══════════════════════════════
    // MIGRATE GLOBAL TAB SETTINGS
    // ══════════════════════════════
    const tabSettings = kb.tabSettings || kb.tab_settings
    if (tabSettings) {
      try {
        await supabase
          .from('settings')
          .upsert([{
            key: 'tab_settings',
            value: tabSettings,
            updated_at: new Date().toISOString()
          }], { onConflict: 'key' })
        console.log('\n  ✓ Tab settings migrated')
        totalMigrated++
      } catch(e) {
        console.error('  ✗ Tab settings:', e.message)
      }
    }
  }

  // ══════════════════════════════════
  // MIGRATE RESULTS
  // ══════════════════════════════════
  const resultsData = readJSON([
    '/data/uploads/results.json',
    '/data/results.json',
    './uploads/results.json',
    './results.json'
  ], 'results.json')

  if (resultsData) {
    const results = Array.isArray(resultsData)
      ? resultsData
      : Object.values(resultsData)

    console.log(`\nMigrating ${results.length} results...`)

    for (const r of results) {
      try {
        const { error } = await supabase
          .from('results')
          .upsert([{
            id: r.id ||
              'result_' + Date.now() +
              '_' + Math.random().toString(36).slice(2),
            user_id: r.userId || r.user_id,
            subject: r.subject,
            score: r.score || r.totalScore || 0,
            total_questions: r.totalQuestions ||
              r.total_questions || 0,
            passed: r.passed || false,
            started_at: r.startedAt ||
              r.started_at || null,
            finished_at: r.finishedAt ||
              r.finished_at ||
              r.submittedAt ||
              new Date().toISOString(),
            questions: r.questions || [],
            answers: r.answers || {},
            evaluations: r.evaluations || [],
            sources: r.sources || []
          }], { onConflict: 'id' })

        if (error) {
          // Skip orphaned results (user was deleted)
          if (error.message.includes('foreign key')) {
            console.log(`  ⚠ Skipped result (user not found): ${r.id}`)
          } else {
            throw error
          }
        } else {
          console.log(`  ✓ Result: ${r.id} score: ${r.score || 0}`)
          totalMigrated++
        }
      } catch(e) {
        console.error(`  ✗ Result ${r.id}:`, e.message)
        totalErrors++
      }
    }
  }

  // ══════════════════════════════════
  // FINAL SUMMARY
  // ══════════════════════════════════
  console.log('\n═══════════════════════════════')
  console.log('  Migration Summary')
  console.log('═══════════════════════════════')
  console.log(`  ✓ Migrated: ${totalMigrated} items`)
  console.log(`  ✗ Errors:   ${totalErrors} items`)

  // Count rows in Supabase
  const tables = [
    { name: 'users',    label: 'Users' },
    { name: 'past_bar', label: 'Past bar batches' },
    { name: 'syllabus', label: 'Syllabus subjects' },
    { name: 'results',  label: 'Results' },
    { name: 'settings', label: 'Settings' }
  ]

  console.log('\n  Supabase row counts:')
  for (const t of tables) {
    const { count } = await supabase
      .from(t.name)
      .select('*', { count: 'exact', head: true })
    console.log(`  ${t.label}: ${count || 0}`)
  }

  if (totalErrors === 0) {
    console.log('\n  ✅ Migration completed successfully!')
    console.log('  Ready for Phase 2 — verify,')
    console.log('  then switch app to Supabase.')
  } else {
    console.log('\n  ⚠ Migration completed with errors.')
    console.log('  Fix errors before switching app to Supabase.')
  }
}

migrate().catch(e => {
  console.error('Fatal error:', e)
  process.exit(1)
})
