const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireScope } = require('../middleware/auth');
const { dispatchEvent } = require('../lib/webhookDispatcher');

const router = express.Router();
router.use(authenticate);

function companyIdOf(req) {
  return req.auth.companyId;
}

// Resolve which employee_id this request acts on: a logged-in user normally acts
// on themselves, but an admin/manager may log or edit an entry on behalf of any
// freelancer in their company by passing employee_id explicitly. An API key must
// always pass employee_id explicitly.
async function resolveEmployeeId(req) {
  const requestedId = req.body.employee_id || req.query.employee_id;
  if (req.auth.type === 'user') {
    if (!requestedId || Number(requestedId) === req.auth.employeeId) return req.auth.employeeId;
    if (!['admin', 'manager'].includes(req.auth.role)) return req.auth.employeeId;
    const { rows } = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [requestedId, req.auth.companyId]);
    return rows[0] ? requestedId : req.auth.employeeId;
  }
  if (!requestedId) return null;
  const { rows } = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [requestedId, req.auth.companyId]);
  return rows[0] ? requestedId : null;
}

async function rateFor(employeeId) {
  const { rows } = await pool.query('SELECT hourly_rate FROM employees WHERE id = $1', [employeeId]);
  return Number(rows[0]?.hourly_rate) || 0;
}

function computeCost(startedAt, endedAt, rate, pausedSeconds = 0) {
  const hours = Math.max(0, (new Date(endedAt) - new Date(startedAt)) / 1000 - (pausedSeconds || 0)) / 3600;
  return Math.round(hours * rate * 100) / 100;
}

// Picks the entry a pause/resume/stop action applies to among an employee's currently
// matching timers (`filterSql` distinguishes "running", "paused", or "running or
// paused"), disambiguating by an explicit entry_id when the employee has more than one.
async function resolveTimerEntry(employeeId, requestedEntryId, filterSql) {
  const { rows: candidates } = await pool.query(
    `SELECT id FROM time_entries WHERE employee_id = $1 AND ${filterSql} ORDER BY started_at`,
    [employeeId]
  );
  if (!candidates.length) return { notFound: true };
  if (requestedEntryId) {
    return candidates.some((r) => r.id === Number(requestedEntryId))
      ? { id: Number(requestedEntryId) }
      : { notFound: true };
  }
  if (candidates.length > 1) return { ambiguous: true };
  return { id: candidates[0].id };
}

/**
 * @openapi
 * /api/time-entries/start:
 *   post:
 *     tags: [Time Entries]
 *     summary: Start a running timer (Toggl-style). Fails if one is already running.
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               employee_id: { type: integer, description: "Required when using an API key" }
 *               project_id: { type: integer }
 *               description: { type: string }
 *               source: { type: string, example: mobile }
 *     responses:
 *       201: { description: Timer started }
 *       409: { description: Employee already has as many timers running as the company's configured limit (see /api/timer-settings) }
 */
