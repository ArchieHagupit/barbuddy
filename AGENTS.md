# AGENTS.md — BarBuddy Development Agent Instructions

## First Steps on Every Task
1. Read CLAUDE.md for full project context
2. Identify affected files before making changes
3. Run grep to find relevant code before editing
4. Never assume — always read the actual code first

## Project Files
- Backend: server.js (single file, all API routes)
- Frontend: public/index.html (single file, all CSS/JS/HTML)
- Static assets: public/ folder
- Context: CLAUDE.md (architecture + known fixes)

---

## Git Workflow — ALWAYS FOLLOW THIS

### Branch Rules
- NEVER commit directly to main
- ALWAYS work on uat branch
- ALWAYS test on uat before merging to main

### Standard Commit Flow
  git add .
  git commit -m "fix: [description]"
  git push origin uat
  # Test thoroughly on uat
  git checkout main
  git merge uat
  git push origin main
  git checkout uat

### Commit Message Format
  feat: add new feature
  fix: fix specific bug
  perf: performance improvement
  style: UI/CSS changes only
  refactor: code restructure no behavior change
  chore: dependencies, config changes

### Never Do
- Never force push to main (git push --force main)
- Never merge untested code to main
- Never commit .env files or API keys
- Never commit node_modules

---

## Code Rules

### Scoring — CRITICAL
- ALWAYS recompute score from components
- NEVER use AI-returned numericScore directly
- ALAC: answer + legalBasis + application + conclusion
- Conceptual: accuracy + completeness + clarity
- Apply this in ALL places: display, save, XP, SR mastery

### AI API Calls
- Evaluation calls: temperature: 0 (deterministic)
- Generation calls: no temperature set (default)
- Evaluation maxTokens: minimum 2000
- Always use extractJSON() for parsing — never raw JSON.parse()
- callClaudeHaikuJSON → batch evaluation only
- callClaudeJSON → single question + Sonnet fallback

### Supabase
- Always use service role key on server (bypasses RLS)
- Never use anon key on server side
- RLS is enabled on all 8 tables
- Always check for column existence before using
- Timestamps stored in UTC, displayed in Asia/Manila (UTC+8)

### Environment Variables
- All secrets in Railway Variables only
- Never hardcode keys in code
- Never log API keys or tokens
- Key names: ANTHROPIC_API_KEY, SUPABASE_URL,
  SUPABASE_SERVICE_KEY, RESEND_API_KEY,
  ADMIN_KEY, ADMIN_EMAIL, APP_URL

---

## Before Making Any Change

### For server.js changes
  grep -n "relevant_function_name" server.js
  # Read surrounding context before editing

### For public/index.html changes
  grep -n "relevant_function_name" public/index.html
  # Read surrounding context before editing

### For database changes
  # Always use IF NOT EXISTS
  ALTER TABLE x ADD COLUMN IF NOT EXISTS ...
  CREATE INDEX IF NOT EXISTS ...
  # Never DROP columns without explicit instruction

---

## Testing Checklist Before Merging to Main

### Core Evaluation Pipeline
- [ ] Submit 5-question Mock Bar with real answers
- [ ] All questions evaluate without "temporarily unavailable"
- [ ] Results screen loads correctly
- [ ] Scores computed from components (not AI total)
- [ ] XP awarded AFTER evaluation completes
- [ ] Results saved to Supabase (evaluations column populated)

### Railway Logs Check
- [ ] No 500 errors
- [ ] No [extractJSON] All strategies failed
- [ ] No [evaluate-batch] Q failed
- [ ] PATCH /api/results returns 200
- [ ] GET /api/eval-results returns 200

### UI Check
- [ ] Login works
- [ ] Sidebar subjects load
- [ ] Mock Bar starts correctly
- [ ] Speed Drill starts correctly
- [ ] My Progress loads
- [ ] Admin panel accessible

---

## Known Bugs Already Fixed — Never Reintroduce

### Evaluation
- Client timeout must be 120000ms (not 35000)
- extractJSON() must be used in callClaudeHaikuJSON
- maxTokens must be >= 2000 for eval calls
- temperature: 0 for all eval calls
- XP awarded AFTER evaluation — not before
- next_review_at column allows NULL (spaced_repetition)

