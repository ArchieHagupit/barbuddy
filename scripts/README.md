# One-shot migration scripts

Historical migrations for moving BarBuddy from JSON files to Supabase.
Keep for reference but do not run against production without review.

- `migrate-questions.js` — sync past_bar.questions into questions table
- `railway_migrate.js` — initial import from kb.json/users.json into Supabase
- `verify-migration.js` — compares JSON → Supabase counts to confirm migration completeness

All require `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` env vars set.
