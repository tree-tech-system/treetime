const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * @openapi
 * /api/guides:
 *   get:
 *     tags: [Guides]
 *     summary: List guide categories with their videos — shown to every logged-in employee
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Categories with nested videos }
 */
router.get('/', authenticate, async (req, res) => {
  if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden' });
  const { rows: categories } = await pool.query('SELECT id, name FROM guide_categories ORDER BY sort_order, created_at');
  const { rows: allVideos } = await pool.query(
    'SELECT id, category_id, title, description, youtube_url, visibility FROM guide_videos ORDER BY sort_order, created_at'
  );
  // Admin-only videos are filtered out server-side for non-admin employees, not just hidden in the UI.
  const videos = req.auth.role === 'admin' ? allVideos : allVideos.filter((v) => v.visibility !== 'admin');
  res.json(categories.map((c) => ({ ...c, videos: videos.filter((v) => v.category_id === c.id) })));
});

module.exports = router;
