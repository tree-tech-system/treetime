const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const VIDEO_VISIBILITIES = ['admin', 'all'];

function requireUser(req, res, next) {
  if (req.auth.type !== 'user') return res.status(403).json({ error: 'forbidden' });
  next();
}

/**
 * @openapi
 * /api/guides:
 *   get:
 *     tags: [Guides]
 *     summary: List guide categories with their videos — shown to every logged-in employee
 *     description: >
 *       Includes both the global library (owner-managed, shown to every company) and this
 *       company's own admin-added videos, side by side in the same categories.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Categories with nested videos }
 */
router.get('/', requireUser, async (req, res) => {
  const { rows: categories } = await pool.query('SELECT id, name FROM guide_categories ORDER BY sort_order, created_at');
  const { rows: allVideos } = await pool.query(
    `SELECT id, category_id, title, description, youtube_url, visibility, company_id FROM guide_videos
     WHERE company_id IS NULL OR company_id = $1 ORDER BY sort_order, created_at`,
    [req.auth.companyId]
  );
  // Admin-only videos are filtered out server-side for non-admin employees, not just hidden in the UI.
  const videos = req.auth.role === 'admin' ? allVideos : allVideos.filter((v) => v.visibility !== 'admin');
  res.json(categories.map((c) => ({ ...c, videos: videos.filter((v) => v.category_id === c.id) })));
});

/**
 * @openapi
 * /api/guides/videos:
 *   post:
 *     tags: [Guides]
 *     summary: Add a guide video for your own company (admin only)
 *     description: >
 *       Company-scoped counterpart to the owner's global video library (POST
 *       /api/owner/guides/videos) -- picks an existing category (categories themselves
 *       are still owner-managed only), but the video is only ever visible to this company.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [category_id, title, youtube_url]
 *             properties:
 *               category_id: { type: integer }
 *               title: { type: string }
 *               description: { type: string }
 *               youtube_url: { type: string }
 *               visibility: { type: string, enum: [admin, all], description: "Who can see this video — admin only, or admin + employee. Defaults to all." }
 *     responses:
 *       201: { description: Video added }
 */
router.post(
  '/videos',
  requireUser,
  requireRole('admin'),
  body('category_id').isInt(),
  body('title').isString().trim().notEmpty(),
  body('youtube_url').isString().trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });
    const { category_id, title, description, youtube_url, visibility } = req.body;
    if (visibility !== undefined && !VIDEO_VISIBILITIES.includes(visibility)) {
      return res.status(400).json({ error: 'validation_error', message: 'visibility must be admin or all' });
    }
    const catCheck = await pool.query('SELECT id FROM guide_categories WHERE id = $1', [category_id]);
    if (!catCheck.rows[0]) return res.status(400).json({ error: 'invalid_category' });

    const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM guide_videos WHERE category_id = $1', [category_id]);
    const { rows } = await pool.query(
      `INSERT INTO guide_videos (category_id, title, description, youtube_url, sort_order, visibility, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [category_id, title, description || null, youtube_url, maxOrder.rows[0].m + 1, visibility || 'all', req.auth.companyId]
    );
    res.status(201).json(rows[0]);
  }
);

/**
 * @openapi
 * /api/guides/videos/{id}:
 *   patch:
 *     tags: [Guides]
 *     summary: Update one of your own company's guide videos (admin only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated video }
 *   delete:
 *     tags: [Guides]
 *     summary: Delete one of your own company's guide videos (admin only)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Deleted }
 */
router.patch('/videos/:id', requireUser, requireRole('admin'), async (req, res) => {
  const { title, description, youtube_url, visibility } = req.body;
  if (visibility !== undefined && !VIDEO_VISIBILITIES.includes(visibility)) {
    return res.status(400).json({ error: 'validation_error', message: 'visibility must be admin or all' });
  }
  // company_id = req.auth.companyId in the WHERE means this can never match a global
  // (company_id IS NULL) video or another company's -- an admin can only ever touch
  // videos their own company added.
  const { rows } = await pool.query(
    `UPDATE guide_videos SET
       title = COALESCE($1, title), description = COALESCE($2, description),
       youtube_url = COALESCE($3, youtube_url), visibility = COALESCE($4, visibility)
     WHERE id = $5 AND company_id = $6 RETURNING *`,
    [title, description, youtube_url, visibility, req.params.id, req.auth.companyId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

router.delete('/videos/:id', requireUser, requireRole('admin'), async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM guide_videos WHERE id = $1 AND company_id = $2',
    [req.params.id, req.auth.companyId]
  );
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

module.exports = router;
