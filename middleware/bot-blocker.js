// WordPress/bot probe blocker — extracted from server.js, behavior unchanged.
// Blocks common bot probe paths (wp-admin, wp-login, xmlrpc, etc.) with 404.

function botBlocker(req, res, next) {
  const p = req.path.toLowerCase().replace(/\/+/g, '/');
  const blocked = [
    '/wp-admin', '/wp-includes', '/wp-login',
    '/wp-content', '/wp-json', '/wp-cron',
    '/wordpress', '/xmlrpc.php', '/wlwmanifest',
    '/feed', '/wp1', '/wp2',
    'license.txt', 'readme.html', 'setup-config'
  ];
  if (blocked.some(b => p.includes(b))) return res.status(404).send('Not found');
  next();
}

module.exports = { botBlocker };
