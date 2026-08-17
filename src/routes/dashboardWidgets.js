const express = require('express');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { evaluateKpi, evaluateClientsUsage, evaluateEmployeesActivity, listDataSources, ValidationError } = require('../lib/kpiEngine');

const router = express.Router();
router.use(authenticate);

const WIDGET_SIZES = ['quarter', 'half', 'three_quarter', 'full'];

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
      if (w.type !== 'kpi') return w;
      try {
        return { ...w, value: await evaluateKpi(companyIdOf(req), w.config) };
      } catch {
        return { ...w, value: null }; // config referenced something no longer valid; widget still renders, just shows no value
      }
    })
  );
  res.json(withValues);
});

router.post('/', requireRole('admin'), async (req, res) => {
  const { type, title, config, size } = req.body;
  if (!['kpi', 'list'].includes(type)) return res.status(400).json({ error: 'validation_error', message: 'type must be kpi or list' });
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'validation_error', message: 'title is required' });
  if (size !== undefined && size !== null && !WIDGET_SIZES.includes(size)) {
    return res.status(400).json({ error: 'validation_error', message: 'size must be one of ' + WIDGET_SIZES.join(', ') });
  }

  if (type === 'kpi') {
    try {
      await evaluateKpi(companyIdOf(req), config);
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
    `INSERT INTO dashboard_widgets (company_id, type, title, config, position, created_by, size)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [companyIdOf(req), type, title, config || {}, posRows[0].next, req.auth.employeeId || null, size || null]
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
  const { title, position, config, height_px, size } = req.body;
  if (size !== undefined && size !== null && !WIDGET_SIZES.includes(size)) {
    return res.status(400).json({ error: 'validation_error', message: 'size must be one of ' + WIDGET_SIZES.join(', ') });
  }
  const existing = await pool.query('SELECT type FROM dashboard_widgets WHERE id = $1 AND company_id = $2', [req.params.id, companyIdOf(req)]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'not_found' });

  if (config !== undefined && existing.rows[0].type === 'kpi') {
    try {
      await evaluateKpi(companyIdOf(req), config);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: 'validation_error', message: err.message });
      throw err;
    }
  }

  const h = Number.isFinite(height_px) && height_px > 0 ? Math.round(height_px) : null;

  const { rows } = await pool.query(
    `UPDATE dashboard_widgets SET title = COALESCE($1, title), position = COALESCE($2, position),
       config = COALESCE($3, config), height_px = COALESCE($6, height_px), size = COALESCE($7, size)
     WHERE id = $4 AND company_id = $5 RETURNING *`,
    [title || null, position ?? null, config || null, req.params.id, companyIdOf(req), h, size || null]
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
