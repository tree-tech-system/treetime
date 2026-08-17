const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');

// Accepts either:
//  - Authorization: Bearer <JWT>   (logged-in employee, via web/PWA)
//  - X-API-Key: <key>              (server-to-server integration)
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers['x-api-key'];

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (payload.type === 'owner') {
        req.auth = { type: 'owner', ownerId: payload.sub };
        return next();
      }
      req.auth = { type: 'user', employeeId: payload.sub, role: payload.role, companyId: payload.company_id };
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'invalid_token', message: 'Access token is invalid or expired.' });
    }
  }

  if (apiKey) {
    const prefix = apiKey.slice(0, 10);
    const { rows } = await pool.query(
      'SELECT * FROM api_keys WHERE key_prefix = $1 AND active = TRUE',
      [prefix]
    );
    for (const row of rows) {
      const match = await bcrypt.compare(apiKey, row.key_hash);
      if (match) {
        pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});
        req.auth = { type: 'apikey', apiKeyId: row.id, scopes: row.scopes, name: row.name, companyId: row.company_id };
        return next();
      }
    }
    return res.status(401).json({ error: 'invalid_api_key', message: 'API key is invalid or inactive.' });
  }

  return res.status(401).json({
    error: 'missing_credentials',
    message: 'Provide either "Authorization: Bearer <token>" or "X-API-Key: <key>".',
  });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (req.auth?.type === 'apikey' && req.auth.scopes?.includes('admin')) return next();
    if (req.auth?.type === 'user' && roles.includes(req.auth.role)) return next();
    return res.status(403).json({ error: 'forbidden', message: `Requires role: ${roles.join(' or ')}` });
  };
}

function requireScope(scope) {
  return (req, res, next) => {
    if (req.auth?.type === 'user') return next(); // logged-in users pass through role checks separately
    if (req.auth?.type === 'apikey' && (req.auth.scopes?.includes(scope) || req.auth.scopes?.includes('admin'))) {
      return next();
    }
    return res.status(403).json({ error: 'insufficient_scope', message: `API key requires scope: ${scope}` });
  };
}

function requireOwner(req, res, next) {
  if (req.auth?.type !== 'owner') {
    return res.status(403).json({ error: 'forbidden', message: 'This endpoint is for TreeTime owner accounts only.' });
  }
  next();
}

module.exports = { authenticate, requireRole, requireScope, requireOwner };
