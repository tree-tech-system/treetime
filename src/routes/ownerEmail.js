const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireOwner } = require('../middleware/auth');
const { sendTestEmail, sendMail, renderEmail } = require('../lib/mailer');

const router = express.Router();
router.use(authenticate, requireOwner);

/**
 * @openapi
 * /api/owner/email/settings:
 *   get:
 *     tags: [Owner Email]
 *     summary: Get the current outbound SMTP configuration (password never returned)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: SMTP settings, plus how many active company admins exist }
 *   patch:
 *     tags: [Owner Email]
 *     summary: Update the outbound SMTP configuration
 *     description: >
 *       Leave `password` empty/omitted to keep the currently saved password unchanged --
 *       you don't have to re-enter it just to tweak the host or from-address.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               host: { type: string }
 *               port: { type: integer }
 *               secure: { type: boolean }
 *               username: { type: string }
 *               password: { type: string, description: "Omit or leave blank to keep the existing password" }
 *               from_name: { type: string }
 *               from_email: { type: string, format: email }
 *     responses:
 *       200: { description: Updated settings }
 */
router.get('/settings', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM smtp_settings WHERE id = 1');
  const s = rows[0] || {};
  const { rows: adminCountRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM employees WHERE role = 'admin' AND active = TRUE`);
  res.json({
    host: s.host || null,
    port: s.port || null,
    secure: !!s.secure,
    username: s.username || null,
    password_set: !!s.password,
    from_name: s.from_name || null,
    from_email: s.from_email || null,
    updated_at: s.updated_at || null,
    admin_count: adminCountRows[0].n,
  });
});

router.patch(
  '/settings',
  body('port').optional({ nullable: true }).isInt({ min: 1, max: 65535 }),
  body('from_email').optional({ nullable: true, checkFalsy: true }).isEmail(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const { host, port, secure, username, password, from_name, from_email } = req.body;
    // pg rejects a raw `undefined` parameter, so coerce "not provided" to an explicit
    // null for every field (COALESCE then keeps whatever was already saved).
    const secureVal = secure === true || secure === false ? secure : null;
    const { rows } = await pool.query(
      `INSERT INTO smtp_settings (id, host, port, secure, username, password, from_name, from_email, updated_by)
       VALUES (1, $1, $2, COALESCE($3, FALSE), $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         host = COALESCE($1, smtp_settings.host),
         port = COALESCE($2, smtp_settings.port),
         secure = COALESCE($3, smtp_settings.secure),
         username = COALESCE($4, smtp_settings.username),
         password = COALESCE($5, smtp_settings.password),
         from_name = COALESCE($6, smtp_settings.from_name),
         from_email = COALESCE($7, smtp_settings.from_email),
         updated_at = now(), updated_by = $8
       RETURNING *`,
      [host || null, port || null, secureVal, username || null, password || null, from_name || null, from_email || null, req.auth.ownerId]
    );
    const s = rows[0];
    res.json({
      host: s.host, port: s.port, secure: s.secure, username: s.username,
      password_set: !!s.password, from_name: s.from_name, from_email: s.from_email, updated_at: s.updated_at,
    });
  }
);

/**
 * @openapi
 * /api/owner/email/test-email:
 *   post:
 *     tags: [Owner Email]
 *     summary: Send a test email through the currently saved SMTP settings
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [to]
 *             properties:
 *               to: { type: string, format: email }
 *     responses:
 *       200: { description: Sent }
 *       400: { description: SMTP not configured or the send failed — message has the real error }
 */
router.post('/test-email', body('to').isEmail(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });
  try {
    await sendTestEmail(req.body.to);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: 'send_failed', message: err.message });
  }
});

/**
 * @openapi
 * /api/owner/email/broadcast:
 *   post:
 *     tags: [Owner Email]
 *     summary: Send an email to every active admin, across every company on the platform
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subject, body]
 *             properties:
 *               subject: { type: string }
 *               body: { type: string, description: "Plain text; line breaks become <br>" }
 *     responses:
 *       200: { description: Number of admins the broadcast was sent to }
 */
router.post(
  '/broadcast',
  body('subject').isString().trim().notEmpty(),
  body('body').isString().trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const { rows } = await pool.query(`SELECT email FROM employees WHERE role = 'admin' AND active = TRUE`);
    const html = renderEmail(req.body.subject, String(req.body.body).replace(/\n/g, '<br>'));
    await Promise.all(rows.map((r) => sendMail({ to: r.email, subject: req.body.subject, html })));
    res.json({ ok: true, sent_count: rows.length });
  }
);

module.exports = router;
