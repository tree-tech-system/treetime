const crypto = require('crypto');
const express = require('express');
const { body, query, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireOwner } = require('../middleware/auth');
const { sendTestEmail, sendMail, renderEmail } = require('../lib/mailer');
const { buildAuthUrl, exchangeCodeForTokens, getUserInfo, revokeToken } = require('../lib/googleOAuth');

const router = express.Router();
const APP_URL = process.env.APP_URL || 'https://treetime.tree-tech-system.com';

// One-time CSRF-style state values for the Google OAuth redirect dance. Google's
// callback is a plain browser navigation (no Authorization header), so this Map
// is what proves *which owner* actually clicked "connect" -- the callback route
// below trusts a state only if it's a value this process itself just minted.
// In-memory is fine here: treetime-api runs as a single Node process (no
// clustering), and a state only needs to survive the few minutes between
// starting the flow and Google redirecting back.
const oauthStates = new Map(); // state -> { ownerId, expiresAt }
const STATE_TTL_MS = 10 * 60 * 1000;

function pruneStates() {
  const now = Date.now();
  for (const [state, v] of oauthStates) if (v.expiresAt < now) oauthStates.delete(state);
}

/**
 * @openapi
 * /api/owner/email/google/callback:
 *   get:
 *     tags: [Owner Email]
 *     summary: Google OAuth redirect target -- not called directly, Google redirects the browser here after consent
 *     responses:
 *       302: { description: Redirects back to the owner panel email page with a status query param }
 */
// Public on purpose: registered before router.use(authenticate, requireOwner)
// below, so it never goes through that middleware. Authenticated instead via
// the one-time state minted by POST /google/start.
router.get('/google/callback', async (req, res) => {
  const redirectBack = (qs) => res.redirect(`${APP_URL}/owner/?${qs}`);
  if (req.query.error) return redirectBack(`email_error=${encodeURIComponent(String(req.query.error))}`);

  pruneStates();
  const state = req.query.state && oauthStates.get(String(req.query.state));
  if (!state) return redirectBack(`email_error=${encodeURIComponent('פג תוקף הבקשה, נסה להתחבר שוב')}`);
  oauthStates.delete(String(req.query.state));

  try {
    const tokens = await exchangeCodeForTokens(String(req.query.code));
    if (!tokens.refresh_token) {
      // Can happen if Google decides not to re-issue a refresh_token despite
      // prompt=consent (rare) -- there's nothing useful to store, ask again.
      return redirectBack(`email_error=${encodeURIComponent('גוגל לא החזיר הרשאה מתמשכת, נסה להתחבר שוב')}`);
    }
    const info = await getUserInfo(tokens.access_token);
    await pool.query(
      `INSERT INTO google_email_accounts (email, display_name, refresh_token, connected_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, google_email_accounts.display_name),
         refresh_token = EXCLUDED.refresh_token,
         connected_by = EXCLUDED.connected_by,
         connected_at = now()`,
      [info.email, info.name || null, tokens.refresh_token, state.ownerId]
    );
    return redirectBack(`email_connected=${encodeURIComponent(info.email)}`);
  } catch (err) {
    console.error('[ownerEmail] google callback failed:', err.message);
    return redirectBack(`email_error=${encodeURIComponent('החיבור נכשל: ' + err.message)}`);
  }
});

router.use(authenticate, requireOwner);

/**
 * @openapi
 * /api/owner/email/google/start:
 *   post:
 *     tags: [Owner Email]
 *     summary: Begin the "Connect with Google" flow -- returns the consent URL to redirect the browser to
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ url }" }
 */
router.post('/google/start', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).json({ error: 'google_oauth_not_configured', message: 'החיבור ל-Google עדיין לא הוגדר בשרת (חסרים GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET).' });
  }
  pruneStates();
  const state = crypto.randomBytes(24).toString('hex');
  oauthStates.set(state, { ownerId: req.auth.ownerId, expiresAt: Date.now() + STATE_TTL_MS });
  res.json({ url: buildAuthUrl(state) });
});

/**
 * @openapi
 * /api/owner/email/accounts:
 *   get:
 *     tags: [Owner Email]
 *     summary: List every Google account connected as a possible sender
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of connected accounts (no tokens included) }
 */