router.post('/start', requireScope('write'), async (req, res) => {
  const employeeId = await resolveEmployeeId(req);
  if (!employeeId) return res.status(400).json({ error: 'missing_employee_id' });

  const settingsRes = await pool.query('SELECT max_concurrent_timers FROM company_timer_settings WHERE company_id = $1', [companyIdOf(req)]);
  const maxConcurrent = settingsRes.rows[0]?.max_concurrent_timers || 3;

  const running = await pool.query('SELECT id FROM time_entries WHERE employee_id = $1 AND ended_at IS NULL', [employeeId]);
  if (running.rows.length >= maxConcurrent) {
    return res.status(409).json({ error: 'too_many_running_timers', message: `Max ${maxConcurrent} concurrent timers per employee.` });
  }

  let { project_id, task_id, description, source } = req.body;
  if (task_id) {
    const taskRes = await pool.query('SELECT project_id FROM tasks WHERE id = $1 AND company_id = $2', [task_id, companyIdOf(req)]);
    if (!taskRes.rows[0]) return res.status(400).json({ error: 'invalid_task' });
    project_id = taskRes.rows[0].project_id || project_id || null;
  }
  const { rows } = await pool.query(
    `INSERT INTO time_entries (employee_id, project_id, task_id, description, source, company_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [employeeId, project_id || null, task_id || null, description || null, source || (req.auth.type === 'apikey' ? `integration:${req.auth.name}` : 'web'), companyIdOf(req)]
  );
  dispatchEvent('time_entry.started', rows[0]);
  res.status(201).json(rows[0]);
});

/**
 * @openapi
 * /api/time-entries/stop:
 *   post:
 *     tags: [Time Entries]
 *     summary: Stop the currently running timer
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               employee_id: { type: integer, description: "Required when using an API key" }
 *     responses:
 *       200: { description: Timer stopped }
 *       404: { description: No running timer found }
 */
router.post('/stop', requireScope('write'), async (req, res) => {
  const employeeId = await resolveEmployeeId(req);
  if (!employeeId) return res.status(400).json({ error: 'missing_employee_id' });

  const picked = await resolveTimerEntry(employeeId, req.body.entry_id, 'ended_at IS NULL');
  if (picked.notFound) return res.status(404).json({ error: 'no_running_timer' });
  if (picked.ambiguous) {
    return res.status(400).json({ error: 'multiple_running_timers', message: 'Specify entry_id — more than one timer is running for this employee.' });
  }

  // Finalize any pause still in progress into paused_seconds before computing cost, so
  // time spent paused is never counted as worked time.
  const finalized = await pool.query(
    `UPDATE time_entries SET
       paused_seconds = paused_seconds + CASE WHEN paused_at IS NOT NULL THEN CEIL(EXTRACT(EPOCH FROM (now() - paused_at)))::INTEGER ELSE 0 END,
       paused_at = NULL,
       ended_at = now()
     WHERE id = $1 AND ended_at IS NULL RETURNING *`,
    [picked.id]
  );
  if (!finalized.rows[0]) return res.status(404).json({ error: 'no_running_timer' });

  const rate = await rateFor(employeeId);
  const cost = computeCost(finalized.rows[0].started_at, finalized.rows[0].ended_at, rate, finalized.rows[0].paused_seconds);
  const { rows } = await pool.query(
    `UPDATE time_entries SET rate_snapshot = $2, cost = $3 WHERE id = $1 RETURNING *`,
    [picked.id, rate, cost]
  );
  dispatchEvent('time_entry.stopped', rows[0]);
  res.json(rows[0]);
});

/**
 * @openapi
 * /api/time-entries/pause:
 *   post:
 *     tags: [Time Entries]
 *     summary: Pause a running timer without ending it
 *     description: >
 *       Freezes the timer in place -- it keeps existing but stops counting toward
 *       worked time until resumed. Does not free up a concurrent-timer slot (see
 *       /api/timer-settings); a paused timer still counts as "running" for that limit.
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               employee_id: { type: integer, description: "Required when using an API key" }
 *               entry_id: { type: integer, description: "Required if more than one timer is running" }
 *     responses:
 *       200: { description: Timer paused }
 *       404: { description: No running (unpaused) timer found }
 */
router.post('/pause', requireScope('write'), async (req, res) => {
  const employeeId = await resolveEmployeeId(req);
  if (!employeeId) return res.status(400).json({ error: 'missing_employee_id' });

  const picked = await resolveTimerEntry(employeeId, req.body.entry_id, 'ended_at IS NULL AND paused_at IS NULL');
  if (picked.notFound) return res.status(404).json({ error: 'no_running_timer' });
  if (picked.ambiguous) {
    return res.status(400).json({ error: 'multiple_running_timers', message: 'Specify entry_id — more than one timer is running for this employee.' });
  }

  const { rows } = await pool.query(
    `UPDATE time_entries SET paused_at = now() WHERE id = $1 AND ended_at IS NULL AND paused_at IS NULL RETURNING *`,
    [picked.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'no_running_timer' });
  dispatchEvent('time_entry.paused', rows[0]);
  res.json(rows[0]);
});

/**
 * @openapi
 * /api/time-entries/resume:
 *   post:
 *     tags: [Time Entries]
 *     summary: Resume a paused timer
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               employee_id: { type: integer, description: "Required when using an API key" }
 *               entry_id: { type: integer, description: "Required if more than one timer is paused" }
 *     responses:
 *       200: { description: Timer resumed }
 *       404: { description: No paused timer found }
 */
router.post('/resume', requireScope('write'), async (req, res) => {
  const employeeId = await resolveEmployeeId(req);
  if (!employeeId) return res.status(400).json({ error: 'missing_employee_id' });

  const picked = await resolveTimerEntry(employeeId, req.body.entry_id, 'ended_at IS NULL AND paused_at IS NOT NULL');
  if (picked.notFound) return res.status(404).json({ error: 'no_paused_timer' });
  if (picked.ambiguous) {
    return res.status(400).json({ error: 'multiple_paused_timers', message: 'Specify entry_id — more than one timer is paused for this employee.' });
  }

  const { rows } = await pool.query(
    `UPDATE time_entries SET
       paused_seconds = paused_seconds + CEIL(EXTRACT(EPOCH FROM (now() - paused_at)))::INTEGER,
       paused_at = NULL
     WHERE id = $1 AND ended_at IS NULL AND paused_at IS NOT NULL RETURNING *`,
    [picked.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'no_paused_timer' });
  dispatchEvent('time_entry.resumed', rows[0]);
  res.json(rows[0]);
});

/**
 * @openapi
 * /api/time-entries/current:
 *   get:
 *     tags: [Time Entries]
 *     summary: Get the employee's currently running timers (how many may run concurrently is configurable, see /api/timer-settings)
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: employee_id
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Array of running entries (possibly empty) }
 */
router.get('/current', requireScope('read'), async (req, res) => {
  const employeeId = await resolveEmployeeId(req);
  if (!employeeId) return res.status(400).json({ error: 'missing_employee_id' });
  const { rows } = await pool.query('SELECT * FROM time_entries WHERE employee_id = $1 AND ended_at IS NULL ORDER BY started_at', [employeeId]);
  res.json(rows);
});

/**
 * @openapi
 * /api/time-entries:
 *   get:
 *     tags: [Time Entries]
 *     summary: List time entries for the caller's company, optionally filtered
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: employee_id
 *         schema: { type: integer }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: List of time entries }
 *   post:
 *     tags: [Time Entries]
 *     summary: Manually create a completed time entry (clock in/out with explicit times)
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [started_at, ended_at]
 *             properties:
 *               employee_id: { type: integer }
 *               project_id: { type: integer }
 *               description: { type: string }
 *               started_at: { type: string, format: date-time }
 *               ended_at: { type: string, format: date-time }
 *     responses:
 *       201: { description: Entry created }
 */
router.get('/', requireScope('read'), async (req, res) => {
  const conditions = ['company_id = $1'];
  const params = [companyIdOf(req)];
  const isAdmin = req.auth.type === 'user' && req.auth.role === 'admin';
  const employeeId = req.query.employee_id || (req.auth.type === 'user' && !isAdmin ? req.auth.employeeId : null);
  if (employeeId) { params.push(employeeId); conditions.push(`employee_id = $${params.length}`); }
  if (req.query.from) { params.push(req.query.from); conditions.push(`started_at >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); conditions.push(`started_at <= $${params.length}`); }
  if (req.query.project_id) { params.push(req.query.project_id); conditions.push(`project_id = $${params.length}`); }
  if (req.query.task_id) { params.push(req.query.task_id); conditions.push(`task_id = $${params.length}`); }
  const { rows } = await pool.query(`SELECT * FROM time_entries WHERE ${conditions.join(' AND ')} ORDER BY started_at DESC LIMIT 1000`, params);
  res.json(rows);
});

