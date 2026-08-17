const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { notifyAdmins } = require('../lib/notify');

const router = express.Router();

/**
 * @openapi
 * /api/employee-intake-links:
 *   get:
 *     tags: [Employee Intake]
 *     summary: List self-service employee intake links generated for the caller's company
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of links, newest first }
 *   post:
 *     tags: [Employee Intake]
 *     summary: Generate a new single-use self-service employee intake link (admin only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Link created }
 */
router.get('/employee-intake-links', authenticate, async (req, res) => {
  if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden' });
  const { rows } = await pool.query(
    `SELECT il.*, e.full_name AS created_employee_name
     FROM employee_intake_links il
     LEFT JOIN employees e ON e.id = il.created_employee_id
     WHERE il.company_id = $1 ORDER BY il.created_at DESC`,
    [req.auth.companyId]
  );
  res.json(rows);
});

router.post('/employee-intake-links', authenticate, requireRole('admin'), async (req, res) => {
  const token = crypto.randomBytes(20).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO employee_intake_links (company_id, token, created_by) VALUES ($1,$2,$3) RETURNING *`,
    [req.auth.companyId, token, req.auth.employeeId]
  );
  res.status(201).json(rows[0]);
});

/**
 * @openapi
 * /api/employee-intake-links/{id}/seen:
 *   patch:
 *     tags: [Employee Intake]
 *     summary: Acknowledge the "new employee submitted" notification for a used link
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Marked seen }
 */
router.patch('/employee-intake-links/:id/seen', authenticate, async (req, res) => {
  if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden' });
  const { rows } = await pool.query(
    `UPDATE employee_intake_links SET seen = TRUE WHERE id = $1 AND company_id = $2 RETURNING *`,
    [req.params.id, req.auth.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

/**
 * @openapi
 * /api/employee-intake/{token}:
 *   get:
 *     tags: [Employee Intake]
 *     summary: Public — check an employee intake link's validity and get the company's display name
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Link is valid, unused }
 *       404: { description: Link not found, already used, or invalid }
 */
router.get('/employee-intake/:token', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT il.id, il.used, c.name AS company_name
     FROM employee_intake_links il JOIN companies c ON c.id = il.company_id
     WHERE il.token = $1`,
    [req.params.token]
  );
  const link = rows[0];
  if (!link || link.used) return res.status(404).json({ error: 'invalid_or_used_link' });
  res.json({ company_name: link.company_name });
});

/**
 * @openapi
 * /api/employee-intake/{token}:
 *   post:
 *     tags: [Employee Intake]
 *     summary: Public — submit a new employee account through a self-service intake link. Single-use.
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
 *             required: [full_name, email, password]
 *             properties:
 *               full_name: { type: string }
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *               phone: { type: string }
 *               business_type: { type: string }
 *     responses:
 *       201: { description: Employee account created; the link is now locked }
 *       404: { description: Link not found or already used }
 *       409: { description: Email already registered in this company }
 */
router.post(
  '/employee-intake/:token',
  body('full_name').isString().trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('password').isString().isLength({ min: 8 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const linkRes = await client.query('SELECT * FROM employee_intake_links WHERE token = $1 FOR UPDATE', [req.params.token]);
      const link = linkRes.rows[0];
      if (!link || link.used) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'invalid_or_used_link' });
      }

      const { full_name, email, password, phone, business_type } = req.body;
      const password_hash = await bcrypt.hash(password, 12);
      let employee;
      try {
        const employeeRes = await client.query(
          `INSERT INTO employees (full_name, email, password_hash, role, company_id, phone, business_type)
           VALUES ($1,$2,$3,'employee',$4,$5,$6) RETURNING id, full_name`,
          [full_name, email, password_hash, link.company_id, phone || null, business_type || null]
        );
        employee = employeeRes.rows[0];
      } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') return res.status(409).json({ error: 'email_taken' });
        throw err;
      }

      await client.query(
        'UPDATE employee_intake_links SET used = TRUE, used_at = now(), created_employee_id = $1 WHERE id = $2',
        [employee.id, link.id]
      );

      await client.query('COMMIT');
      notifyAdmins(link.company_id, 'employee_intake', 'עובד חדש נרשם דרך לינק עצמאי', employee.full_name, 'freelancers');
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
