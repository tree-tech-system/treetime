const express = require('express');
const pool = require('../db/pool');
const { authenticate, requireRole, requireScope } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

/**
 * @openapi
 * /api/reports/summary:
 *   get:
 *     tags: [Reports]
 *     summary: Total hours per employee/project in a date range
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: Summary rows grouped by employee and project }
 */
router.get(
  '/summary',
  requireScope('read'),
  (req, res, next) => (req.auth.type === 'user' ? requireRole('manager', 'admin')(req, res, next) : next()),
  async (req, res) => {
    const params = [req.auth.companyId];
    const conditions = ['t.company_id = $1', 'ended_at IS NOT NULL'];
    if (req.query.from) { params.push(req.query.from); conditions.push(`started_at >= $${params.length}`); }
    if (req.query.to) { params.push(req.query.to); conditions.push(`started_at <= $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT
         e.id AS employee_id, e.full_name,
         p.id AS project_id, p.name AS project_name,
         ROUND(EXTRACT(EPOCH FROM SUM(t.ended_at - t.started_at)) / 3600.0, 2) AS total_hours,
         COUNT(*) AS entry_count
       FROM time_entries t
       JOIN employees e ON e.id = t.employee_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE ${conditions.join(' AND ')}
       GROUP BY e.id, e.full_name, p.id, p.name
       ORDER BY e.full_name`,
      params
    );
    res.json(rows);
  }
);

/**
 * @openapi
 * /api/reports/dashboard:
 *   get:
 *     tags: [Reports]
 *     summary: Company-wide dashboard stats for the current calendar month (admin/manager)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Dashboard data - month totals, quota alerts, weekly trend, freelancer activity }
 */
router.get('/dashboard', requireRole('manager', 'admin'), async (req, res) => {
  const companyId = req.auth.companyId;

  const [monthTotals, activeFreelancers, runningTimers, clients, freelancerActivity, weeklyTrend, recentEntries] = await Promise.all([
    pool.query(
      `SELECT ROUND(EXTRACT(EPOCH FROM SUM(ended_at - started_at))/3600.0,2) AS hours, ROUND(SUM(cost),2) AS cost
       FROM time_entries WHERE company_id=$1 AND ended_at IS NOT NULL
       AND date_trunc('month', started_at) = date_trunc('month', now())`,
      [companyId]
    ),
    pool.query(
      `SELECT COUNT(DISTINCT employee_id) AS count FROM time_entries
       WHERE company_id=$1 AND date_trunc('month', started_at) = date_trunc('month', now())`,
      [companyId]
    ),
    pool.query('SELECT COUNT(*) AS count FROM time_entries WHERE company_id=$1 AND ended_at IS NULL', [companyId]),
    pool.query(
      `SELECT p.id, p.name, p.business_name, p.use_hours_bank, p.monthly_quota_hours,
         COALESCE(ROUND(EXTRACT(EPOCH FROM SUM(t.ended_at - t.started_at))/3600.0,2),0) AS used_hours
       FROM projects p
       LEFT JOIN time_entries t ON t.project_id = p.id AND t.ended_at IS NOT NULL
         AND date_trunc('month', t.started_at) = date_trunc('month', now())
       WHERE p.company_id=$1 AND p.archived=FALSE
       GROUP BY p.id`,
      [companyId]
    ),
    pool.query(
      `SELECT e.id, e.full_name, e.hourly_rate,
         COALESCE(ROUND(EXTRACT(EPOCH FROM SUM(t.ended_at - t.started_at))/3600.0,2),0) AS month_hours,
         COALESCE(ROUND(SUM(t.cost),2),0) AS month_cost,
         MAX(t.started_at) AS last_entry_at
       FROM employees e
       LEFT JOIN time_entries t ON t.employee_id = e.id AND t.ended_at IS NOT NULL
         AND date_trunc('month', t.started_at) = date_trunc('month', now())
       WHERE e.company_id=$1
       GROUP BY e.id ORDER BY e.full_name`,
      [companyId]
    ),
    pool.query(
      `SELECT date_trunc('week', started_at) AS week_start,
         ROUND(EXTRACT(EPOCH FROM SUM(ended_at - started_at))/3600.0,2) AS hours
       FROM time_entries
       WHERE company_id=$1 AND ended_at IS NOT NULL AND started_at >= now() - interval '6 weeks'
       GROUP BY week_start ORDER BY week_start`,
      [companyId]
    ),
    pool.query(
      `SELECT t.*, e.full_name AS employee_name, p.name AS project_name
       FROM time_entries t JOIN employees e ON e.id=t.employee_id LEFT JOIN projects p ON p.id=t.project_id
       WHERE t.company_id=$1 ORDER BY t.started_at DESC LIMIT 10`,
      [companyId]
    ),
  ]);

  const clientsOverQuota = clients.rows.filter(
    (c) => c.use_hours_bank && c.monthly_quota_hours > 0 && c.used_hours / c.monthly_quota_hours >= 0.8
  );

  res.json({
    month_hours: monthTotals.rows[0].hours || 0,
    month_cost: monthTotals.rows[0].cost || 0,
    active_freelancers_this_month: Number(activeFreelancers.rows[0].count),
    running_timers: Number(runningTimers.rows[0].count),
    clients_over_quota: clientsOverQuota,
    clients: clients.rows,
    freelancer_activity: freelancerActivity.rows,
    weekly_trend: weeklyTrend.rows,
    recent_entries: recentEntries.rows,
  });
});

/**
 * @openapi
 * /api/reports/my-dashboard:
 *   get:
 *     tags: [Reports]
 *     summary: Personal dashboard stats for the logged-in freelancer, current month
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Personal dashboard data }
 */
router.get('/my-dashboard', async (req, res) => {
  if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden' });
  const employeeId = req.auth.employeeId;

  const [monthTotals, current, recent] = await Promise.all([
    pool.query(
      `SELECT ROUND(EXTRACT(EPOCH FROM SUM(ended_at - started_at))/3600.0,2) AS hours, ROUND(SUM(cost),2) AS cost
       FROM time_entries WHERE employee_id=$1 AND ended_at IS NOT NULL
       AND date_trunc('month', started_at) = date_trunc('month', now())`,
      [employeeId]
    ),
    pool.query('SELECT * FROM time_entries WHERE employee_id=$1 AND ended_at IS NULL', [employeeId]),
    pool.query(
      `SELECT t.*, p.name AS project_name FROM time_entries t LEFT JOIN projects p ON p.id=t.project_id
       WHERE t.employee_id=$1 ORDER BY t.started_at DESC LIMIT 10`,
      [employeeId]
    ),
  ]);

  res.json({
    month_hours: monthTotals.rows[0].hours || 0,
    month_cost: monthTotals.rows[0].cost || 0,
    active_timer: current.rows[0] || null,
    recent_entries: recent.rows,
  });
});

module.exports = router;
