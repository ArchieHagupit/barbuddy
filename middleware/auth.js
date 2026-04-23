// Auth middleware — extracted from server.js, behavior unchanged.
// Factory pattern: dependencies injected at call site for testability
// and because verifySession/ADMIN_KEY still live in server.js scope.
//
// Usage:
//   const { requireAuth, adminOnly, authOrAdmin } = require('./middleware/auth')({
//     verifySession, mapUser, adminKey: ADMIN_KEY,
//   });

function createAuthMiddleware({ verifySession, mapUser, adminKey }) {
  async function requireAuth(req, res, next) {
    try {
      const token = req.headers['x-session-token'];
      if (!token) return res.status(401).json({ error: 'Not authenticated' });
      const session = await verifySession(token);
      if (!session) return res.status(401).json({ error: 'Session expired' });
      req.userId = session.user_id;
      req.user   = mapUser(session.users);
      next();
    } catch(e) { res.status(500).json({ error: 'Auth error' }); }
  }

  async function adminOnly(req, res, next) {
    try {
      // req.query.k allows EventSource (browser SSE) to authenticate — it
      // cannot set custom headers. Only used by SSE routes in practice.
      const key = req.headers['x-admin-key'] || req.body?.adminKey || req.query?.k;
      if (key && key === adminKey) return next();
      const token = req.headers['x-session-token'];
      if (token) {
        const session = await verifySession(token);
        if (session?.users?.is_admin) {
          req.userId = session.user_id;
          req.user   = mapUser(session.users);
          return next();
        }
      }
      return res.status(401).json({ error: 'Unauthorized' });
    } catch(e) { res.status(500).json({ error: 'Auth error' }); }
  }

  async function authOrAdmin(req, res, next) {
    try {
      const adminKeyFromReq = req.headers['x-admin-key'] || req.body?.adminKey;
      if (adminKeyFromReq === adminKey) return next();
      const token = req.headers['x-session-token'];
      if (!token) return res.status(401).json({ error: 'Not authenticated' });
      const session = await verifySession(token);
      if (!session) return res.status(401).json({ error: 'Session expired' });
      req.userId = session.user_id;
      req.user   = mapUser(session.users);
      next();
    } catch(e) { res.status(500).json({ error: 'Auth error' }); }
  }

  return { requireAuth, adminOnly, authOrAdmin };
}

module.exports = createAuthMiddleware;
