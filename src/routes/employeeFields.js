const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const FIELD_TYPES = ['text', 'textarea', 'url', 'file', 'select'];

function slugifyKey(label) {
  return String(label)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9֐-׿\s-]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 50) || 'field';
}

/**
 * @openapi
 * /api/employee-fields:
 *   get:
 *     tags: [Employee Fields]
 *     summary: List custom employee-card field definitions for the caller's company
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: include_inactive
 *         schema: { type: boolean }
 *     responses:
 *       200: { description: List of field definitions }
 *   post:
 *     tags: [Employee Fields]
 *     summary: Add a new custom field — applies to every employee card in the company (admin only)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [label, field_type]
 *             properties:
 *               label: { type: string }
 *               field_type: { type: string, enum: [text, textarea, url, file, select] }
 *               options: { type: array, items: { type: string } }
 *     responses:
 *       201: { description: Field definition created }
 */
router.get('/', async (req, res) => {
  if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden' });
  const includeInactive = req.query.include_inactive === 'true';
  const { rows } = await pool.query(
    `SELECT * FROM company_employee_fields WHERE company_id = $1 ${includeInactive ? '' : 'AND active = TRUE'} ORDER BY sort_order, created_at`,
    [req.auth.companyId]
  );
  res.json(rows);
});

router.post(
  '/',
  requireRole('admin'),
  body('label').isString().trim().notEmpty(),
  body('field_type').isIn(FIELD_TYPES),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });
    const { label, field_type, options } = req.body;
    if (field_type === 'select' && (!Array.isArray(options) || !options.length)) {
      return res.status(400).json({ error: 'validation_error', message: 'select fields require a non-empty options list' });
    }

    let key = slugifyKey(label);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let attempt = 0; attempt < 20; attempt++) {
        const exists = await client.query('SELECT 1 FROM company_employee_fields WHERE company_id = $1 AND key = $2', [req.auth.companyId, key]);
        if (!exists.rows.length) break;
        key = `${slugifyKey(label)}_${attempt + 2}`;
      }
      const maxOrder = await client.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM company_employee_fields WHERE company_id = $1', [req.auth.companyId]);
      const { rows } = await client.query(
        `INSERT INTO company_employee_fields (company_id, key, label, field_type, options, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.auth.companyId, key, label, field_type, field_type === 'select' ? JSON.stringify(options) : null, maxOrder.rows[0].m + 1]
      );
      await client.query('COMMIT');
      res.status(201).json(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
);

/**
 * @openapi
 * /api/employee-fields/{id}:
 *   patch:
 *     tags: [Employee Fields]
 *     summary: Update a custom field's label/options, or deactivate it (admin only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated field definition }
 */
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { label, options, active, sort_order } = req.body;
  const { rows } = await pool.query(
    `UPDATE company_employee_fields SET
       label = COALESCE($1, label),
       options = COALESCE($2, options),
       active = COALESCE($3, active),
       sort_order = COALESCE($4, sort_order)
     WHERE id = $5 AND company_id = $6 RETURNING *`,
    [label, options ? JSON.stringify(options) : null, active, sort_order, req.params.id, req.auth.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

module.exports = router;
