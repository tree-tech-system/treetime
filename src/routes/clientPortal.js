const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { notifyAdmins } = require('../lib/notify');

const router = express.Router();

async function findActivePortalLink(token) {
  const { rows } = await pool.query(
    `SELECT l.id AS link_id, l.project_id, l.company_id, p.archived
     FROM client_portal_links l
     JOIN projects p ON p.id = l.project_id
     WHERE l.token = $1`,
    [token]
  );
  const row = rows[0];
  return row && !row.archived ? row : null;
}

/**
 * @openapi
 * /api/client-portal-links:
 *   post:
 *     tags: [Client Portal]
 *     summary: >
 *       Get-or-create the persistent portal link for a client (admin only). The
 *       link stays the same across calls -- calling this again just returns the
 *       existing token instead of rotating it.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [project_id]
 *             properties:
 *               project_id: { type: integer }
 *     responses:
 *       200: { description: Existing or newly created link }
 */
router.post('/client-portal-links', authenticate, requireRole('admin'), async (req, res) => {
  const projectId = req.body.project_id;
  if (!projectId) return res.status(400).json({ error: 'validation_error', message: 'project_id is required' });

  const project = await pool.query('SELECT id FROM projects WHERE id = $1 AND company_id = $2', [projectId, req.auth.companyId]);
  if (!project.rows[0]) return res.status(404).json({ error: 'not_found' });

  const existing = await pool.query('SELECT * FROM client_portal_links WHERE project_id = $1', [projectId]);
  if (existing.rows[0]) return res.json(existing.rows[0]);

  const token = crypto.randomBytes(20).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO client_portal_links (company_id, project_id, token, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.auth.companyId, projectId, token, req.auth.employeeId]
  );
  res.status(201).json(rows[0]);
});

/**
 * @openapi
 * /api/client-portal/{token}:
 *   get:
 *     tags: [Client Portal]
 *     summary: Public -- read-only mirror of a client's card (info, quota, tasks, time entries)
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Client portal data }
 *       404: { description: Link not found, or the client is archived }
 */
router.get('/client-portal/:token', async (req, res) => {
  const linkRes = await pool.query(
    `SELECT l.*, p.*, l.id AS link_id, l.created_at AS link_created_at, c.name AS company_name
     FROM client_portal_links l
     JOIN projects p ON p.id = l.project_id
     JOIN companies c ON c.id = l.company_id
     WHERE l.token = $1`,
    [req.params.token]
  );
  const row = linkRes.rows[0];
  if (!row || row.archived) return res.status(404).json({ error: 'invalid_link' });

  pool.query('UPDATE client_portal_links SET last_viewed_at = now() WHERE id = $1', [row.link_id]).catch(() => {});

  const [fieldsRes, entriesRes, tasksRes, monthUsageRes] = await Promise.all([
    pool.query(
      `SELECT f.id, f.key, f.label, f.field_type, fv.value, fv.file_name
       FROM company_client_fields f
       LEFT JOIN project_field_values fv ON fv.field_id = f.id AND fv.project_id = $1
       WHERE f.company_id = $2 AND f.active = TRUE
       ORDER BY f.sort_order, f.created_at`,
      [row.project_id, row.company_id]
    ),
    pool.query(
      `SELECT te.id, te.description, te.started_at, te.ended_at, e.full_name AS employee_name
       FROM time_entries te
       LEFT JOIN employees e ON e.id = te.employee_id
       WHERE te.project_id = $1 AND te.company_id = $2 AND te.ended_at IS NOT NULL
       ORDER BY te.started_at DESC LIMIT 200`,
      [row.project_id, row.company_id]
    ),
    pool.query(
      `SELECT id, description, deadline, status, created_at
       FROM tasks WHERE project_id = $1 AND company_id = $2
       ORDER BY (deadline IS NULL), deadline ASC, created_at DESC`,
      [row.project_id, row.company_id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60), 0) AS minutes
       FROM time_entries
       WHERE project_id = $1 AND company_id = $2 AND ended_at IS NOT NULL
         AND started_at >= date_trunc('month', now())`,
      [row.project_id, row.company_id]
    ),
  ]);

  res.json({
    company_name: row.company_name,
    client: {
      name: row.name,
      business_name: row.business_name,
      contact_phone: row.contact_phone,
      contact_email: row.contact_email,
      description: row.description,
      use_hours_bank: row.use_hours_bank,
      monthly_quota_hours: Number(row.monthly_quota_hours) || 0,
      payment_method: row.payment_method,
    },
    custom_fields: fieldsRes.rows,
    time_entries: entriesRes.rows,
    tasks: tasksRes.rows,
    month_used_minutes: Number(monthUsageRes.rows[0].minutes) || 0,
  });
});

/**
 * @openapi
 * /api/client-portal/{token}/tasks:
 *   post:
 *     tags: [Client Portal]
 *     summary: Public -- let the client open a task through their portal link. Unassigned, tagged to their client card.
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description]
 *             properties:
 *               description: { type: string }
 *     responses:
 *       201: { description: Task created }
 *       404: { description: Link not found, or the client is archived }
 */
router.post(
  '/client-portal/:token/tasks',
  body('description').isString().trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const link = await findActivePortalLink(req.params.token);
    if (!link) return res.status(404).json({ error: 'invalid_link' });

    const { rows } = await pool.query(
      `INSERT INTO tasks (company_id, project_id, description, status)
       VALUES ($1,$2,$3,'new') RETURNING *`,
      [link.company_id, link.project_id, req.body.description]
    );
    const task = rows[0];
    const clientRes = await pool.query('SELECT name, business_name FROM projects WHERE id = $1', [link.project_id]);
    const clientName = clientRes.rows[0]?.business_name || clientRes.rows[0]?.name || '';
    notifyAdmins(link.company_id, 'client_task_created', `משימה חדשה מהלקוח ${clientName}`, task.description, 'tasks');
    res.status(201).json(task);
  }
);

module.exports = router;