router.post(
  '/',
  requireScope('write'),
  body('started_at').isISO8601(),
  body('ended_at').isISO8601(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });
    const employeeId = await resolveEmployeeId(req);
    if (!employeeId) return res.status(400).json({ error: 'missing_employee_id' });
    const { project_id, description, started_at, ended_at } = req.body;
    const rate = await rateFor(employeeId);
    const cost = computeCost(started_at, ended_at, rate);
    const { rows } = await pool.query(
      `INSERT INTO time_entries (employee_id, project_id, description, started_at, ended_at, source, company_id, rate_snapshot, cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [employeeId, project_id || null, description || null, started_at, ended_at, req.auth.type === 'apikey' ? `integration:${req.auth.name}` : 'web', companyIdOf(req), rate, cost]
    );
    dispatchEvent('time_entry.created', rows[0]);
    res.status(201).json(rows[0]);
  }
);

/**
 * @openapi
 * /api/time-entries/{id}:
 *   patch:
 *     tags: [Time Entries]
 *     summary: Correct a time entry (admin only) - e.g. after approving an edit request
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Updated entry }
 */
router.patch('/:id', requireScope('write'), async (req, res) => {
  const { project_id, description, started_at, ended_at } = req.body;
  const current = await pool.query('SELECT * FROM time_entries WHERE id = $1 AND company_id = $2', [req.params.id, companyIdOf(req)]);
  if (!current.rows[0]) return res.status(404).json({ error: 'not_found' });

  const newStart = started_at || current.rows[0].started_at;
  const newEnd = ended_at || current.rows[0].ended_at;
  const rate = Number(current.rows[0].rate_snapshot) || (await rateFor(current.rows[0].employee_id));
  // paused_seconds isn't editable here -- it's whatever /pause + /resume (or /stop,
  // finalizing a pause still in progress) already recorded on the row, so a manual
  // time correction still correctly excludes any paused time from the cost.
  const cost = newEnd ? computeCost(newStart, newEnd, rate, current.rows[0].paused_seconds) : null;

  const { rows } = await pool.query(
    `UPDATE time_entries SET
       project_id = COALESCE($1, project_id),
       description = COALESCE($2, description),
       started_at = COALESCE($3, started_at),
       ended_at = COALESCE($4, ended_at),
       cost = COALESCE($5, cost)
     WHERE id = $6 AND company_id = $7 RETURNING *`,
    [project_id, description, started_at, ended_at, cost, req.params.id, companyIdOf(req)]
  );
  res.json(rows[0]);
});

/**
 * @openapi
 * /api/time-entries/{id}:
 *   delete:
 *     tags: [Time Entries]
 *     summary: Delete a time entry
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204: { description: Deleted }
 */
router.delete('/:id', requireScope('write'), async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM time_entries WHERE id = $1 AND company_id = $2', [req.params.id, companyIdOf(req)]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

module.exports = router;
