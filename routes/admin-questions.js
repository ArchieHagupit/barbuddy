// Admin questions CRUD — extracted from server.js, behavior unchanged.
// Covers list/filter, delete, and patch-with-cache-bust of individual questions.
// The 6 /api/admin/backfill-* routes stay in server.js — they depend on
// eval-subsystem helpers (extractAlternativeAnswers, generateALACModelAnswer,
// generateConceptualModelAnswer) not yet modularized.

const express = require('express');
const { supabase } = require('../config/supabase');

// Usage in server.js:
//   app.use(require('./routes/admin-questions')({ adminOnly }));

module.exports = function createAdminQuestionsRoutes({ adminOnly }) {
  const router = express.Router();

  router.get('/api/admin/questions', adminOnly, async (req, res) => {
    try {
      let query = supabase.from('questions').select('*', { count: 'exact' });
      if (req.query.subject) query = query.eq('subject', req.query.subject);
      if (req.query.year)    query = query.eq('year', req.query.year);
      if (req.query.type)    query = query.eq('type', req.query.type);
      if (req.query.q)       query = query.ilike('question_text', `%${req.query.q}%`);
      const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
      const offset = parseInt(req.query.offset) || 0;
      query = query.range(offset, offset + limit - 1).order('subject').order('year');
      const { data, count, error } = await query;
      if (error) throw error;
      res.json({ questions: data || [], total: count });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.delete('/api/admin/questions/:id', adminOnly, async (req, res) => {
    try {
      const { error } = await supabase.from('questions').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  router.patch('/api/admin/questions/:id', adminOnly, async (req, res) => {
    try {
      const allowed = ['question_text','context','model_answer','key_points','type','subject','year','source','max_score','alternative_answer_1','alternative_answer_2','alternative_answer_3','alternative_answer_4','alternative_answer_5'];
      const updates = {};
      for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
      // Cache bust — model_answer was edited by admin; force full regeneration on next evaluation
      if (updates.model_answer !== undefined) {
        updates.model_answer_alac        = null;
        updates.alternative_answers      = null;
        updates.model_answer_conceptual  = null;
        updates.alternative_answer_1     = null;
        updates.alternative_answer_2     = null;
        updates.alternative_answer_3     = null;
        updates.alternative_answer_4     = null;
        updates.alternative_answer_5     = null;
        updates.alternative_alac_1       = null;
        updates.alternative_alac_2       = null;
        updates.alternative_alac_3       = null;
        updates.alternative_alac_4       = null;
        updates.alternative_alac_5       = null;
      }
      // Clear specific alt ALAC when that alternative is edited directly
      for (let i = 1; i <= 5; i++) {
        if (updates[`alternative_answer_${i}`] !== undefined) {
          updates[`alternative_alac_${i}`] = null;
        }
      }
      const { data, error } = await supabase
        .from('questions').update(updates).eq('id', req.params.id).select().single();
      if (error) throw error;
      res.json(data);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
