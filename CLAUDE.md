# BarBuddy v3 — Philippine Bar Exam Companion

## Project Overview
AI-powered bar exam review app for Philippine Bar 2026.
Deployed at: https://thebarbuddy.xyz

## Stack
- Backend: Node.js/Express (server.js)
- Frontend: Single HTML file (public/index.html)
- Database: Supabase (PostgreSQL + Auth)
- AI: Anthropic Claude API (Haiku for evaluation, Sonnet for fallback)
- Hosting: Railway
- Domain: thebarbuddy.xyz (registered via Name.com through Railway)
- Repo: github.com/ArchieHagupit/barbuddy (branches: uat → main)

## Key Files
- server.js — all API routes, evaluation logic, XP system
- public/index.html — entire frontend (CSS + JS + HTML)
- public/barbuddyemblem.webp — background watermark

## Database Tables (Supabase)
- questions — bar exam questions with ALAC cache columns
- users — students with xp, level, last_login_xp_date
- results — mock bar session results
- sessions — active exam sessions
- settings — app settings including bar_exam_date
- syllabus — syllabus structure
- syllabus_pdfs — uploaded PDF materials
- past_bar — past bar exam batches
- spaced_repetition — spaced repetition tracking
- xp_transactions — XP history log
- bookmarks — student topic bookmarks

## Branch Strategy
- uat — active development branch
- main — production (auto-deploys to Railway)
- Always work on uat, merge to main when ready
- Never force push to main

## Environment Variables (Railway)
- ANTHROPIC_API_KEY
- SUPABASE_URL
- SUPABASE_SERVICE_KEY
- RESEND_API_KEY
- ADMIN_KEY
- ADMIN_EMAIL
- APP_URL=https://thebarbuddy.xyz

## Architecture Notes
- Evaluation uses fire-and-forget batch pattern with polling
- EvalQueue has aiSemaphore (20 slots), perUserMax (5)
- ALAC answers cached in questions.model_answer_alac
- Alternative answers cached in questions.alternative_answers
- XP awarded AFTER evaluation completes (not before)
- All timestamps stored in UTC, displayed in Asia/Manila (UTC+8)
- RLS enabled on all Supabase tables
- Service role key bypasses RLS on server side

## Subjects
civil, criminal, political, labor, commercial, taxation, remedial, ethics

## Important Rules
- Philippine timezone: Asia/Manila (UTC+8)
- Bar exam date: September 6, 2026
- Passing score: 70%
- ALAC scoring: Answer(1.5) + LegalBasis(3) + Application(4) + Conclusion(1.5) = 10
- Always recompute total from components, never use AI-returned total
- Situational questions use ALAC scoring
- Conceptual questions use breakdown scoring (accuracy/completeness/clarity)

## Answer (A) Scoring Rule
- Responsive + correct position: 1.5/1.5
- Responsive + contradicts model/alternatives: 1.0/1.5
- Partially responsive: 0.5/1.5
- Not responsive: 0/1.5
- Only valid deduction: -0.5 for wrong legal position
- All other deductions belong in L or A components

## Recent Changes
- jsonrepair added as Strategy 5 in extractJSON
- XP awarded after evaluation completes (not before)
- Resend API used for email (onboarding@resend.dev)
- Bot blocker middleware added for WordPress probes
- RLS enabled with policies on all 8 tables

# Refresh Fixes
- Login Form Flash Prevention
- Location Persistence
- Content Fade Transitions
- Skeleton Loading States
- Instant Sidebar Cache
- Clear sessionStorage on Logout

## Conceptual Question Model Answers

### Caching Column
- questions.model_answer_conceptual (JSONB) — cached 
  structured model answer for conceptual questions
- Cache invalidated (set to NULL) when model_answer 
  is edited in admin — same as model_answer_alac

### generateConceptualModelAnswer() (server.js)
Generates structured model answer with these fields:
  {
    overview: string,
    accuracy: { label, content, keyPoints[] },
    completeness: { label, content, keyPoints[] },
    clarity: { label, content, keyPoints[] },
    conclusion: string,
    keyProvisions: []
  }

### Cache-First Pattern (same as ALAC)
1. Check question._cachedConceptual first
2. If null → call generateConceptualModelAnswer()
3. Fire-and-forget write to model_answer_conceptual
4. Applied in both /api/evaluate and runEvalJob()

### Backfill
- POST /api/admin/backfill-conceptual-cache
- GET /api/admin/backfill-conceptual-cache/status
- Filters non-situational questions with null cache
- 1.5s delay between questions
- Admin button: "Pre-generate Conceptual Cache" (teal)

### Frontend Rendering
- renderConceptualSections() — renders structured 
  conceptual model answer with all components
