const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireOwner } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireOwner);

const VIDEO_VISIBILITIES = ['admin', 'all'];

// company_id IS NULL throughout this file -- these routes manage only the global
// library. Company-specific videos (added by a company's own admin, migration 036)
// live in the same table but are managed exclusively via routes/guides.js, scoped to
// that admin's own company_id, so they never show up or get touched here.
async function withVideos(categories) {
  const { rows: videos } = await pool.query('SELECT * FROM guide_videos WHERE company_id IS NULL ORDER BY sort_order, created_at');
  return categories.map((c) => ({ ...c, videos: videos.filter((v) => v.category_id === c.id) }));
}

/**
 * @openapi
 * /api/owner/guides:
 *   get:
 *     tags: [Owner Guides]
 *     summary: List all guide categories with their videos
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Categories with nested videos }
 */
router.get('/', async (req, res) => {
  const { rows: categories } = await pool.query('SELECT * FROM guide_categories ORDER BY sort_order, created_at');
  res.json(await withVideos(categories));
});

/**
 * @openapi
 * /api/owner/guides/categories:
 *   post:
 *     tags: [Owner Guides]
 *     summary: Create a new guide category
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *     responses:
 *       201: { description: Category created }
 */
router.post('/categories', body('name').isString().trim().notEmpty(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });
  const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM guide_categories');
  const { rows } = await pool.query(
    'INSERT INTO guide_categories (name, sort_order) VALUES ($1,$2) RETURNING *',
    [req.body.name, maxOrder.rows[0].m + 1]
  );
  res.status(201).json({ ...rows[0], videos: [] });
});

/**
 * @openapi
 * /api/owner/guides/categories/{id}:
 *   patch:
 *     tags: [Owner Guides]
 *     summary: Rename or reorder a guide category
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated category }
 *   delete:
 *     tags: [Owner Guides]
 *     summary: Delete a guide category and all its videos
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Deleted }
 */
router.patch('/categories/:id', async (req, res) => {
  const { name, sort_order } = req.body;
  const { rows } = await pool.query(
    'UPDATE guide_categories SET name = COALESCE($1, name), sort_order = COALESCE($2, sort_order) WHERE id = $3 RETURNING *',
    [name, sort_order, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

router.delete('/categories/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM guide_categories WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

/**
 * @openapi
 * /api/owner/guides/videos:
 *   post:
 *     tags: [Owner Guides]
 *     summary: Add a guide video to a category
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
 *               visibility: { type: string, enum: [admin, all], description: "Who can see this video on the company side — admin only, or admin + employee. Defaults to all." }
 *     responses:
 *       201: { description: Video added }
 */
router.post(
  '/videos',
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
    const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM guide_videos WHERE category_id = $1', [category_id]);
    const { rows } = await pool.query(
      `INSERT INTO guide_videos (category_id, title, description, youtube_url, sort_order, visibility)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [category_id, title, description || null, youtube_url, maxOrder.rows[0].m + 1, visibility || 'all']
    );
    res.status(201).json(rows[0]);
  }
);

/**
 * @openapi
 * /api/owner/guides/videos/{id}:
 *   patch:
 *     tags: [Owner Guides]
 *     summary: Update a guide video
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Updated video }
 *   delete:
 *     tags: [Owner Guides]
 *     summary: Delete a guide video
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Deleted }
 */
router.patch('/videos/:id', async (req, res) => {
  const { category_id, title, description, youtube_url, sort_order, visibility } = req.body;
  if (visibility !== undefined && !VIDEO_VISIBILITIES.includes(visibility)) {
    return res.status(400).json({ error: 'validation_error', message: 'visibility must be admin or all' });
  }
  const { rows } = await pool.query(
    `UPDATE guide_videos SET
       category_id = COALESCE($1, category_id), title = COALESCE($2, title),
       description = COALESCE($3, description), youtube_url = COALESCE($4, youtube_url),
       sort_order = COALESCE($5, sort_order), visibility = COALESCE($6, visibility)
     WHERE id = $7 AND company_id IS NULL RETURNING *`,
    [category_id, title, description, youtube_url, sort_order, visibility, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

router.delete('/videos/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM guide_videos WHERE id = $1 AND company_id IS NULL', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

module.exports = router;
