const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const DEFAULTS = {
  quota80_notify_admin: true,
  quota80_notify_employee: false,
  edit_request_notify_admin: true,
  support_reply_notify_admin: true,
  support_reply_notify_employee: false,
  // "Also by email" toggles, alongside each in-app one above. Default off --
  // email is more intrusive than the in-app bell, so it's opt-in.
  quota80_email_admin: false,
  quota80_email_employee: false,
  edit_request_email_admin: false,
  support_reply_email_admin: false,
  support_reply_email_employee: false,
  // Admin-configured "alert me about long time entries" threshold. NULL means no
  // threshold set yet -- the notify/email flags below are meaningless until the admin
  // actively picks a number, but default TRUE/FALSE like the other admin-only alerts
  // (edit_request) so that once they do set a threshold, the in-app bell is on by
  // default and email stays opt-in.
  long_entry_threshold_minutes: null,
  long_entry_notify_admin: true,
  long_entry_email_admin: false,
};

/**
 * @openapi
 * /api/notification-settings:
 *   get:
 *     tags: [Notification Settings]
 *     summary: Get the caller's company notification preferences (defaults if never saved)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Notification settings }
 *   patch:
 *     tags: [Notification Settings]
 *     summary: Update notification preferences (admin only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated settings }
 */
router.get('/', async (req, res) => {
  if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden' });
  const { rows } = await pool.query('SELECT * FROM company_notification_settings WHERE company_id = $1', [req.auth.companyId]);
  res.json(rows[0] || { company_id: req.auth.companyId, ...DEFAULTS });
});

router.patch(
  '/',
  requireRole('admin'),
  // Only field that isn't a plain boolean (those are safely coerced with `!!` below) --
  // nullable because clearing the input field turns the alert back off entirely.
  body('long_entry_threshold_minutes').optional({ nullable: true }).isInt({ min: 1 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const merged = { ...DEFAULTS, ...req.body };
    const {
      quota80_notify_admin, quota80_notify_employee, edit_request_notify_admin,
      support_reply_notify_admin, support_reply_notify_employee,
      quota80_email_admin, quota80_email_employee, edit_request_email_admin,
      support_reply_email_admin, support_reply_email_employee,
      long_entry_threshold_minutes, long_entry_notify_admin, long_entry_email_admin,
    } = merged;
    const { rows } = await pool.query(
      `INSERT INTO company_notification_settings (
         company_id, quota80_notify_admin, quota80_notify_employee, edit_request_notify_admin,
         support_reply_notify_admin, support_reply_notify_employee,
         quota80_email_admin, quota80_email_employee, edit_request_email_admin,
         support_reply_email_admin, support_reply_email_employee,
         long_entry_threshold_minutes, long_entry_notify_admin, long_entry_email_admin
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (company_id) DO UPDATE SET
         quota80_notify_admin = $2, quota80_notify_employee = $3, edit_request_notify_admin = $4,
         support_reply_notify_admin = $5, support_reply_notify_employee = $6,
         quota80_email_admin = $7, quota80_email_employee = $8, edit_request_email_admin = $9,
         support_reply_email_admin = $10, support_reply_email_employee = $11, updated_at = now(),
         long_entry_threshold_minutes = $12, long_entry_notify_admin = $13, long_entry_email_admin = $14
       RETURNING *`,
      [req.auth.companyId, !!quota80_notify_admin, !!quota80_notify_employee, !!edit_request_notify_admin,
       !!support_reply_notify_admin, !!support_reply_notify_employee,
       !!quota80_email_admin, !!quota80_email_employee, !!edit_request_email_admin,
       !!support_reply_email_admin, !!support_reply_email_employee,
       long_entry_threshold_minutes || null, !!long_entry_notify_admin, !!long_entry_email_admin]
    );
    res.json(rows[0]);
  }
);

module.exports = router;
