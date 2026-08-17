const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireOwner } = require('../middleware/auth');

const router = express.Router();

function signOwnerToken(owner) {
  return jwt.sign({ sub: owner.id, type: 'owner' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  });
}

/**
 * @openapi
 * /api/owner/auth/login:
 *   post:
 *     tags: [Owner]
 *     summary: TreeTime owner/staff login (separate account space from client employees)
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200: { description: Login successful }
 *       401: { description: Invalid credentials }
 */
router.post('/login', body('email').isEmail(), body('password').isString(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });
  const { email, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM owners WHERE email = $1', [email]);
  const owner = rows[0];
  if (!owner || !(await bcrypt.compare(password, owner.password_hash))) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  res.json({ token: signOwnerToken(owner), owner: { id: owner.id, full_name: owner.full_name, email: owner.email } });
});

/**
 * @openapi
 * /api/owner/auth/me:
 *   get:
 *     tags: [Owner]
 *     summary: Get the currently authenticated owner
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Current owner profile }
 */
router.get('/me', authenticate, requireOwner, async (req, res) => {
  const { rows } = await pool.query('SELECT id, full_name, email, created_at FROM owners WHERE id = $1', [req.auth.ownerId]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

/**
 * @openapi
 * /api/owner/auth/change-password:
 *   post:
 *     tags: [Owner]
 *     summary: Change your own owner password
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
  requireOwner,
  body('current_password').isString(),
  body('new_password').isString().isLength({ min: 8 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const { rows } = await pool.query('SELECT * FROM owners WHERE id = $1', [req.auth.ownerId]);
    const owner = rows[0];
    if (!owner || !(await bcrypt.compare(req.body.current_password, owner.password_hash))) {
      return res.status(401).json({ error: 'invalid_current_password', message: 'הסיסמה הנוכחית שגויה.' });
    }
    const password_hash = await bcrypt.hash(req.body.new_password, 12);
    await pool.query('UPDATE owners SET password_hash = $1 WHERE id = $2', [password_hash, owner.id]);
    res.json({ ok: true });
  }
);

module.exports = router;
