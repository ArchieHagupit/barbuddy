-- Review reminders preference (student-facing, per-account)
--
-- Run this once in the Supabase SQL editor BEFORE deploying the notification
-- bell. Until it exists, the app still works: the mapper treats a missing
-- column as "reminders on", and the toggle reports a save failure instead of
-- silently doing nothing.
--
-- Unlike users.spaced_repetition_enabled (an admin-controlled access gate),
-- this is owned by the student and only controls whether the due-review
-- notification surfaces. It never gates access to the reviews themselves.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS review_reminders_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN users.review_reminders_enabled IS
  'Student preference: show the due-review notification in the topbar bell. Default true.';

-- Verify:
--   SELECT COUNT(*) FILTER (WHERE review_reminders_enabled) AS on,
--          COUNT(*) FILTER (WHERE NOT review_reminders_enabled) AS off
--   FROM users;
