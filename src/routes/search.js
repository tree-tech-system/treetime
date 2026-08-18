const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireScope } = require('../middleware/auth');
const { ENTITIES, listEntities, listFields, listAllFields, runSearch } = require('../lib/searchEngine');

const router = express.Router();
router.use(authenticate, requireScope('read'));

/**
 * @openapi
 * /api/search/entities:
 *   get:
 *     tags: [Search]
 *     summary: List the searchable areas (entities) of TreeTime -- powers the "which area" picker in external integrations
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     responses:
 *       200: { description: "[{ key, label }]" }
 */
router.get('/entities', (req, res) => {
  res.json(listEntities());
});

/**
 * @openapi
 * /api/search/fields:
 *   get:
 *     tags: [Search]
 *     summary: Union of every searchable field across every entity, deduplicated by key
 *     description: >
 *       Exists for integration builders that can't cleanly make a field picker depend on
 *       an already-chosen entity (e.g. a dropdown nested inside another parameter in
 *       Make.com's custom app builder). Safe to over-offer -- POST .../query still
 *       rejects any field that isn't actually valid for the entity being queried.
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     responses:
 *       200: { description: "[{ key, label, type, operators }]" }
 */
router.get('/fields', (req, res) => {
  res.json(listAllFields());
});

/**
 * @openapi
 * /api/search/entities/{entity}/fields:
 *   get:
 *     tags: [Search]
 *     summary: List the searchable fields (and their allowed operators) for one entity
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: entity
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: "[{ key, label, type, operators }]" }
 *       404: { description: Unknown entity }
 */
router.get('/entities/:entity/fields', (req, res) => {
  const fields = listFields(req.params.entity);
  if (!fields) return res.status(404).json({ error: 'unknown_entity' });
  res.json(fields);
});

/**
 * @openapi
 * /api/search/{entity}/query:
 *   post:
 *     tags: [Search]
 *     summary: Search one entity by a flat list of field/operator/value conditions
 *     description: >
 *       Conditions are evaluated strictly left to right (each condition combines with
 *       everything before it via its own `connector`), not by normal SQL AND/OR
 *       precedence -- this matches how a visual "add AND rule / add OR rule" builder
 *       behaves. Every `field` and `operator` must come from
 *       GET /api/search/entities/{entity}/fields; anything else is rejected with 400.
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: entity
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               conditions:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [field, operator, value]
 *                   properties:
 *                     field: { type: string }
 *                     operator: { type: string, enum: [equals, not_equals, contains, gt, gte, lt, lte] }
 *                     value: {}
 *                     connector: { type: string, enum: [AND, OR], description: "Ignored for the first condition" }
 *               limit: { type: integer, minimum: 1, maximum: 200, default: 50 }
 *     responses:
 *       200: { description: Matching rows for this company, newest first }
 *       400: { description: Unknown field/operator, or bad request body }
 *       404: { description: Unknown entity }
 */
router.post(
  '/:entity/query',
  body('conditions').optional().isArray(),
  body('limit').optional().isInt({ min: 1, max: 200 }),
  async (req, res) => {
    if (!ENTITIES[req.params.entity]) return res.status(404).json({ error: 'unknown_entity' });
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });

    try {
      const rows = await runSearch(pool, req.params.entity, req.auth.companyId, req.body.conditions, req.body.limit);
      res.json(rows);
    } catch (err) {
      if (/^unknown_(field|operator|entity):/.test(err.message)) {
        return res.status(400).json({ error: 'validation_error', message: err.message });
      }
      throw err;
    }
  }
);

module.exports = router;
