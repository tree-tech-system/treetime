const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const DEFAULT_MAX_CONCURRENT_TIMERS = 3;

/**
 * @openapi
 * /api/timer-settings:
 *   get:
 *     tags: [Timer Settings]
 *     summary: Get the caller's company timer policy (default if never saved)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Timer settings }
 *   patch:
 *     tags: [Timer Settings]
 *     summary: Set how many timers one employee may run concurrently (admin only)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [max_concurrent_timers]
 *             properties:
 *               max_concurrent_timers: { type: integer, minimum: 1, maximum: 20 }
 *     responses:
 *       200: { description: Updated settings }
 *       400: { description: Invalid value }
 */
router.get('/', async (req, res) => {
  if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden' });
  const { rows } = await pool.query('SELECT * FROM company_timer_settings WHERE company_id = $1', [req.auth.companyId]);
  res.json(rows[0] || { company_id: req.auth.companyId, max_concurrent_timers: DEFAULT_MAX_CONCURRENT_TIMERS });
});

router.patch(
  '/',
  requireRole('admin'),
  body('max_concurrent_timers').isInt({ min: 1, max: 20 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    const { rows } = await pool.query(
      `INSERT INTO company_timer_settings (company_id, max_concurrent_timers)
       VALUES ($1, $2)
       ON CONFLICT (company_id) DO UPDATE SET max_concurrent_timers = $2, updated_at = now()
       RETURNING *`,
      [req.auth.companyId, req.body.max_concurrent_timers]
    );
    res.json(rows[0]);
  }
);

module.exports = router;