- renderModelAnswer() checks in order:
  1. ALAC format (situational)
  2. Conceptual format (conceptual) ← new
  3. Plain text fallback
- Print/email uses same .alac-model-answer CSS classes

### Scoring Criteria
- Accuracy: 4 pts — correct legal concepts/provisions
- Completeness: 3 pts — all essential elements covered
- Clarity: 3 pts — clear organized presentation
- Total: 10 pts

### Question Type Detection
- situational → ALAC scoring + ALAC model answer
- conceptual → Breakdown scoring + Conceptual model answer

## Admin Insights Tab

### Endpoint
GET /api/admin/improve-items
Query params: subject, dateFrom, dateTo, limit, offset

### Server-Side Filtering
All three filters (subject, dateFrom, dateTo) are 
applied directly in the Supabase query — not client-side.
Subject filter uses .eq('subject', subject) when not 'all'.
Date filter uses .gte('finished_at', dateFrom) and 
.lte('finished_at', dateTo).

### Data Extraction
Improve items extracted from ALL questions in ALL 
result records matching the filter:
- Loops through results → evaluations array → 
  each evaluation's improve/keyMissed array
- Returns flat list of { student, subject, question, 
  improveItems[], date }

### Student Names
Joined via users(id, name, email) in Supabase select.
studentName read from row.users?.name with 
row.user_id as fallback.

### Top 10 Statistics
Computed client-side from _improveData (all loaded items).
Re-computed and re-rendered when:
- Subject filter changes → loadImproveItems(true)
- Date filter changes → loadImproveItems(true)
- Load More clicked → appends then recomputes
- Search field → client-side only (renderImproveTable)

### Count Display
Format: "X question(s) · Y item(s) from Z student(s)"
Uses Set to count unique student names from 
filtered results.
Total count reflects active server-side filters.

### Pagination
Load More fetches next 20 results from server.
_improveData accumulates across loads.
renderImproveTable() does client-side text search 
on all accumulated data.

## Spaced Repetition — Score Computation Fix

### Critical Rule (same as results display)
ALWAYS recompute scores from components — never 
trust AI-returned numericScore directly.

### Score Computation Order (server.js ~3324-3329)
  1. ALAC questions: answer + legalBasis + application + conclusion
  2. Conceptual questions: accuracy + completeness + clarity
  3. Fallback: numericScore (only if neither alac nor breakdown present)

This applies in THREE places:
  1. SR mastery check (~3324) — determines if question is mastered
  2. Post-eval total score (~3461) — updates result record + pass/fail
  3. High score count for XP (~3490) — awards HIGH_SCORE_BONUS

### Mastery Threshold
Score >= 8.0 → mastered = true, next_review_at = null
Score < 8.0 → recalculate next interval (3/7/14 days)

### Debug Logging
Railway logs show after each SR update:
  [spaced-rep] Q1 score:8.5 mastered:true 
  qtype:conceptual alac:false breakdown:true 
  numericScore:8

### Why This Was Broken
Conceptual questions return breakdown components 
AND numericScore. If AI numericScore didn't match 
actual component sum, mastery threshold was 
evaluated against wrong value — keeping mastered 
permanently false.

### Verification SQL
  SELECT COUNT(*) as total,
    COUNT(CASE WHEN mastered = true THEN 1 END) as mastered
  FROM spaced_repetition;

  ## AI Temperature Settings

### Scoring/Evaluation — temperature: 0
All evaluation calls use temperature: 0 for 
deterministic, consistent scoring.
Same answer on same question always gets same score.

Updated call sites:
1. callClaudeHaikuJSON() — batch evaluation (runEvalJob)
2. /api/evaluate endpoint — single question eval
3. callClaude() — accepts optional { temperature } param

### Generation/Content — default temperature
These intentionally keep default temperature 
for creative variation:
- generateALACModelAnswer()
- generateConceptualModelAnswer()
- generateTopicContent()
- generateAIQuestions()
- Any content/lesson/summary generation

### How Temperature is Passed
callClaudeJSON() and callClaude() accept optional 
options object: { temperature }
Example: callClaudeJSON(messages, maxTok, { temperature: 0 })
If not provided → uses API default temperature

### Rule
Any new evaluation/scoring API call → temperature: 0
Any new generation/content API call → no temperature set

## Session Header & Timer

### Sticky Header
.ms-header has position:sticky;top:0;z-index:100;
backdrop-filter:blur(10px) — stays pinned at top 
during scroll in both Mock Bar and Speed Drill.

Contains: question number, source badge, timer, 
Flag/Exit/End & Score buttons — all always visible.

### Timer Warning Colors (runTimer() ~line 5185)
Controlled by CSS classes on the timer element:
- >60s remaining: normal gold color (no class)
- 30-60s remaining: .warn — pink/red with blink
- ≤30s remaining: .critical — bright red with 
  faster pulse animation (timerPulse keyframe)

