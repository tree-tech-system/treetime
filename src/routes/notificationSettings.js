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
  } = merged;
  const { rows } = await pool.query(
    `INSERT INTO company_notification_settings (
       company_id, quota80_notify_admin, quota80_notify_employee, edit_request_notify_admin,
       support_reply_notify_admin, support_reply_notify_employee
     ) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (company_id) DO UPDATE SET
       quota80_notify_admin = $2, quota80_notify_employee = $3, edit_request_notify_admin = $4,
       support_reply_notify_admin = $5, support_reply_notify_employee = $6, updated_at = now()
     RETURNING *`,
    [req.auth.companyId, !!quota80_notify_admin, !!quota80_notify_employee, !!edit_request_notify_admin,
     !!support_reply_notify_admin, !!support_reply_notify_employee]
  );
  res.json(rows[0]);
});

module.exports = router;
