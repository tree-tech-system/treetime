const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const { notifyOwners } = require('../lib/notify');

const router = express.Router();
router.use(authenticate);

function requireUser(req, res, next) {
  if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden', message: 'Support tickets are for logged-in employees only.' });
  next();
}

/**
 * @openapi
 * /api/tickets:
 *   get:
 *     tags: [Support]
 *     summary: List support tickets opened by your company
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of tickets }
 *   post:
 *     tags: [Support]
 *     summary: Open a new support ticket to the TreeTime team
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subject, message]
 *             properties:
 *               subject: { type: string }
 *               message: { type: string }
 *               priority: { type: string, enum: [low, normal, high, urgent] }
 *     responses:
 *       201: { description: Ticket created }
 */
router.get('/', requireUser, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM support_tickets WHERE company_id = $1 ORDER BY updated_at DESC',
    [req.auth.companyId]
  );
  res.json(rows);
});

router.post(
  '/',
  requireUser,
  body('subject').isString().trim().notEmpty(),
  body('message').isString().trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const { subject, message, priority } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ticketRes = await client.query(
        `INSERT INTO support_tickets (company_id, employee_id, subject, priority)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.auth.companyId, req.auth.employeeId, subject, ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : 'normal']
      );
      const ticket = ticketRes.rows[0];
      const empRes = await client.query('SELECT full_name FROM employees WHERE id = $1', [req.auth.employeeId]);
      await client.query(
        `INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_name, body) VALUES ($1,'employee',$2,$3)`,
        [ticket.id, empRes.rows[0].full_name, message]
      );
      await client.query('COMMIT');
      const companyRes = await pool.query('SELECT name FROM companies WHERE id = $1', [req.auth.companyId]);
      notifyOwners('new_ticket', `פנייה חדשה: ${subject}`, `${companyRes.rows[0]?.name || ''} — ${empRes.rows[0].full_name}: ${message}`, 'tickets');
      res.status(201).json(ticket);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
);

/**
 * @openapi
 * /api/tickets/{id}:
 *   get:
 *     tags: [Support]
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
router.get('/:id', requireUser, async (req, res) => {
  const ticketRes = await pool.query('SELECT * FROM support_tickets WHERE id = $1 AND company_id = $2', [req.params.id, req.auth.companyId]);
  if (!ticketRes.rows[0]) return res.status(404).json({ error: 'not_found' });
  const messages = await pool.query('SELECT * FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at', [req.params.id]);
  res.json({ ticket: ticketRes.rows[0], messages: messages.rows });
});

/**
 * @openapi
 * /api/tickets/{id}/messages:
 *   post:
 *     tags: [Support]
 *     summary: Reply to your own support ticket
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
router.post('/:id/messages', requireUser, body('body').isString().trim().notEmpty(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

  const ticketRes = await pool.query('SELECT * FROM support_tickets WHERE id = $1 AND company_id = $2', [req.params.id, req.auth.companyId]);
  if (!ticketRes.rows[0]) return res.status(404).json({ error: 'not_found' });
  if (ticketRes.rows[0].status === 'closed') {
    return res.status(403).json({ error: 'ticket_closed', message: 'הפנייה סגורה. יש לפתוח פנייה חדשה.' });
  }

  const empRes = await pool.query('SELECT full_name FROM employees WHERE id = $1', [req.auth.employeeId]);
  const { rows } = await pool.query(
    `INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_name, body) VALUES ($1,'employee',$2,$3) RETURNING *`,
    [req.params.id, empRes.rows[0].full_name, req.body.body]
  );
  await pool.query(`UPDATE support_tickets SET status = 'open', updated_at = now() WHERE id = $1`, [req.params.id]);
  const companyRes = await pool.query('SELECT name FROM companies WHERE id = $1', [req.auth.companyId]);
  notifyOwners('ticket_reply', `תגובה חדשה בפנייה: ${ticketRes.rows[0].subject}`, `${companyRes.rows[0]?.name || ''} — ${empRes.rows[0].full_name}: ${req.body.body}`, 'tickets');
  res.status(201).json(rows[0]);
});

module.exports = router;
