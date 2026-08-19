const express = require('express');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { evaluateKpi, evaluateChart, evaluateClientsUsage, evaluateEmployeesActivity, listDataSources, ValidationError } = require('../lib/kpiEngine');

const router = express.Router();
router.use(authenticate);

function companyIdOf(req) {
  return req.auth.companyId;
}

/**
 * @openapi
 * /api/dashboard-widgets/kpi/schema:
 *   get:
 *     tags: [Dashboard Widgets]
 *     summary: Data sources, aggregatable fields and filters available for building a KPI widget
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: KPI builder schema }
 */
router.get('/kpi/schema', (req, res) => {
  res.json(listDataSources());
});

/**
 * @openapi
 * /api/dashboard-widgets/kpi/preview:
 *   post:
 *     tags: [Dashboard Widgets]
 *     summary: Evaluate a KPI config without saving it, for live preview while building
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [data_source, aggregation]
 *             properties:
 *               data_source: { type: string, enum: [time_entries, projects, employees, tasks] }
 *               aggregation: { type: string, enum: [sum, avg, count, min, max] }
 *               field: { type: string }
 *               filters: { type: object }
 *     responses:
 *       200: { description: Computed value }
 */
router.post('/kpi/preview', async (req, res) => {
  try {
    const value = await evaluateKpi(companyIdOf(req), req.body);
    res.json({ value });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: 'validation_error', message: err.message });
    throw err;
  }
});

/**
 * @openapi
 * /api/dashboard-widgets/chart/preview:
 *   post:
 *     tags: [Dashboard Widgets]
 *     summary: Evaluate a chart config without saving it, for live preview while building
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [data_source, group_by]
 *             properties:
 *               data_source: { type: string, enum: [time_entries, projects, employees, tasks, edit_requests] }
 *               group_by: { type: string }
 *               aggregation: { type: string, enum: [sum, avg, count, min, max] }
 *               field: { type: string }
 *               filters: { type: object }
 *     responses:
 *       200: { description: One {label, value} row per group }
 */
router.post('/chart/preview', async (req, res) => {
  try {
    const data = await evaluateChart(companyIdOf(req), req.body);
    res.json({ data });
  } catch (err) {
    if (err instanceof ValidationError) return res.status(400).json({ error: 'validation_error', message: err.message });
    throw err;
  }
});

/**
 * @openapi
 * /api/dashboard-widgets/relations/clients-usage:
 *   get:
 *     tags: [Dashboard Widgets]
 *     summary: Per-client hours logged vs. monthly quota, for clients with an hours-bank quota
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: date_from
 *         schema: { type: string }
 *       - in: query
 *         name: date_to
 *         schema: { type: string }
 *     responses:
 *       200: { description: One row per client }
 */
router.get('/relations/clients-usage', async (req, res) => {
  const rows = await evaluateClientsUsage(companyIdOf(req), { dateFrom: req.query.date_from, dateTo: req.query.date_to });
  res.json(rows);
});

/**
 * @openapi
 * /api/dashboard-widgets/relations/employees-activity:
 *   get:
 *     tags: [Dashboard Widgets]
 *     summary: Per-employee hours logged and most recent entry
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: date_from
 *         schema: { type: string }
 *       - in: query
 *         name: date_to
 *         schema: { type: string }
 *     responses:
 *       200: { description: One row per employee }
 */
router.get('/relations/employees-activity', async (req, res) => {
  const rows = await evaluateEmployeesActivity(companyIdOf(req), { dateFrom: req.query.date_from, dateTo: req.query.date_to });
  res.json(rows);
});

