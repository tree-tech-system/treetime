const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

/**
 * @openapi
 * /api/api-keys:
 *   get:
 *     tags: [Integrations]
 *     summary: List API keys (admin only). The raw key is never shown again after creation.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of API keys (metadata only) }
 */
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, key_prefix, scopes, active, created_at, last_used_at FROM api_keys WHERE company_id = $1 ORDER BY created_at DESC',
    [req.auth.companyId]
  );
  res.json(rows);
});

/**
 * @openapi
 * /api/api-keys:
 *   post:
 *     tags: [Integrations]
 *     summary: Create a new API key for an external system integration
 *     description: >
 *       Returns the raw key ONCE. Store it securely — it cannot be retrieved again.
 *       Send it back on every request as the `X-API-Key` header.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, example: "Payroll system" }
 *               scopes:
 *                 type: array
 *                 items: { type: string, enum: [read, write, admin] }
 *                 default: [read]
 *     responses:
 *       201: { description: Key created, raw key returned once }
 */
router.post('/', async (req, res) => {
  const { name, scopes } = req.body;
  if (!name) return res.status(400).json({ error: 'validation_error', message: 'name is required' });

  const rawKey = `tt_${crypto.randomBytes(24).toString('hex')}`;
  const keyPrefix = rawKey.slice(0, 10);
  const keyHash = await bcrypt.hash(rawKey, 12);

  const { rows } = await pool.query(
    `INSERT INTO api_keys (name, key_prefix, key_hash, scopes, company_id) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, key_prefix, scopes, active, created_at`,
    [name, keyPrefix, keyHash, scopes && scopes.length ? scopes : ['read'], req.auth.companyId]
  );
  res.status(201).json({ ...rows[0], api_key: rawKey });
});

/**
 * @openapi
 * /api/api-keys/{id}:
 *   delete:
 *     tags: [Integrations]
 *     summary: Revoke an API key
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
  const { rowCount } = await pool.query('UPDATE api_keys SET active = FALSE WHERE id = $1 AND company_id = $2', [req.params.id, req.auth.companyId]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

module.exports = router;
