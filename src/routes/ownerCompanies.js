const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireOwner } = require('../middleware/auth');
const { generateSlug } = require('../lib/slug');

async function uniqueSlug(client) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = generateSlug();
    const exists = await client.query('SELECT 1 FROM companies WHERE slug = $1', [slug]);
    if (!exists.rows.length) return slug;
  }
  throw new Error('Could not generate a unique slug');
}

const router = express.Router();
router.use(authenticate, requireOwner);

/**
 * @openapi
 * /api/owner/companies/dashboard:
 *   get:
 *     tags: [Owner]
 *     summary: System-wide activity overview across every client company
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Aggregate stats and recent activity }
 */
router.get('/dashboard', async (req, res) => {
  const [companyCounts, employeeCounts, runningTimers, hours30d, openTickets, recentCompanies, planBreakdown, recentEntries] = await Promise.all([
    pool.query(`SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'active') AS active,
      COUNT(*) FILTER (WHERE plan = 'trial') AS trial,
      COUNT(*) FILTER (WHERE status = 'suspended') AS suspended,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS new_last_30d
      FROM companies`),
    pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE active) AS active FROM employees`),
    pool.query(`SELECT COUNT(*) AS n FROM time_entries WHERE ended_at IS NULL`),
    pool.query(`SELECT ROUND(COALESCE(EXTRACT(EPOCH FROM SUM(ended_at - started_at)) / 3600.0, 0), 1) AS hours
      FROM time_entries WHERE started_at >= now() - interval '30 days' AND ended_at IS NOT NULL`),
    pool.query(`SELECT COUNT(*) AS n FROM support_tickets WHERE status != 'closed'`),
    pool.query(`SELECT id, name, slug, plan, status, created_at FROM companies ORDER BY created_at DESC LIMIT 5`),
    pool.query(`SELECT plan, COUNT(*) AS n FROM companies GROUP BY plan`),
    pool.query(`SELECT t.id, t.started_at, t.ended_at, e.full_name AS employee_name, c.name AS company_name
      FROM time_entries t
      JOIN employees e ON e.id = t.employee_id
      JOIN companies c ON c.id = t.company_id
      ORDER BY t.created_at DESC LIMIT 8`),
  ]);

  res.json({
    companies: companyCounts.rows[0],
    employees: employeeCounts.rows[0],
    running_timers: Number(runningTimers.rows[0].n),
    hours_last_30d: Number(hours30d.rows[0].hours),
    open_tickets: Number(openTickets.rows[0].n),
    recent_companies: recentCompanies.rows,
    plan_breakdown: planBreakdown.rows,
    recent_activity: recentEntries.rows,
  });
});

/**
 * @openapi
 * /api/owner/companies:
 *   get:
 *     tags: [Owner]
 *     summary: List all client companies with activity summary
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Companies with usage stats }
 */
router.get('/', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      c.*,
      (SELECT COUNT(*) FROM employees e WHERE e.company_id = c.id) AS employee_count,
      (SELECT COUNT(*) FROM employees e WHERE e.company_id = c.id AND e.active) AS active_employee_count,
      (SELECT COUNT(*) FROM time_entries t WHERE t.company_id = c.id AND t.ended_at IS NULL) AS running_timers,
      (SELECT ROUND(EXTRACT(EPOCH FROM SUM(t.ended_at - t.started_at)) / 3600.0, 1)
         FROM time_entries t WHERE t.company_id = c.id AND t.started_at >= now() - interval '30 days' AND t.ended_at IS NOT NULL) AS hours_last_30d,
      (SELECT MAX(t.created_at) FROM time_entries t WHERE t.company_id = c.id) AS last_activity_at,
      (SELECT COUNT(*) FROM support_tickets s WHERE s.company_id = c.id AND s.status != 'closed') AS open_tickets
    FROM companies c
    ORDER BY c.created_at DESC
  `);
  res.json(rows);
});

