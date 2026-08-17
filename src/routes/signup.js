const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { seedDefaultWidgets } = require('../lib/defaultWidgets');
const { sendWelcomeEmail } = require('../lib/authEmails');

const router = express.Router();

const SLUG_RE = /^[a-z][a-z0-9-]{2,19}$/;

function signToken(employee) {
  return jwt.sign({ sub: employee.id, role: employee.role, company_id: employee.company_id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  });
}

/**
 * @openapi
 * /api/signup:
 *   post:
 *     tags: [Signup]
 *     summary: Self-service workspace creation — a new admin opens their own company, immediately, no approval needed
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [company_name, slug, admin_full_name, admin_email, admin_password]
 *             properties:
 *               company_name: { type: string }
 *               slug: { type: string, description: "Workspace name in English, becomes the /c/<slug>/ URL" }
 *               business_id: { type: string }
 *               address: { type: string }
 *               contact_phone: { type: string }
 *               contact_email: { type: string }
 *               admin_full_name: { type: string }
 *               admin_email: { type: string, format: email }
 *               admin_password: { type: string, minLength: 8 }
 *     responses:
 *       201: { description: Workspace created, returns JWT token for the new admin }
 *       409: { description: Slug or admin email already taken }
 */
router.post(
  '/',
  body('company_name').isString().trim().notEmpty(),
  body('slug').matches(SLUG_RE).withMessage('Slug must be lowercase letters/numbers/hyphens, 3-20 chars, starting with a letter'),
  body('admin_full_name').isString().trim().notEmpty(),
  body('admin_email').isEmail().normalizeEmail(),
  body('admin_password').isString().isLength({ min: 8 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const {
      company_name, slug, business_id, address, contact_phone, contact_email,
      admin_full_name, admin_email, admin_password,
    } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const slugTaken = await client.query('SELECT 1 FROM companies WHERE slug = $1', [slug]);
      if (slugTaken.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'slug_taken', message: 'This workspace name is already in use.' });
      }

      const companyRes = await client.query(
        `INSERT INTO companies (name, slug, business_id, address, contact_phone, contact_email, plan, status)
         VALUES ($1,$2,$3,$4,$5,$6,'trial','active') RETURNING *`,
        [company_name, slug, business_id || null, address || null, contact_phone || null, contact_email || null]
      );
      const company = companyRes.rows[0];

      const password_hash = await bcrypt.hash(admin_password, 12);
      const employeeRes = await client.query(
        `INSERT INTO employees (full_name, email, password_hash, role, company_id)
         VALUES ($1,$2,$3,'admin',$4) RETURNING id, public_id, full_name, email, role, company_id`,
        [admin_full_name, admin_email, password_hash, company.id]
      );
      const employee = employeeRes.rows[0];

      await seedDefaultWidgets(client, company.id);

      await client.query('COMMIT');
      sendWelcomeEmail(employee, company.name).catch(() => {});
      res.status(201).json({
        token: signToken(employee),
        employee: { ...employee, company_name: company.name, company_slug: company.slug },
        company,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'email_taken', message: 'Admin email already registered.' });
      throw err;
    } finally {
      client.release();
    }
  }
);

/**
 * @openapi
 * /api/signup/check-slug:
 *   get:
 *     tags: [Signup]
 *     summary: Check whether a workspace slug is available and well-formed
 *     parameters:
 *       - in: query
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Availability result }
 */
router.get('/check-slug', async (req, res) => {
  const slug = String(req.query.slug || '');
  if (!SLUG_RE.test(slug)) return res.json({ available: false, reason: 'invalid_format' });
  const { rows } = await pool.query('SELECT 1 FROM companies WHERE slug = $1', [slug]);
  res.json({ available: rows.length === 0 });
});

module.exports = router;
