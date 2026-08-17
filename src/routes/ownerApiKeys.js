const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const { authenticate, requireOwner } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireOwner);

const VALID_SCOPES = ['changelog:write', 'impersonate'];

/**
 * @openapi
 * /api/owner/api-keys:
 *   get:
 *     tags: [Owner]
 *     summary: List owner-level automation API keys (owner only). Raw key is never shown again.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of owner API keys (metadata only) }
 */
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, key_prefix, scopes, active, created_at, last_used_at FROM owner_api_keys ORDER BY created_at DESC'
  );
  res.json(rows);
});

/**
 * @openapi
 * /api/owner/api-keys:
 *   post:
 *     tags: [Owner]
 *     summary: Create an owner-level automation API key, scoped to specific owner-only actions
 *     description: >
 *       For CI/automation that needs a handful of owner-only actions (posting changelog
 *       entries, e2e impersonation) without a full owner login session. Not the same
 *       mechanism as the per-company /api/api-keys -- this one can only ever do what its
 *       scopes explicitly list. Returns the raw key ONCE; store it securely.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, scopes]
 *             properties:
 *               name: { type: string, example: "CI automation" }
 *               scopes:
 *                 type: array
 *                 items: { type: string, enum: [changelog:write, impersonate] }
 *     responses:
 *       201: { description: Key created, raw key returned once }
 */
router.post('/', async (req, res) => {
  const { name, scopes } = req.body;
  if (!name) return res.status(400).json({ error: 'validation_error', message: 'name is required' });

  const requestedScopes = Array.isArray(scopes) ? scopes.filter((s) => VALID_SCOPES.includes(s)) : [];
  if (!requestedScopes.length) {
    return res.status(400).json({
      error: 'validation_error',
      message: `scopes must include at least one of: ${VALID_SCOPES.join(', ')}`,
    });
  }

  const rawKey = `tto_${crypto.randomBytes(24).toString('hex')}`;
  const keyPrefix = rawKey.slice(0, 10);
  const keyHash = await bcrypt.hash(rawKey, 12);

  const { rows } = await pool.query(
    `INSERT INTO owner_api_keys (name, key_prefix, key_hash, scopes, created_by) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, key_prefix, scopes, active, created_at`,
    [name, keyPrefix, keyHash, requestedScopes, req.auth.ownerId]
  );
  res.status(201).json({ ...rows[0], api_key: rawKey });
});

/**
 * @openapi
 * /api/owner/api-keys/{id}:
 *   delete:
 *     tags: [Owner]
 *     summary: Revoke an owner-level automation API key
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204: { description: Revoked }
 */
router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('UPDATE owner_api_keys SET active = FALSE WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

module.exports = router;
