// Bookmarks routes — extracted from server.js, behavior unchanged.
// Simple CRUD on bookmarks table scoped to req.userId.

const express = require('express');
const { supabase } = require('../config/supabase');

// Usage in server.js:
//   app.use(require('./routes/bookmarks')({ requireAuth }));

module.exports = function createBookmarksRoutes({ requireAuth }) {
  const router = express.Router();

  router.get('/api/bookmarks', requireAuth, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('bookmarks')
        .select('*')
        .eq('user_id', req.userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      res.json(data || []);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/api/bookmarks', requireAuth, async (req, res) => {
    try {
      const { topicId, topicTitle, subject } = req.body;
      if (!topicId || !subject) return res.status(400).json({ error: 'topicId and subject required' });
      const id = 'bm_' + req.userId.slice(-8) + '_' + topicId.slice(0, 20).replace(/[^a-zA-Z0-9]/g, '_');
      const { data, error } = await supabase
        .from('bookmarks')
        .upsert(
          { id, user_id: req.userId, subject, topic_id: topicId, topic_title: topicTitle || topicId },
          { onConflict: 'user_id,topic_id' }
        )
        .select()
        .single();
      if (error) throw error;
      res.json({ bookmarked: true, bookmark: data });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/bookmarks/:topicId', requireAuth, async (req, res) => {
    try {
      const { error } = await supabase
        .from('bookmarks')
        .delete()
        .eq('user_id', req.userId)
        .eq('topic_id', req.params.topicId);
      if (error) throw error;
      res.json({ bookmarked: false });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
