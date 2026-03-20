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