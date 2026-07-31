-- Persistent flashcard highlights (student-facing, per-account)
--
-- Run this once in the Supabase SQL editor. Until it exists the app still
-- works: the server detects the missing column on its first read, stops
-- asking for it, and the highlight controls stay inert rather than throwing.
--
-- Highlights live on flashcard_reviews because that table already holds
-- exactly one row per (user, card) — the same row that carries `done`. A
-- student's highlights are private to them; two students highlighting the
-- same card never see each other's marks.
--
-- Shape: an array of ranges, each anchored by character offset into the
-- card's own front/back text rather than by DOM position, so re-rendering,
-- reflowing or restyling the card cannot move a highlight.
--
--   [{ "face": "back", "start": 42, "end": 96 }, ...]
--
-- If a card's text is later edited in admin, its offsets can drift. The
-- client clamps every range to the current text length on render and drops
-- any that no longer fit, so a stale highlight degrades to nothing visible
-- instead of landing on the wrong words.

ALTER TABLE flashcard_reviews
  ADD COLUMN IF NOT EXISTS highlights JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN flashcard_reviews.highlights IS
  'Student text highlights for this card: [{face:"front"|"back",start:int,end:int}]. Offsets index the flashcards.front/back source text.';

-- Verify:
--   SELECT COUNT(*) AS rows_with_highlights
--   FROM flashcard_reviews
--   WHERE jsonb_array_length(highlights) > 0;
