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