require('dotenv').config()
const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)

function readJSONSafe(paths) {
  for (const p of paths) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'))
      } catch(e) { return null }
    }
  }
  return null
}

async function verify() {
  console.log('═══════════════════════════════')
  console.log('  Migration Verification Report')
  console.log('═══════════════════════════════')

  let allPassed = true

  // ── USERS ──
  const usersJSON = readJSONSafe([
    '/data/uploads/users.json',
    './users.json'
  ])
  const { count: usersDB } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })

  const usersExpected = Array.isArray(usersJSON)
    ? usersJSON.length
    : Object.keys(usersJSON || {}).length
  const usersPass = usersDB >= usersExpected
  console.log(
    `\nUsers:`,
    `JSON=${usersExpected}`,
    `Supabase=${usersDB}`,
    usersPass ? '✅ PASS' : '❌ FAIL')
  if (!usersPass) allPassed = false

  // ── PAST BAR ──
  const kb = readJSONSafe([
    '/data/uploads/kb.json',
    './kb.json'
  ])
  const pastBarExpected =
    (kb?.pastBar?.length || 0) +
    (kb?.manual?.length || 0)
  const { count: pastBarDB } = await supabase
    .from('past_bar')
    .select('*', { count: 'exact', head: true })

  const pastBarPass = pastBarDB >= pastBarExpected
  console.log(
    `\nPast Bar Batches:`,
    `JSON=${pastBarExpected}`,
    `Supabase=${pastBarDB}`,
    pastBarPass ? '✅ PASS' : '❌ FAIL')
  if (!pastBarPass) allPassed = false

  // ── QUESTIONS COUNT ──
  const { data: dbBatches } = await supabase
    .from('past_bar')
    .select('q_count')
  const totalQDB = (dbBatches || [])
    .reduce((a, b) => a + (b.q_count || 0), 0)
  const totalQJSON = (kb?.pastBar || [])
    .reduce((a, pb) => a + (pb.questions?.length || 0), 0)

  const qPass = totalQDB >= totalQJSON
  console.log(
    `\nTotal Questions:`,
    `JSON=${totalQJSON}`,
    `Supabase=${totalQDB}`,
    qPass ? '✅ PASS' : '❌ FAIL')
  if (!qPass) allPassed = false

  // ── SYLLABUS ──
  const subjExpected = Object.keys(
    kb?.syllabus?.subjects || {}).length
  const { count: subjDB } = await supabase
    .from('syllabus')
    .select('*', { count: 'exact', head: true })

  const syllPass = subjDB >= subjExpected
  console.log(
    `\nSyllabus Subjects:`,
    `JSON=${subjExpected}`,
    `Supabase=${subjDB}`,
    syllPass ? '✅ PASS' : '❌ FAIL')
  if (!syllPass) allPassed = false

  // ── SUBJECT BREAKDOWN ──
  const { data: subjBreakdown } = await supabase
    .from('past_bar')
    .select('subject, q_count')

  console.log('\n  Questions per subject in Supabase:')
  const bySubj = {}
  ;(subjBreakdown || []).forEach(row => {
    bySubj[row.subject] =
      (bySubj[row.subject] || 0) + (row.q_count || 0)
  })
  Object.entries(bySubj)
    .sort((a, b) => b[1] - a[1])
    .forEach(([subj, count]) => {
      console.log(`    ${subj}: ${count} questions`)
    })

  // ── FINAL VERDICT ──
  console.log('\n═══════════════════════════════')
  if (allPassed) {
    console.log('  ✅ ALL CHECKS PASSED')
    console.log('  Safe to switch app to Supabase!')
    console.log('\n  Next step: Run the Claude Code')
    console.log('  prompt to update server.js')
  } else {
    console.log('  ❌ SOME CHECKS FAILED')
    console.log('  Run migrate-to-supabase.js again')
    console.log('  before switching to Supabase.')
  }
  console.log('═══════════════════════════════')
}

verify().catch(e => {
  console.error('Fatal error:', e)
  process.exit(1)
})
