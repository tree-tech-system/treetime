const crypto = require('crypto');
const pool = require('../db/pool');

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function createAuthToken(employeeId, purpose, ttlMs) {
  const raw = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO auth_tokens (employee_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4)`,
    [employeeId, purpose, hashToken(raw), new Date(Date.now() + ttlMs)]
  );
  return raw;
}

// Single atomic UPDATE ... RETURNING so a token can't be consumed twice by
// two concurrent requests racing between a check and a separate write.
async function consumeAuthToken(rawToken, purpose) {
  const { rows } = await pool.query(
    `UPDATE auth_tokens SET used_at = now()
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING employee_id`,
    [hashToken(rawToken), purpose]
  );
  return rows[0]?.employee_id || null;
}

module.exports = { createAuthToken, consumeAuthToken };