/**
 * @openapi
 * /api/dashboard-widgets:
 *   get:
 *     tags: [Dashboard Widgets]
 *     summary: List this company's dashboard widgets, in display order
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of widgets }
 *   post:
 *     tags: [Dashboard Widgets]
 *     summary: Add a widget to the dashboard (admin only)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, title]
 *             properties:
 *               type: { type: string, enum: [kpi, list] }
 *               title: { type: string }
 *               config: { type: object }
 *     responses:
 *       201: { description: Widget created }
 */
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM dashboard_widgets WHERE company_id = $1 ORDER BY position, id',
    [companyIdOf(req)]
  );
  const withValues = await Promise.all(
    rows.map(async (w) => {
      try {
        if (w.type === 'kpi') return { ...w, value: await evaluateKpi(companyIdOf(req), w.config) };
        if (w.type === 'chart') return { ...w, data: await evaluateChart(companyIdOf(req), w.config) };
        return w;
      } catch {
        // config referenced something no longer valid; widget still renders, just shows no data
        return w.type === 'kpi' ? { ...w, value: null } : w.type === 'chart' ? { ...w, data: [] } : w;
      }
    })
  );
  res.json(withValues);
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { type, title, config } = req.body;
  if (!['kpi', 'list', 'chart'].includes(type)) return res.status(400).json({ error: 'validation_error', message: 'type must be kpi, list, or chart' });
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'validation_error', message: 'title is required' });

  if (type === 'kpi' || type === 'chart') {
    try {
      await (type === 'kpi' ? evaluateKpi(companyIdOf(req), config) : evaluateChart(companyIdOf(req), config));
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: 'validation_error', message: err.message });
      throw err;
    }
  }

  const { rows: posRows } = await pool.query(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM dashboard_widgets WHERE company_id = $1',
    [companyIdOf(req)]
  );
  const { rows } = await pool.query(
    `INSERT INTO dashboard_widgets (company_id, type, title, config, position, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [companyIdOf(req), type, title, config || {}, posRows[0].next, req.auth.employeeId || null]
  );
  res.status(201).json(rows[0]);
});

/**
 * @openapi
 * /api/dashboard-widgets/{id}/value:
 *   get:
 *     tags: [Dashboard Widgets]
 *     summary: Evaluate a saved KPI widget's current value
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Computed value }
 */
router.get('/:id/value', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM dashboard_widgets WHERE id = $1 AND company_id = $2', [req.params.id, companyIdOf(req)]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  if (rows[0].type !== 'kpi') return res.status(400).json({ error: 'not_a_kpi_widget' });
  const value = await evaluateKpi(companyIdOf(req), rows[0].config);
  res.json({ value });
});

/**
 * @openapi
 * /api/dashboard-widgets/{id}:
 *   patch:
 *     tags: [Dashboard Widgets]
 *     summary: Rename or reorder a widget (admin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Updated widget }
 *   delete:
 *     tags: [Dashboard Widgets]
 *     summary: Remove a widget from the dashboard (admin only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204: { description: Removed }
 */
router.patch('/:id', requireRole('admin'), async (req, res) => {
  const { title, position, config, width_px, height_px } = req.body;
  const existing = await pool.query('SELECT type FROM dashboard_widgets WHERE id = $1 AND company_id = $2', [req.params.id, companyIdOf(req)]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'not_found' });

  if (config !== undefined && (existing.rows[0].type === 'kpi' || existing.rows[0].type === 'chart')) {
    try {
      await (existing.rows[0].type === 'kpi' ? evaluateKpi(companyIdOf(req), config) : evaluateChart(companyIdOf(req), config));
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: 'validation_error', message: err.message });
      throw err;
    }
  }

  const w = Number.isFinite(width_px) && width_px > 0 ? Math.round(width_px) : null;
  const h = Number.isFinite(height_px) && height_px > 0 ? Math.round(height_px) : null;

  const { rows } = await pool.query(
    `UPDATE dashboard_widgets SET title = COALESCE($1, title), position = COALESCE($2, position),
       config = COALESCE($3, config), width_px = COALESCE($6, width_px), height_px = COALESCE($7, height_px)
     WHERE id = $4 AND company_id = $5 RETURNING *`,
    [title || null, position ?? null, config || null, req.params.id, companyIdOf(req), w, h]
  );
  res.json(rows[0]);
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM dashboard_widgets WHERE id = $1 AND company_id = $2', [req.params.id, companyIdOf(req)]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

/**
 * @openapi
 * /api/dashboard-widgets/reorder:
 *   post:
 *     tags: [Dashboard Widgets]
 *     summary: Set the display order for all widgets at once (admin only)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [order]
 *             properties:
 *               order: { type: array, items: { type: integer }, description: "Widget IDs in the desired order" }
 *     responses:
 *       200: { description: Reordered }
 */
router.post('/reorder', requireRole('admin'), async (req, res) => {
  const order = Array.isArray(req.body.order) ? req.body.order : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      await client.query('UPDATE dashboard_widgets SET position = $1 WHERE id = $2 AND company_id = $3', [i, order[i], companyIdOf(req)]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.status(204).end();
});

module.exports = router;
