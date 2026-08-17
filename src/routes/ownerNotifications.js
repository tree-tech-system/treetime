const express = require('express');
const pool = require('../db/pool');
const { authenticate, requireOwner } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireOwner);

/**
 * @openapi
 * /api/owner/notifications:
 *   get:
 *     tags: [Owner Notifications]
 *     summary: List platform-wide notifications for TreeTime staff
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of notifications, newest first }
 */
router.get('/', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM notifications WHERE scope = 'owner' ORDER BY created_at DESC LIMIT 100`);
  res.json(rows);
});

router.patch('/:id/read', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE notifications SET read = TRUE WHERE id = $1 AND scope = 'owner' RETURNING *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

router.post('/read-all', async (req, res) => {
  const { rowCount } = await pool.query(`UPDATE notifications SET read = TRUE WHERE read = FALSE AND scope = 'owner'`);
  res.json({ marked: rowCount });
});

module.exports = router;
