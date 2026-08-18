const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireOwner } = require('../middleware/auth');
const { notifyAdmins, notifyEmployee } = require('../lib/notify');
const { sendAdminEmails, sendEmployeeEmailById } = require('../lib/mailer');

const router = express.Router();
router.use(authenticate, requireOwner);

/**
 * @openapi
 * /api/owner/tickets:
 *   get:
 *     tags: [Owner]
 *     summary: List support tickets across all companies
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [open, pending, closed] }
 *       - in: query
 *         name: company_id
 *         schema: { type: integer }
 *     responses:
 *       200: { description: List of tickets with company name }
 */
router.get('/', async (req, res) => {
  const conditions = [];
  const params = [];
  if (req.query.status) { params.push(req.query.status); conditions.push(`s.status = $${params.length}`); }
  if (req.query.company_id) { params.push(req.query.company_id); conditions.push(`s.company_id = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT s.*, c.name AS company_name
     FROM support_tickets s JOIN companies c ON c.id = s.company_id
     ${where} ORDER BY s.updated_at DESC`,
    params
  );
  res.json(rows);
});

/**
 * @openapi
 * /api/owner/tickets/{id}:
 *   get:
 *     tags: [Owner]
 *     summary: Get a ticket with its full message thread
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Ticket with messages }
 */
router.get('/:id', async (req, res) => {
  const ticketRes = await pool.query(
    `SELECT s.*, c.name AS company_name FROM support_tickets s JOIN companies c ON c.id = s.company_id WHERE s.id = $1`,
    [req.params.id]
  );
  if (!ticketRes.rows[0]) return res.status(404).json({ error: 'not_found' });
  const messages = await pool.query('SELECT * FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at', [req.params.id]);
  res.json({ ticket: ticketRes.rows[0], messages: messages.rows });
});

/**
 * @openapi
 * /api/owner/tickets/{id}:
 *   patch:
 *     tags: [Owner]
 *     summary: Update a ticket's status or priority
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
 *             properties:
 *               status: { type: string, enum: [open, pending, closed] }
 *               priority: { type: string, enum: [low, normal, high, urgent] }
 *     responses:
 *       200: { description: Updated ticket }
 */
router.patch('/:id', async (req, res) => {
  const { status, priority } = req.body;
  const { rows } = await pool.query(
    `UPDATE support_tickets SET status = COALESCE($1, status), priority = COALESCE($2, priority), updated_at = now()
     WHERE id = $3 RETURNING *`,
    [status, priority, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

/**
 * @openapi
 * /api/owner/tickets/{id}/messages:
 *   post:
 *     tags: [Owner]
 *     summary: Reply to a client's support ticket
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
 *             required: [body]
 *             properties:
 *               body: { type: string }
 *     responses:
 *       201: { description: Message added }
 */
router.post('/:id/messages', body('body').isString().trim().notEmpty(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

  const ticketRes = await pool.query('SELECT * FROM support_tickets WHERE id = $1', [req.params.id]);
  if (!ticketRes.rows[0]) return res.status(404).json({ error: 'not_found' });

  const ownerRes = await pool.query('SELECT full_name FROM owners WHERE id = $1', [req.auth.ownerId]);
  const { rows } = await pool.query(
    `INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_name, body) VALUES ($1,'owner',$2,$3) RETURNING *`,
    [req.params.id, ownerRes.rows[0].full_name, req.body.body]
  );
  await pool.query(`UPDATE support_tickets SET status = 'pending', updated_at = now() WHERE id = $1`, [req.params.id]);

  const ticket = ticketRes.rows[0];
  const settings = await pool.query(
    `SELECT support_reply_notify_admin, support_reply_notify_employee,
            support_reply_email_admin, support_reply_email_employee
     FROM company_notification_settings WHERE company_id = $1`,
    [ticket.company_id]
  );
  const s = settings.rows[0] || {};
  const subject = `תגובה חדשה מ-TreeTime בפנייה: ${ticket.subject}`;
  if (s.support_reply_notify_admin !== false) {
    notifyAdmins(ticket.company_id, 'ticket_owner_reply', subject, req.body.body, 'support');
  }
  if (s.support_reply_notify_employee && ticket.employee_id) {
    notifyEmployee(ticket.employee_id, 'ticket_owner_reply', subject, req.body.body, 'support');
  }
  if (s.support_reply_email_admin) {
    sendAdminEmails(ticket.company_id, subject, req.body.body, 'support_reply').catch(() => {});
  }
  if (s.support_reply_email_employee && ticket.employee_id) {
    sendEmployeeEmailById(ticket.employee_id, subject, req.body.body, 'support_reply').catch(() => {});
  }

  res.status(201).json(rows[0]);
});

module.exports = router;