router.get('/accounts', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, is_default, connected_at FROM google_email_accounts ORDER BY connected_at DESC`
  );
  res.json(rows);
});

/**
 * @openapi
 * /api/owner/email/accounts/{id}/default:
 *   patch:
 *     tags: [Owner Email]
 *     summary: Mark a connected Google account as the default sender (unsets any previous default)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated }
 *       404: { description: No such connected account }
 */
router.patch('/accounts/:id/default', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE google_email_accounts SET is_default = FALSE WHERE is_default = TRUE');
    const { rows } = await client.query(
      `UPDATE google_email_accounts SET is_default = TRUE WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

/**
 * @openapi
 * /api/owner/email/accounts/{id}:
 *   delete:
 *     tags: [Owner Email]
 *     summary: Disconnect a Google account (best-effort token revoke, then delete)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Disconnected }
 *       404: { description: No such connected account }
 */
router.delete('/accounts/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT refresh_token FROM google_email_accounts WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  await pool.query('DELETE FROM google_email_accounts WHERE id = $1', [req.params.id]);
  revokeToken(rows[0].refresh_token); // best-effort, never blocks the response
  res.json({ ok: true });
});

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
 *     summary: Send a test email through the currently active sender (default Google account if one is set, else SMTP)
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
 *       400: { description: No sender configured or the send failed -- message has the real error }
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
 * /api/owner/email/log:
 *   get:
 *     tags: [Owner Email]
 *     summary: Audit trail of every email TreeTime has attempted to send, newest first
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ items, total }" }
 */
router.get(
  '/log',
  query('limit').optional().isInt({ min: 1, max: 200 }),
  query('offset').optional().isInt({ min: 0 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const { rows } = await pool.query(
      `SELECT id, to_email, subject, category, sender, status, error, sent_at
       FROM email_send_log ORDER BY sent_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS n FROM email_send_log');
    res.json({ items: rows, total: countRows[0].n });
  }
);

/**
 * @openapi
 * /api/owner/email/recipients:
 *   get:
 *     tags: [Owner Email]
 *     summary: Every active employee across every company, for manually picking broadcast recipients
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of active employees with their company name }
 */
router.get('/recipients', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT e.id, e.full_name, e.email, e.role, c.name AS company_name
     FROM employees e JOIN companies c ON c.id = e.company_id
     WHERE e.active = TRUE
     ORDER BY c.name, e.full_name`
  );
  res.json(rows);
});

const BROADCAST_TARGETS = ['admins', 'all', 'manual'];

/**
 * @openapi
 * /api/owner/email/broadcast:
 *   post:
 *     tags: [Owner Email]
 *     summary: Send an email to a chosen set of recipients across the platform
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
 *               target: { type: string, enum: [admins, all, manual], description: "admins (default): every active admin. all: every active employee. manual: only employee_ids." }
 *               employee_ids: { type: array, items: { type: integer } }
 *     responses:
 *       200: { description: Number of recipients the broadcast was sent to }
 */
router.post(
  '/broadcast',
  body('subject').isString().trim().notEmpty(),
  body('body').isString().trim().notEmpty(),
  body('target').optional().isIn(BROADCAST_TARGETS),
  body('employee_ids').optional().isArray(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const target = req.body.target || 'admins';
    let rows;
    if (target === 'admins') {
      ({ rows } = await pool.query(`SELECT email FROM employees WHERE role = 'admin' AND active = TRUE`));
    } else if (target === 'all') {
      ({ rows } = await pool.query(`SELECT email FROM employees WHERE active = TRUE`));
    } else {
      const ids = (req.body.employee_ids || []).map(Number).filter(Number.isInteger);
      if (!ids.length) return res.status(400).json({ error: 'validation_error', message: 'employee_ids is required when target is "manual"' });
      ({ rows } = await pool.query(`SELECT email FROM employees WHERE id = ANY($1) AND active = TRUE`, [ids]));
    }

    const html = renderEmail(req.body.subject, String(req.body.body).replace(/\n/g, '<br>'));
    await Promise.all(rows.map((r) => sendMail({ to: r.email, subject: req.body.subject, html, category: 'broadcast' })));
    res.json({ ok: true, sent_count: rows.length });
  }
);

module.exports = router;
