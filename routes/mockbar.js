// Mock bar generator route — extracted from server.js, behavior unchanged.
// Public endpoint (gated by mockBarPublic setting on the frontend).
// generateMockBar itself stays in server.js — part of AI-generation subsystem.

const express = require('express');

// Usage in server.js:
//   app.use(require('./routes/mockbar')({ API_KEY, generateMockBar }));

module.exports = function createMockbarRoutes({ API_KEY, generateMockBar }) {
  const router = express.Router();

  router.post('/api/mockbar/generate', async (req, res) => {
    if (!API_KEY) return res.status(500).json({ error:'API key not set' });
    const { subjects, count=20, sources, includePreGen, aiGenerate, topics, difficulty } = req.body;
    console.log(`[mockbar] requested: ${count} questions, subjects: ${JSON.stringify(subjects)}`);
    // Merge explicit top-level aiGenerate flag into sources object (new UI sends it at top level)
    const mergedSources = aiGenerate !== undefined ? { ...sources, aiGenerate } : sources;
    try {
      const result = await generateMockBar(subjects, count, { sources: mergedSources, includePreGen: includePreGen ?? null, topics, difficulty });
      res.json(result);
    } catch(err) {
      console.error('[mockbar] error:', err.message);
      res.status(500).json({ error:err.message });
    }
  });

  return router;
};
