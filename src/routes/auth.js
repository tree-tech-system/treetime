const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { consumeAuthToken } = require('../lib/authTokens');
const { sendWelcomeEmail, sendPasswordResetEmail, sendPasswordChangedEmail } = require('../lib/authEmails');

const router = express.Router();

function signToken(employee) {
  return jwt.sign({ sub: employee.id, role: employee.role, company_id: employee.company_id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  });
}

/**
 * @openapi
 * /api/auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Create a new employee account within an existing company
 *     description: >
 *       New companies are onboarded by a TreeTime owner via the owner panel, which also
 *       creates that company's first admin account. Use this endpoint to add additional
 *       employees to an *existing* company (requires its company_id).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [full_name, email, password, company_id]
 *             properties:
 *               full_name: { type: string }
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *               company_id: { type: integer }
 *     responses:
 *       201: { description: Account created, returns JWT token }
 *       404: { description: Unknown company_id }
 *       409: { description: Email already registered }
 */
router.post(
  '/register',
  body('full_name').isString().trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('password').isString().isLength({ min: 8 }),
  body('company_id').isInt(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const { full_name, email, password, company_id } = req.body;
    const company = await pool.query('SELECT id FROM companies WHERE id = $1', [company_id]);
    if (!company.rows[0]) return res.status(404).json({ error: 'company_not_found' });

    const password_hash = await bcrypt.hash(password, 12);
    try {
      const { rows } = await pool.query(
        `INSERT INTO employees (full_name, email, password_hash, company_id)
         VALUES ($1, $2, $3, $4) RETURNING id, full_name, email, role, company_id`,
        [full_name, email, password_hash, company_id]
      );
      const employee = rows[0];
      sendWelcomeEmail(employee, null).catch(() => {});
      res.status(201).json({ token: signToken(employee), employee });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'email_taken', message: 'Email already registered.' });
      throw err;
    }
  }
);

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Log in and receive a JWT access token
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200: { description: Login successful, returns JWT token }
 *       401: { description: Invalid credentials }
 */
router.post('/login', body('email').isEmail(), body('password').isString(), async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM employees WHERE email = $1 AND active = TRUE', [email]);
  const employee = rows[0];
  if (!employee || !(await bcrypt.compare(password, employee.password_hash))) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Email or password is incorrect.' });
  }
  const company = await pool.query('SELECT name, slug FROM companies WHERE id = $1', [employee.company_id]);
  res.json({
    token: signToken(employee),
    employee: {
      id: employee.id, public_id: employee.public_id, full_name: employee.full_name, email: employee.email, role: employee.role,
      company_id: employee.company_id, company_name: company.rows[0]?.name, company_slug: company.rows[0]?.slug,
    },
  });
});

/**
 * @openapi
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get the currently authenticated employee
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Current employee profile }
 */
router.get('/me', authenticate, async (req, res) => {
  if (req.auth.type !== 'user') return res.status(400).json({ error: 'not_a_user_token' });
  const { rows } = await pool.query(
    `SELECT e.id, e.public_id, e.full_name, e.email, e.role, e.company_id, c.name AS company_name, c.slug AS company_slug
     FROM employees e JOIN companies c ON c.id = e.company_id WHERE e.id = $1`,
    [req.auth.employeeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

/**
 * @openapi
 * /api/auth/change-password:
 *   post:
 *     tags: [Auth]
 *     summary: Change your own password (any logged-in employee, any role)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [current_password, new_password]
 *             properties:
 *               current_password: { type: string }
 *               new_password: { type: string, minLength: 8 }
 *     responses:
 *       200: { description: Password changed }
 *       401: { description: Current password is incorrect }
 */
router.post(
  '/change-password',
  authenticate,
  body('current_password').isString(),
  body('new_password').isString().isLength({ min: 8 }),
  async (req, res) => {
    if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden' });
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const { rows } = await pool.query('SELECT * FROM employees WHERE id = $1', [req.auth.employeeId]);
    const employee = rows[0];
    if (!employee || !(await bcrypt.compare(req.body.current_password, employee.password_hash))) {
      return res.status(401).json({ error: 'invalid_current_password', message: 'הסיסמה הנוכחית שגויה.' });
    }
    const password_hash = await bcrypt.hash(req.body.new_password, 12);
    await pool.query('UPDATE employees SET password_hash = $1 WHERE id = $2', [password_hash, employee.id]);
    sendPasswordChangedEmail(employee).catch(() => {});
    res.json({ ok: true });
  }
);

/**
 * @openapi
 * /api/auth/forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: Request a password reset link by email
 *     description: >
 *       Always responds with a generic success message, whether or not the email is
 *       registered, so this endpoint can't be used to check which emails have accounts.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200: { description: Always returns ok, regardless of whether the email exists }
 */
router.post('/forgot-password', body('email').isEmail(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

  const { rows } = await pool.query('SELECT * FROM employees WHERE email = $1 AND active = TRUE', [req.body.email]);
  if (rows[0]) sendPasswordResetEmail(rows[0]).catch(() => {});
  res.json({ ok: true, message: 'אם קיים חשבון עם האימייל הזה, נשלח אליו קישור לאיפוס סיסמה.' });
});

/**
 * @openapi
 * /api/auth/reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: Set a new password using a token from the forgot-password email
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, new_password]
 *             properties:
 *               token: { type: string }
 *               new_password: { type: string, minLength: 8 }
 *     responses:
 *       200: { description: Password reset }
 *       400: { description: Token is invalid, expired, or already used }
 */
router.post(
  '/reset-password',
  body('token').isString().notEmpty(),
  body('new_password').isString().isLength({ min: 8 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const employeeId = await consumeAuthToken(req.body.token, 'password_reset');
    if (!employeeId) return res.status(400).json({ error: 'invalid_token', message: 'הקישור פג תוקף או שכבר נוצל. יש לבקש קישור חדש.' });

    const password_hash = await bcrypt.hash(req.body.new_password, 12);
    const { rows } = await pool.query('UPDATE employees SET password_hash = $1 WHERE id = $2 RETURNING *', [password_hash, employeeId]);
    sendPasswordChangedEmail(rows[0]).catch(() => {});
    res.json({ ok: true });
  }
);

/**
 * @openapi
 * /api/auth/confirm-email:
 *   post:
 *     tags: [Auth]
 *     summary: Confirm an employee's email address using a token from the welcome email
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token: { type: string }
 *     responses:
 *       200: { description: Email confirmed }
 *       400: { description: Token is invalid, expired, or already used }
 */
router.post('/confirm-email', body('token').isString().notEmpty(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

  const employeeId = await consumeAuthToken(req.body.token, 'email_confirm');
  if (!employeeId) return res.status(400).json({ error: 'invalid_token', message: 'הקישור פג תוקף או שכבר נוצל.' });

  await pool.query('UPDATE employees SET email_confirmed_at = now() WHERE id = $1', [employeeId]);
  res.json({ ok: true });
});

module.exports = router;
