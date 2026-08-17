const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireOwner } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireOwner);

const CATEGORIES = ['added', 'changed', 'removed', 'fixed'];

/**
 * @openapi
 * /api/owner/changelog:
 *   get:
 *     tags: [Owner Changelog]
 *     summary: List all system changelog entries, newest first
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of changelog entries }
 *   post:
 *     tags: [Owner Changelog]
 *     summary: Add a new changelog entry
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [version, category, title]
 *             properties:
 *               version: { type: string }
 *               category: { type: string, enum: [added, changed, removed, fixed] }
 *               title: { type: string }
 *               description: { type: string }
 *               released_at: { type: string, format: date-time }
 *     responses:
 *       201: { description: Entry created }
 */
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cl.*, o.full_name AS created_by_name
     FROM system_changelog cl LEFT JOIN owners o ON o.id = cl.created_by
     ORDER BY cl.released_at DESC, cl.id DESC`
  );
  res.json(rows);
});

router.post(
  '/',
  body('version').isString().trim().notEmpty(),
  body('category').isIn(CATEGORIES),
  body('title').isString().trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });
    const { version, category, title, description, released_at } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO system_changelog (version, category, title, description, released_at, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5, now()),$6) RETURNING *`,
      [version, category, title, description || null, released_at || null, req.auth.ownerId]
    );
    res.status(201).json(rows[0]);
  }
);

module.exports = router;
