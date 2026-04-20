// Rate limiters — extracted from server.js, behavior unchanged.
// Auth: 10 attempts per IP per 15 min. Protects login/register/forgot-password.
// Eval: 30 requests per IP per minute. Protects Anthropic quota.

const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

const evalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many evaluation requests. Slow down.' },
});

module.exports = { authLimiter, evalLimiter };
