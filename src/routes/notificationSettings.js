const express = require('express');
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

router.patch('/', requireRole('admin'), async (req, res) => {
  const merged = { ...DEFAULTS, ...req.body };
  const {
    quota80_notify_admin, quota80_notify_employee, edit_request_notify_admin,
    support_reply_notify_admin, support_reply_notify_employee,
    quota80_email_admin, quota80_email_employee, edit_request_email_admin,
    support_reply_email_admin, support_reply_email_employee,
  } = merged;
  const { rows } = await pool.query(
    `INSERT INTO company_notification_settings (
       company_id, quota80_notify_admin, quota80_notify_employee, edit_request_notify_admin,
       support_reply_notify_admin, support_reply_notify_employee,
       quota80_email_admin, quota80_email_employee, edit_request_email_admin,
       support_reply_email_admin, support_reply_email_employee
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (company_id) DO UPDATE SET
       quota80_notify_admin = $2, quota80_notify_employee = $3, edit_request_notify_admin = $4,
       support_reply_notify_admin = $5, support_reply_notify_employee = $6,
       quota80_email_admin = $7, quota80_email_employee = $8, edit_request_email_admin = $9,
       support_reply_email_admin = $10, support_reply_email_employee = $11, updated_at = now()
     RETURNING *`,
    [req.auth.companyId, !!quota80_notify_admin, !!quota80_notify_employee, !!edit_request_notify_admin,
     !!support_reply_notify_admin, !!support_reply_notify_employee,
     !!quota80_email_admin, !!quota80_email_employee, !!edit_request_email_admin,
     !!support_reply_email_admin, !!support_reply_email_employee]
  );
  res.json(rows[0]);
});

module.exports = router;
