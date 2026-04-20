// Session CRUD — extracted from server.js, behavior unchanged.
// All functions use the shared supabase client from config/supabase.js.

const crypto = require('crypto');
const { supabase } = require('../config/supabase');

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('sessions').insert([{ token, user_id: userId, expires_at: expires }]);
  return token;
}
async function verifySession(token) {
  const { data } = await supabase
    .from('sessions')
    .select('*, users(*)')
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .single();
  return data || null;
}
async function deleteSession(token) {
  await supabase.from('sessions').delete().eq('token', token);
}
async function cleanupSessions() {
  await supabase.from('sessions').delete().lt('expires_at', new Date().toISOString());
}

module.exports = { createSession, verifySession, deleteSession, cleanupSessions };
