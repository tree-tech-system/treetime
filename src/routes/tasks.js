const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { notifyEmployee } = require('../lib/notify');

const router = express.Router();
router.use(authenticate);

function companyIdOf(req) {
  return req.auth.companyId;
}
function isAdmin(req) {
  return req.auth.type === 'user' && req.auth.role === 'admin';
}

/**
 * @openapi
 * /api/tasks:
 *   get:
 *     tags: [Tasks]
 *     summary: List tasks — admin sees all company tasks, an employee sees only tasks assigned to them
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of tasks }
 *   post:
 *     tags: [Tasks]
 *     summary: Create a task and assign it to an employee (admin only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Task created }
 */
router.get('/', async (req, res) => {
  const conditions = ['company_id = $1'];
  const params = [companyIdOf(req)];
  if (!isAdmin(req)) {
    params.push(req.auth.employeeId);
    conditions.push(`employee_id = $${params.length}`);
  } else if (req.query.employee_id) {
    params.push(req.query.employee_id);
    conditions.push(`employee_id = $${params.length}`);
  }
  if (req.query.status) {
    params.push(req.query.status);
    conditions.push(`status = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY (deadline IS NULL), deadline ASC, created_at DESC`,
    params
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const conditions = ['id = $1', 'company_id = $2'];
  const params = [req.params.id, companyIdOf(req)];
  if (!isAdmin(req)) {
    params.push(req.auth.employeeId);
    conditions.push(`employee_id = $${params.length}`);
  }
  const { rows } = await pool.query(`SELECT * FROM tasks WHERE ${conditions.join(' AND ')}`, params);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

router.post(
  '/',
  body('description').isString().trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });
    const { description, project_id, deadline, status } = req.body;
    // Only an admin may assign a task to someone else; a regular employee creating
    // their own task always gets it assigned to themselves.
    const employee_id = isAdmin(req) ? (req.body.employee_id || null) : req.auth.employeeId;
    const { rows } = await pool.query(
      `INSERT INTO tasks (company_id, project_id, employee_id, description, deadline, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        companyIdOf(req), project_id || null, employee_id || null, description,
        deadline || null, ['new', 'in_progress', 'done'].includes(status) ? status : 'new',
        req.auth.employeeId,
      ]
    );
    const task = rows[0];
    if (task.employee_id && task.employee_id !== req.auth.employeeId) {
      notifyEmployee(task.employee_id, 'task_assigned', 'הוקצתה לך משימה חדשה', task.description, 'tasks');
    }
    res.status(201).json(task);
  }
);

/**
 * @openapi
 * /api/tasks/{id}:
 *   patch:
 *     tags: [Tasks]
 *     summary: Update a task. Admin can edit any field; an assigned employee may only update the status of their own task.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Task updated }
 */
router.patch('/:id', async (req, res) => {
  const current = await pool.query('SELECT * FROM tasks WHERE id = $1 AND company_id = $2', [req.params.id, companyIdOf(req)]);
  const task = current.rows[0];
  if (!task) return res.status(404).json({ error: 'not_found' });

  if (isAdmin(req)) {
    const { description, project_id, employee_id, deadline, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE tasks SET
         description = COALESCE($1, description),
         project_id = $2,
         employee_id = $3,
         deadline = $4,
         status = COALESCE($5, status),
         updated_at = now()
       WHERE id = $6 AND company_id = $7 RETURNING *`,
      [
        description, project_id !== undefined ? (project_id || null) : task.project_id,
        employee_id !== undefined ? (employee_id || null) : task.employee_id,
        deadline !== undefined ? (deadline || null) : task.deadline,
        ['new', 'in_progress', 'done'].includes(status) ? status : null,
        req.params.id, companyIdOf(req),
      ]
    );
    const updated = rows[0];
    if (employee_id !== undefined && employee_id && Number(employee_id) !== task.employee_id) {
      notifyEmployee(updated.employee_id, 'task_assigned', 'הוקצתה לך משימה', updated.description, 'tasks');
    }
    return res.json(updated);
  }

  // Non-admin: only the assignee may act, and only to change status.
  if (task.employee_id !== req.auth.employeeId) return res.status(403).json({ error: 'forbidden' });
  const { status } = req.body;
  if (!['new', 'in_progress', 'done'].includes(status)) {
    return res.status(400).json({ error: 'validation_error', message: 'status must be one of: new, in_progress, done' });
  }
  const { rows } = await pool.query(
    `UPDATE tasks SET status = $1, updated_at = now() WHERE id = $2 AND company_id = $3 RETURNING *`,
    [status, req.params.id, companyIdOf(req)]
  );
  res.json(rows[0]);
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1 AND company_id = $2', [req.params.id, companyIdOf(req)]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  res.status(204).send();
});

module.exports = router;