### CSS Classes (index.html ~line 721-727)
- .ms-header — sticky session header
- .ms-timer — base timer styles
- .ms-timer.warn — 30-60s warning state
- .ms-timer.critical — ≤30s critical state
- @keyframes timerPulse — pulse animation for critical

### Applies To
Both Mock Bar and Speed Drill share .ms-header 
and runTimer() — sticky header and timer colors 
work in both modes automatically.

## Submit Confirmation
Both Mock Bar and Speed Drill show a
confirmation modal before submitting answers.
Shows answered/total count and warns about
unanswered questions that will score 0.
Timer auto-submit bypasses confirmation.
Custom modal matches navy/gold BarBuddy theme.
Components: showSubmitConfirmModal({onConfirm})
Flow: checkFlaggedBeforeSubmit() → flagged modal
(if flagged) → submit confirm modal → endMockSession()

## Session Lock
During active Mock Bar or Speed Drill sessions,
sidebar and topbar are disabled via .session-locked
class (opacity:0.35, pointer-events:none).
No full-screen overlay — uses direct pointer-events
disabling to avoid z-index conflicts with session panel.
Backspace key blocked during session (except in
textarea/input fields).
Components: showSessionOverlay(), hideSessionOverlay(),
isSessionActive flag.
Called in: startMockSession(), resumeExamSession(),
endMockSession(), confirmAbandonExam().
Timer auto-submit goes through endMockSession()
which calls hideSessionOverlay().

## Tab Access Control — Spaced Repetition

### Global Toggle
spaced_repetition is a GLOBAL setting (not per-subject)
stored in tab_settings root level:
  {
    overview: true,
    spaced_repetition: true,  // global
    subjects: { ... }
  }

### Admin Panel
Located in Admin → Tab Access panel.
Global controls section has:
  [ 🧠 Spaced Rep ON ]  [ 🧠 Spaced Rep OFF ]
Dedicated toggle card below subject rows.
Matches existing Learn/Quiz/Mock Bar/Speed Drill 
toggle styling.

### Client Enforcement
After tab settings load on login:
  const srEnabled = tabSettings?.spaced_repetition !== false;

When disabled (srEnabled = false):
- Start Review Session button hidden
- Due reviews widget hidden
- SR sidebar badges ("X due") hidden
- Shows: "🔒 Spaced Repetition Review is currently 
  unavailable. Check back later."

When enabled (srEnabled = true):
- Full spaced repetition functionality available
- Default state for all users

### Default State
spaced_repetition: true — enabled by default
for all existing and new users.

### Handler Function
setAllSpacedRep(enabled) — saves setting and 
re-renders Tab Access panel with toast notification.

## Evaluation Error — "Temporarily Unavailable" Fix

### Root Cause
callClaudeHaikuJSON() (batch evaluator) had its 
own simpler JSON parser separate from the robust 
5-strategy extractJSON() function. When Haiku 
returned slightly malformed JSON, the simple 
parser failed and returned null → line 3413 
catch block returned "Evaluation temporarily 
unavailable."

### Fixes Applied
1. callClaudeHaikuJSON() now uses extractJSON() 
   for all JSON parsing — same 5-strategy defense 
   as single-question evaluation
   
2. maxTokens increased from 400 → 2000 in 
   callClaudeHaikuJSON() — positions 2700+ were 
   failing due to response truncation at 400 tokens.
   Full ALAC response needs 800-1500 tokens.

3. Parse retry logic added to callClaudeHaikuJSON():
   - 3 attempts before returning null
   - 1s delay between parse retries
   - Retries on both parse failure AND overload

4. Better error logging in runEvalJob() catch block:
   - Logs err.message and stack line
   - Makes "temporarily unavailable" traceable 
     in Railway logs

### Common JSON Failure Char Codes
- char code 34 = " (double quote in wrong position)
- char code 44 = , (trailing comma)
- char code NaN = unicode/special character
- char code 123 = { (nested brace in string)

All handled by extractJSON() 5-strategy system.

### callClaudeHaikuJSON vs callClaudeJSON
- callClaudeHaikuJSON — batch evaluation only
  Uses Haiku model, temperature: 0, maxTokens: 2000
  Has own 429/529 retry + now uses extractJSON()
  
- callClaudeJSON — single question + Sonnet fallback
  Uses configurable model, temperature: 0
  Has own retry schedule (Sonnet → Haiku)
  Uses extractJSON()

### Token Requirements
- ALAC full response: 800-1500 tokens typical
- Conceptual breakdown response: 600-1200 tokens
- Always set maxTokens >= 2000 for eval calls
- generateALACModelAnswer: 2000 tokens
- generateConceptualModelAnswer: 2000 tokens
