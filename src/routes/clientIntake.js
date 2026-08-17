const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { notifyAdmins } = require('../lib/notify');

const router = express.Router();

/**
 * @openapi
 * /api/client-intake-links:
 *   get:
 *     tags: [Client Intake]
 *     summary: List self-service client intake links generated for the caller's company
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of links, newest first }
 *   post:
 *     tags: [Client Intake]
 *     summary: Generate a new single-use self-service client intake link (admin only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Link created }
 */
router.get('/client-intake-links', authenticate, async (req, res) => {
  if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden' });
  const { rows } = await pool.query(
    `SELECT il.*, p.name AS created_project_name
     FROM client_intake_links il
     LEFT JOIN projects p ON p.id = il.created_project_id
     WHERE il.company_id = $1 ORDER BY il.created_at DESC`,
    [req.auth.companyId]
  );
  res.json(rows);
});

router.post('/client-intake-links', authenticate, requireRole('admin'), async (req, res) => {
  const token = crypto.randomBytes(20).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO client_intake_links (company_id, token, created_by) VALUES ($1,$2,$3) RETURNING *`,
    [req.auth.companyId, token, req.auth.employeeId]
  );
  res.status(201).json(rows[0]);
});

/**
 * @openapi
 * /api/client-intake-links/{id}/seen:
 *   patch:
 *     tags: [Client Intake]
 *     summary: Acknowledge the "new client submitted" notification for a used link
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Marked seen }
 */
router.patch('/client-intake-links/:id/seen', authenticate, async (req, res) => {
  if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden' });
  const { rows } = await pool.query(
    `UPDATE client_intake_links SET seen = TRUE WHERE id = $1 AND company_id = $2 RETURNING *`,
    [req.params.id, req.auth.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

/**
 * @openapi
 * /api/client-intake/{token}:
 *   get:
 *     tags: [Client Intake]
 *     summary: Public — check a client intake link's validity and get the company's display name
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Link is valid, unused }
 *       404: { description: Link not found, already used, or invalid }
 */
router.get('/client-intake/:token', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT il.id, il.used, c.name AS company_name
     FROM client_intake_links il JOIN companies c ON c.id = il.company_id
     WHERE il.token = $1`,
    [req.params.token]
  );
  const link = rows[0];
  if (!link || link.used) return res.status(404).json({ error: 'invalid_or_used_link' });
  res.json({ company_name: link.company_name });
});

/**
 * @openapi
 * /api/client-intake/{token}:
 *   post:
 *     tags: [Client Intake]
 *     summary: Public — submit a new client card through a self-service intake link. Single-use.
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [business_name]
 *             properties:
 *               business_name: { type: string }
 *               name: { type: string }
 *               contact_phone: { type: string }
 *               contact_email: { type: string }
 *               description: { type: string }
 *     responses:
 *       201: { description: Client card created; the link is now locked }
 *       404: { description: Link not found or already used }
 */
router.post(
  '/client-intake/:token',
  body('business_name').isString().trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the row so two simultaneous submits on the same link can't both succeed.
      const linkRes = await client.query('SELECT * FROM client_intake_links WHERE token = $1 FOR UPDATE', [req.params.token]);
      const link = linkRes.rows[0];
      if (!link || link.used) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'invalid_or_used_link' });
      }

      const { business_name, name, contact_phone, contact_email, description } = req.body;
      const instanceId = crypto.randomBytes(12).toString('hex');
      const projectRes = await client.query(
        `INSERT INTO projects (name, business_name, contact_phone, contact_email, description, company_id, instance_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [business_name || name, business_name, contact_phone || null, contact_email || null, description || null, link.company_id, instanceId]
      );

      await client.query(
        'UPDATE client_intake_links SET used = TRUE, used_at = now(), created_project_id = $1 WHERE id = $2',
        [projectRes.rows[0].id, link.id]
      );

      await client.query('COMMIT');
      notifyAdmins(link.company_id, 'client_intake', 'לקוח חדש נרשם דרך לינק עצמאי', business_name || name, 'clients');
      res.status(201).json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
);

module.exports = router;