### Scoring Display
- Per-question badge uses recomputed total
- Header score uses recomputed total
- Overall session total uses sum of recomputed question totals
- Print version uses same recomputed values
- All three must match

### Database
- results.score column is NUMERIC(7,2) — not NUMERIC(4,2)
- spaced_repetition.next_review_at allows NULL
- All 8 tables have RLS enabled with correct policies

### JSON Parsing Defense (extractJSON — 5 strategies)
1. Control char + sanitization + direct parse
2. Markdown fence stripping
3. Brace-matched extraction
4. Aggressive repair
5. jsonrepair library
Never remove or bypass any strategy.

---

## Architecture Rules

### Evaluation Queue
- aiSemaphore: 20 concurrent slots max
- perUserMax: 5 per user simultaneously
- Fire-and-forget batch with polling
- Never use Promise.all for batch evaluation
- evalProgress Map tracks per-submission progress
- evalResults Map stores completed scores
- complete = true set ONLY after evalResults.set()

### XP System
- Award after evaluation completes (80%+ success rate)
- Full Mock Bar (20q): +1000 base XP
- Partial Mock Bar (<20q): +10 XP per question
- Speed Drill: +40 XP flat
- High score bonus (8.0+): +50 XP per question
- Daily login: +10 XP (Philippine time, Asia/Manila)
- Streak bonus: +25 XP per day
- Review session: +60 XP

### Caching (questions table)
- model_answer_alac: cached ALAC model answer
- model_answer_conceptual: cached conceptual model answer
- alternative_answers: cached parsed alternatives
- All three set to NULL when model_answer edited
- Backfill via admin panel buttons

### Email
- Provider: Resend API (not nodemailer/Gmail SMTP)
- Railway blocks SMTP — always use Resend
- Sender: onboarding@resend.dev (temporary)
- Target: barbuddyphilippines@gmail.com (Resend restriction)
- Env: RESEND_API_KEY

---

## Timezone Rules
- Store: UTC in Supabase (always)
- Display: Asia/Manila (UTC+8) in UI
- Format for display:
    new Date(ts).toLocaleString('en-PH', {
      timeZone: 'Asia/Manila'
    })
- Daily XP reset uses Asia/Manila midnight
- Bar exam date: September 6, 2026

---

## Security Rules
- RLS enabled on all tables — do not disable
- Service role key bypasses RLS (server-side only)
- Never expose service role key in frontend
- Bot blocker middleware blocks /wp-admin etc.
- Admin routes use x-admin-key header
- Auth routes use x-session-token header

---

## Performance Rules
- gzip compression enabled (compression middleware)
- Database indexes on all major columns
- ALAC cache hit → skip generateALACModelAnswer()
- Conceptual cache hit → skip generateConceptualModelAnswer()
- Supabase JS client handles connection pooling
- Static assets served with 1-year cache headers
- index.html served with no-cache headers

---

## UI/CSS Rules
- Theme: dark navy (#0D1B2A) + gold (#C9A84C)
- No UI framework — pure vanilla HTML/CSS/JS
- All CSS in <style> tags in index.html
- All JS in <script> tags in index.html
- Mobile breakpoint: max-width: 768px
- Session overlay blocks sidebar/header during exam
- Sticky header (.ms-header) during Mock Bar/Speed Drill
- Timer colors: gold >60s, warn 30-60s, critical ≤30s

---

## Subjects
civil, criminal, political, labor, 
commercial, taxation, remedial, ethics, custom

## Scoring Thresholds
- Passing: 70% (7/10 per question)
- High score bonus: 8.0+/10
- SR mastery: 8.0+/10
- SR intervals: <5.0→3days, 5-6.9→7days, 7-7.9→14days

---

## Do Not Change Without Explicit Instruction
- extractJSON() 5-strategy system
- EvalQueue semaphore settings
- RLS policies on Supabase
- ALAC scoring weights (1.5/3/4/1.5)
- Conceptual scoring weights (4/3/3)
- Temperature settings on eval calls
- Git branch strategy (uat → main)