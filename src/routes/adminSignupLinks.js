const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireOwner } = require('../middleware/auth');
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
 * /api/owner/admin-signup-links:
 *   get:
 *     tags: [Owner - Admin Signup Links]
 *     summary: List all owner-generated admin signup links
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of links, newest first }
 *   post:
 *     tags: [Owner - Admin Signup Links]
 *     summary: Generate a new single-use signup link for a prospective admin — opens a new trial workspace
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Link created }
 */
router.get('/owner/admin-signup-links', authenticate, requireOwner, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.*, c.name AS created_company_name, c.slug AS created_company_slug
     FROM admin_signup_links l
     LEFT JOIN companies c ON c.id = l.created_company_id
     ORDER BY l.created_at DESC`
  );
  res.json(rows);
});

router.post('/owner/admin-signup-links', authenticate, requireOwner, async (req, res) => {
  const token = crypto.randomBytes(20).toString('hex');
  const note = (req.body && req.body.note ? String(req.body.note).trim() : null) || null;
  const { rows } = await pool.query(
    `INSERT INTO admin_signup_links (token, note, created_by) VALUES ($1,$2,$3) RETURNING *`,
    [token, note, req.auth.ownerId]
  );
  res.status(201).json(rows[0]);
});

router.delete('/owner/admin-signup-links/:id', authenticate, requireOwner, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM admin_signup_links WHERE id = $1 AND used = FALSE', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not_found_or_used' });
  res.status(204).send();
});

/**
 * @openapi
 * /api/admin-signup-link/{token}:
 *   get:
 *     tags: [Admin Signup Link]
 *     summary: Public — check whether an admin signup link is valid and unused
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Link is valid, unused }
 *       404: { description: Link not found or already used }
 */
router.get('/admin-signup-link/:token', async (req, res) => {
  const { rows } = await pool.query('SELECT id, used, note FROM admin_signup_links WHERE token = $1', [req.params.token]);
  const link = rows[0];
  if (!link || link.used) return res.status(404).json({ error: 'invalid_or_used_link' });
  res.json({ note: link.note });
});

router.get('/admin-signup-link/:token/check-slug', async (req, res) => {
  const slug = String(req.query.slug || '');
  if (!SLUG_RE.test(slug)) return res.json({ available: false, reason: 'invalid_format' });
  const { rows } = await pool.query('SELECT 1 FROM companies WHERE slug = $1', [slug]);
  res.json({ available: rows.length === 0 });
});

/**
 * @openapi
 * /api/admin-signup-link/{token}:
 *   post:
 *     tags: [Admin Signup Link]
 *     summary: Public — submit a new company + admin through an owner-generated signup link. Single-use, always opens as a trial.
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       201: { description: Workspace created, returns JWT token for the new admin }
 *       404: { description: Link not found or already used }
 *       409: { description: Slug or admin email already taken }
 */
router.post(
  '/admin-signup-link/:token',
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

      const linkRes = await client.query('SELECT * FROM admin_signup_links WHERE token = $1 FOR UPDATE', [req.params.token]);
      const link = linkRes.rows[0];
      if (!link || link.used) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'invalid_or_used_link' });
      }

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

      await client.query(
        'UPDATE admin_signup_links SET used = TRUE, used_at = now(), created_company_id = $1 WHERE id = $2',
        [company.id, link.id]
      );

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

module.exports = router;
