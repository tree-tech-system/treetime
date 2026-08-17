const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

const VALID_EVENTS = ['time_entry.created', 'time_entry.started', 'time_entry.stopped'];

/**
 * @openapi
 * /api/webhooks:
 *   get:
 *     tags: [Integrations]
 *     summary: List registered webhooks (admin only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of webhooks (secret hidden) }
 */
router.get('/', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, target_url, events, active, created_at FROM webhooks WHERE company_id = $1 ORDER BY created_at DESC', [req.auth.companyId]);
  res.json(rows);
});

/**
 * @openapi
 * /api/webhooks:
 *   post:
 *     tags: [Integrations]
 *     summary: Register a webhook so an external system is notified of events
 *     description: >
 *       TreeTime will POST a JSON payload to `target_url` when a subscribed event occurs.
 *       Each request includes header `X-TreeTime-Signature: sha256=<hmac>`, an HMAC-SHA256
 *       of the raw request body using the returned `secret` — verify it to confirm the
 *       request genuinely came from TreeTime.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, target_url, events]
 *             properties:
 *               name: { type: string }
 *               target_url: { type: string, format: uri }
 *               events:
 *                 type: array
 *                 items: { type: string, enum: [time_entry.created, time_entry.started, time_entry.stopped] }
 *     responses:
 *       201: { description: Webhook registered, secret returned once }
 */
router.post('/', async (req, res) => {
  const { name, target_url, events } = req.body;
  if (!name || !target_url || !Array.isArray(events) || !events.length) {
    return res.status(400).json({ error: 'validation_error', message: 'name, target_url, events[] are required' });
  }
  const invalid = events.filter((e) => !VALID_EVENTS.includes(e));
  if (invalid.length) return res.status(400).json({ error: 'invalid_events', invalid, valid_events: VALID_EVENTS });

  const secret = crypto.randomBytes(24).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO webhooks (name, target_url, secret, events, company_id) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, target_url, events, active, created_at`,
    [name, target_url, secret, events, req.auth.companyId]
  );
  res.status(201).json({ ...rows[0], secret });
});

/**
 * @openapi
 * /api/webhooks/{id}:
 *   delete:
 *     tags: [Integrations]
 *     summary: Remove a webhook
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204: { description: Removed }
 */
router.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM webhooks WHERE id = $1 AND company_id = $2', [req.params.id, req.auth.companyId]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

module.exports = router;