/**
 * @openapi
 * /api/owner/companies:
 *   post:
 *     tags: [Owner]
 *     summary: Onboard a new client company, with its first admin employee
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, admin_full_name, admin_email, admin_password]
 *             properties:
 *               name: { type: string }
 *               contact_email: { type: string }
 *               contact_phone: { type: string }
 *               plan: { type: string, enum: [trial, basic, pro, enterprise] }
 *               admin_full_name: { type: string }
 *               admin_email: { type: string, format: email }
 *               admin_password: { type: string, minLength: 8 }
 *     responses:
 *       201: { description: Company and first admin employee created }
 */
router.post(
  '/',
  body('name').isString().trim().notEmpty(),
  body('admin_full_name').isString().trim().notEmpty(),
  body('admin_email').isEmail().normalizeEmail(),
  body('admin_password').isString().isLength({ min: 8 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const { name, contact_email, contact_phone, plan, admin_full_name, admin_email, admin_password } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const slug = await uniqueSlug(client);
      const companyRes = await client.query(
        `INSERT INTO companies (name, contact_email, contact_phone, plan, slug) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [name, contact_email || null, contact_phone || null, plan || 'trial', slug]
      );
      const company = companyRes.rows[0];

      const password_hash = await bcrypt.hash(admin_password, 12);
      const employeeRes = await client.query(
        `INSERT INTO employees (full_name, email, password_hash, role, company_id)
         VALUES ($1,$2,$3,'admin',$4) RETURNING id, full_name, email, role`,
        [admin_full_name, admin_email, password_hash, company.id]
      );

      await client.query('COMMIT');
      res.status(201).json({ company, admin: employeeRes.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'email_taken' });
      throw err;
    } finally {
      client.release();
    }
  }
);

/**
 * @openapi
 * /api/owner/companies/{id}:
 *   get:
 *     tags: [Owner]
 *     summary: Get full detail for one company - employees, projects, recent activity
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Company detail }
 */
router.get('/:id', async (req, res) => {
  const companyRes = await pool.query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
  if (!companyRes.rows[0]) return res.status(404).json({ error: 'not_found' });

  const [employees, projects, recentEntries] = await Promise.all([
    pool.query('SELECT id, full_name, email, role, active, created_at FROM employees WHERE company_id = $1 ORDER BY full_name', [req.params.id]),
    pool.query('SELECT * FROM projects WHERE company_id = $1 ORDER BY created_at DESC', [req.params.id]),
    pool.query(
      `SELECT t.*, e.full_name AS employee_name, p.name AS project_name
       FROM time_entries t
       JOIN employees e ON e.id = t.employee_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.company_id = $1 ORDER BY t.started_at DESC LIMIT 50`,
      [req.params.id]
    ),
  ]);

  res.json({
    company: companyRes.rows[0],
    employees: employees.rows,
    projects: projects.rows,
    recent_time_entries: recentEntries.rows,
  });
});

/**
 * @openapi
 * /api/owner/companies/{id}:
 *   patch:
 *     tags: [Owner]
 *     summary: Update a company's info, plan or status
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Updated company }
 */
router.patch('/:id', async (req, res) => {
  const { name, contact_email, contact_phone, plan, status, notes } = req.body;
  const { rows } = await pool.query(
    `UPDATE companies SET
       name = COALESCE($1, name),
       contact_email = COALESCE($2, contact_email),
       contact_phone = COALESCE($3, contact_phone),
       plan = COALESCE($4, plan),
       status = COALESCE($5, status),
       notes = COALESCE($6, notes)
     WHERE id = $7 RETURNING *`,
    [name, contact_email, contact_phone, plan, status, notes, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

/**
 * @openapi
 * /api/owner/companies/{id}/employees/{employeeId}:
 *   patch:
 *     tags: [Owner]
 *     summary: Change a client employee's username (email) or reset their password
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: employeeId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               full_name: { type: string }
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *               role: { type: string, enum: [employee, manager, admin] }
 *               active: { type: boolean }
 *     responses:
 *       200: { description: Updated employee }
 */
router.patch('/:id/employees/:employeeId', async (req, res) => {
  const { full_name, email, password, role, active } = req.body;
  const password_hash = password ? await bcrypt.hash(password, 12) : null;
  try {
    const { rows } = await pool.query(
      `UPDATE employees SET
         full_name = COALESCE($1, full_name),
         email = COALESCE($2, email),
         password_hash = COALESCE($3, password_hash),
         role = COALESCE($4, role),
         active = COALESCE($5, active)
       WHERE id = $6 AND company_id = $7
       RETURNING id, full_name, email, role, active`,
      [full_name, email, password_hash, role, active, req.params.employeeId, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'email_taken' });
    throw err;
  }
});

/**
 * @openapi
 * /api/owner/companies/{id}/impersonate:
 *   post:
 *     tags: [Owner]
 *     summary: Get a short-lived login token into a client's account (for support purposes)
 *     description: >
 *       Logs into the company as one of its admin employees (or a specific employee_id if given).
 *       The action is recorded in an audit log. The returned token expires in 1 hour.
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
 *               employee_id: { type: integer, description: "Optional - defaults to the company's first admin" }
 *     responses:
 *       200: { description: Impersonation token issued }
 *       404: { description: No suitable employee found in this company }
 */
router.post('/:id/impersonate', async (req, res) => {
  const companyId = req.params.id;
  let employee;
  if (req.body.employee_id) {
    const { rows } = await pool.query('SELECT * FROM employees WHERE id = $1 AND company_id = $2', [req.body.employee_id, companyId]);
    employee = rows[0];
  } else {
    const { rows } = await pool.query(
      `SELECT * FROM employees WHERE company_id = $1 AND role = 'admin' AND active = TRUE ORDER BY created_at LIMIT 1`,
      [companyId]
    );
    employee = rows[0];
  }
  if (!employee) return res.status(404).json({ error: 'no_employee_found', message: 'No suitable employee to impersonate in this company.' });

  await pool.query(
    'INSERT INTO impersonation_log (owner_id, company_id, employee_id) VALUES ($1,$2,$3)',
    [req.auth.ownerId, companyId, employee.id]
  );

  const token = jwt.sign(
    { sub: employee.id, role: employee.role, company_id: employee.company_id, impersonated_by: req.auth.ownerId },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  res.json({ token, employee: { id: employee.id, full_name: employee.full_name, email: employee.email, role: employee.role } });
});

/**
 * @openapi
 * /api/owner/companies/{id}/impersonations:
 *   get:
 *     tags: [Owner]
 *     summary: Audit log of impersonation logins into this company
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: List of impersonation events }
 */
router.get('/:id/impersonations', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT il.id, il.created_at, o.full_name AS owner_name, e.full_name AS employee_name
     FROM impersonation_log il
     JOIN owners o ON o.id = il.owner_id
     JOIN employees e ON e.id = il.employee_id
     WHERE il.company_id = $1 ORDER BY il.created_at DESC LIMIT 50`,
    [req.params.id]
  );
  res.json(rows);
});

/**
 * @openapi
 * /api/owner/companies/{id}/activity-log:
 *   get:
 *     tags: [Owner]
 *     summary: Recent API activity for this company (server calls, who made them, when)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 200 }
 *     responses:
 *       200: { description: List of recent API calls }
 */
router.get('/:id/activity-log', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const { rows } = await pool.query(
    `SELECT al.id, al.method, al.path, al.status_code, al.ip, al.created_at,
       e.full_name AS employee_name, ak.name AS api_key_name
     FROM api_activity_log al
     LEFT JOIN employees e ON e.id = al.employee_id
     LEFT JOIN api_keys ak ON ak.id = al.api_key_id
     WHERE al.company_id = $1
     ORDER BY al.created_at DESC LIMIT $2`,
    [req.params.id, limit]
  );
  res.json(rows);
});

module.exports = router;
