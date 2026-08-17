const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

function requireUser(req, res, next) {
  if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden' });
  next();
}

/**
 * @openapi
 * /api/notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: List notifications for the logged-in employee — personal ones, plus company-wide admin alerts if they're an admin/manager
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of notifications, newest first }
 */
router.get('/', requireUser, async (req, res) => {
  const isAdmin = ['admin', 'manager'].includes(req.auth.role);
  const { rows } = await pool.query(
    `SELECT * FROM notifications
     WHERE (scope = 'employee' AND employee_id = $1)
        OR (scope = 'admin' AND company_id = $2 AND $3)
     ORDER BY created_at DESC LIMIT 100`,
    [req.auth.employeeId, req.auth.companyId, isAdmin]
  );
  res.json(rows);
});

/**
 * @openapi
 * /api/notifications/{id}/read:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark one notification as read
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated }
 */
router.patch('/:id/read', requireUser, async (req, res) => {
  const isAdmin = ['admin', 'manager'].includes(req.auth.role);
  const { rows } = await pool.query(
    `UPDATE notifications SET read = TRUE
     WHERE id = $1 AND ((scope = 'employee' AND employee_id = $2) OR (scope = 'admin' AND company_id = $3 AND $4))
     RETURNING *`,
    [req.params.id, req.auth.employeeId, req.auth.companyId, isAdmin]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

/**
 * @openapi
 * /api/notifications/read-all:
 *   post:
 *     tags: [Notifications]
 *     summary: Mark all of the caller's notifications as read
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Count marked read }
 */
router.post('/read-all', requireUser, async (req, res) => {
  const isAdmin = ['admin', 'manager'].includes(req.auth.role);
  const { rowCount } = await pool.query(
    `UPDATE notifications SET read = TRUE
     WHERE read = FALSE AND ((scope = 'employee' AND employee_id = $1) OR (scope = 'admin' AND company_id = $2 AND $3))`,
    [req.auth.employeeId, req.auth.companyId, isAdmin]
  );
  res.json({ marked: rowCount });
});

module.exports = router;
