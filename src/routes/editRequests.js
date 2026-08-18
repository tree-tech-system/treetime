const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { notifyAdmins, notifyEmployee } = require('../lib/notify');
const { sendAdminEmails } = require('../lib/mailer');

const router = express.Router();
router.use(authenticate);

/**
 * @openapi
 * /api/edit-requests:
 *   get:
 *     tags: [Edit Requests]
 *     summary: List edit requests (admins see all in the company; freelancers see only their own)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of edit requests }
 *   post:
 *     tags: [Edit Requests]
 *     summary: Request a correction to one of your own time entries
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [entry_id, reason]
 *             properties:
 *               entry_id: { type: integer }
 *               reason: { type: string }
 *     responses:
 *       201: { description: Edit request created }
 */
router.get('/', async (req, res) => {
  if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden' });
  const isAdmin = ['admin', 'manager'].includes(req.auth.role);
  const conditions = ['er.company_id = $1'];
  const params = [req.auth.companyId];
  if (!isAdmin) { params.push(req.auth.employeeId); conditions.push(`er.employee_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT er.*, e.full_name AS employee_name, t.description AS entry_description, t.started_at, t.ended_at
     FROM edit_requests er
     JOIN employees e ON e.id = er.employee_id
     JOIN time_entries t ON t.id = er.entry_id
     WHERE ${conditions.join(' AND ')} ORDER BY er.requested_at DESC`,
    params
  );
  res.json(rows);
});

router.post('/', body('entry_id').isInt(), body('reason').isString().trim().notEmpty(), async (req, res) => {
  if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden' });
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

  const entry = await pool.query('SELECT id FROM time_entries WHERE id = $1 AND employee_id = $2 AND company_id = $3', [
    req.body.entry_id, req.auth.employeeId, req.auth.companyId,
  ]);
  if (!entry.rows[0]) return res.status(404).json({ error: 'entry_not_found' });

  const { rows } = await pool.query(
    `INSERT INTO edit_requests (company_id, entry_id, employee_id, reason) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.auth.companyId, req.body.entry_id, req.auth.employeeId, req.body.reason]
  );

  const settings = await pool.query(
    'SELECT edit_request_notify_admin, edit_request_email_admin FROM company_notification_settings WHERE company_id = $1',
    [req.auth.companyId]
  );
  const s = settings.rows[0] || {};
  if (s.edit_request_notify_admin !== false || s.edit_request_email_admin) {
    const emp = await pool.query('SELECT full_name FROM employees WHERE id = $1', [req.auth.employeeId]);
    const summary = `${emp.rows[0].full_name}: ${req.body.reason}`;
    if (s.edit_request_notify_admin !== false) {
      notifyAdmins(req.auth.companyId, 'edit_request', 'בקשת עריכת דיווח חדשה', summary, 'editRequests');
    }
    if (s.edit_request_email_admin) {
      sendAdminEmails(req.auth.companyId, 'בקשת עריכת דיווח חדשה', summary, 'edit_request').catch(() => {});
    }
  }

  res.status(201).json(rows[0]);
});

/**
 * @openapi
 * /api/edit-requests/{id}:
 *   patch:
 *     tags: [Edit Requests]
 *     summary: Approve or reject an edit request (admin/manager only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [approved, rejected] }
 *               admin_note: { type: string }
 *     responses:
 *       200: { description: Updated edit request }
 */
router.patch('/:id', requireRole('manager', 'admin'), async (req, res) => {
  const { status, admin_note } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const { rows } = await pool.query(
    `UPDATE edit_requests SET status = $1, admin_note = COALESCE($2, admin_note), resolved_at = now()
     WHERE id = $3 AND company_id = $4 RETURNING *`,
    [status, admin_note, req.params.id, req.auth.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });

  notifyEmployee(
    rows[0].employee_id, 'edit_request_resolved',
    status === 'approved' ? 'בקשת העריכה שלך אושרה' : 'בקשת העריכה שלך נדחתה',
    admin_note || null, 'editRequests'
  );

  res.json(rows[0]);
});

module.exports = router;
