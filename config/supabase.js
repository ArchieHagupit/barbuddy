// Supabase client — single source of truth for DB access.
// Service role key bypasses RLS; never expose to client code.
// Extracted from server.js — behavior unchanged.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

module.exports = { supabase };
