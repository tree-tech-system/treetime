const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireRole, requireScope } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads');
const MAX_FILE_BYTES = 39999 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  'gif', 'jpg', 'jpeg', 'png', 'tif', 'pdf', 'doc', 'docx', 'xls', 'txt', 'html', 'xlsx', 'xlsm', 'psd', 'csv',
  'xml', 'eml', 'msg', 'zip', 'mp4', 'webm', 'mp3', 'rtf', 'odt', 'md', 'ppt', 'pptx', 'json', 'sql', 'log',
  'bmp', 'svg', 'heic', 'mdb', 'sqlite', 'accdb', '7z', 'rar', 'tar', 'docm', 'x_t', 'btw', 'vsd', 'vsdx',
  'dsn', 'dwg', 'mov', 'sldprt', 'slddrw',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_ROOT, `company_${req.auth.companyId}`, `project_${req.params.id}`);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, `field_${req.params.fieldId}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) return cb(new Error('file_type_not_allowed'));
    cb(null, true);
  },
});

function companyIdOf(req) {
  return req.auth.companyId;
}
function actingEmployeeId(req) {
  return req.auth.type === 'user' ? req.auth.employeeId : null;
}

const PROJECT_FIELDS = `p.*, COALESCE(
  (SELECT array_agg(pf.employee_id) FROM project_freelancers pf WHERE pf.project_id = p.id), '{}'
) AS linked_employee_ids`;

const PROJECT_LIST_FIELDS = `
  p.*,
  ROW_NUMBER() OVER (PARTITION BY p.company_id ORDER BY p.created_at) AS serial_number,
  cb.full_name AS created_by_name,
  ub.full_name AS updated_by_name,
  COALESCE((SELECT array_agg(pf.employee_id) FROM project_freelancers pf WHERE pf.project_id = p.id), '{}') AS linked_employee_ids,
  COALESCE(
    (SELECT jsonb_object_agg(fv.field_id, jsonb_build_object(
        'value', fv.value, 'file_name', fv.file_name, 'file_size', fv.file_size, 'file_mime', fv.file_mime
      ))
     FROM project_field_values fv WHERE fv.project_id = p.id),
    '{}'::jsonb
  ) AS field_values
`;

/**
 * @openapi
 * /api/projects:
 *   get:
 *     tags: [Projects]
 *     summary: List clients (projects) for the caller's company
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: include_archived
 *         schema: { type: boolean }
 *     responses:
 *       200: { description: List of clients, each with linked_employee_ids }
 */
router.get('/', requireScope('read'), async (req, res) => {
  const includeArchived = req.query.include_archived === 'true';
  const { rows } = await pool.query(
    `SELECT ${PROJECT_LIST_FIELDS}
     FROM projects p
     LEFT JOIN employees cb ON cb.id = p.created_by
     LEFT JOIN employees ub ON ub.id = p.updated_by
     WHERE p.company_id = $1 ${includeArchived ? '' : 'AND p.archived = FALSE'}
     ORDER BY p.created_at DESC`,
    [companyIdOf(req)]
  );
  res.json(rows);
});

/**
 * @openapi
 * /api/projects:
 *   post:
 *     tags: [Projects]
 *     summary: Create a client (manager/admin only, or API key with write scope)
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *               business_name: { type: string }
 *               contact_phone: { type: string }
 *               contact_email: { type: string }
 *               description: { type: string }
 *               color: { type: string }
 *               use_hours_bank: { type: boolean }
 *               monthly_quota_hours: { type: number }
 *     responses:
 *       201: { description: Client created }
 */
router.post(
  '/',
  requireScope('write'),
  (req, res, next) => (req.auth.type === 'user' ? requireRole('manager', 'admin')(req, res, next) : next()),
  body('name').isString().trim().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });
    const { name, business_name, contact_phone, contact_email, description, color, monthly_quota_hours, payment_method, hourly_rate } = req.body;
    const paymentMethod = ['hourly', 'hours_bank'].includes(payment_method) ? payment_method : 'hours_bank';
    const actingId = actingEmployeeId(req);
    const instanceId = crypto.randomBytes(12).toString('hex');
    const { rows } = await pool.query(
      `INSERT INTO projects (
         name, business_name, contact_phone, contact_email, description, color, use_hours_bank, monthly_quota_hours,
         payment_method, hourly_rate, company_id, created_by, updated_by, instance_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13) RETURNING *`,
      [name, business_name || null, contact_phone || null, contact_email || null, description || null,
       color || '#2F6F4E', paymentMethod === 'hours_bank', monthly_quota_hours || 0,
       paymentMethod, hourly_rate || 0, companyIdOf(req), actingId, instanceId]
    );
    res.status(201).json({ ...rows[0], linked_employee_ids: [] });
  }
);

/**
 * @openapi
 * /api/projects/{id}:
 *   patch:
 *     tags: [Projects]
 *     summary: Update a client's info, quota, or archive it
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Updated client }
 */
router.patch(
  '/:id',
  requireScope('write'),
  (req, res, next) => (req.auth.type === 'user' ? requireRole('manager', 'admin')(req, res, next) : next()),
  async (req, res) => {
    const { name, business_name, contact_phone, contact_email, description, color, archived, monthly_quota_hours, payment_method, hourly_rate } = req.body;
    const paymentMethod = ['hourly', 'hours_bank'].includes(payment_method) ? payment_method : null;
    const { rows } = await pool.query(
      `UPDATE projects SET
         name = COALESCE($1, name),
         business_name = COALESCE($2, business_name),
         contact_phone = COALESCE($3, contact_phone),
         contact_email = COALESCE($4, contact_email),
         description = COALESCE($5, description),
         color = COALESCE($6, color),
         archived = COALESCE($7, archived),
         monthly_quota_hours = COALESCE($8, monthly_quota_hours),
         updated_by = COALESCE($11, updated_by),
         payment_method = COALESCE($12, payment_method),
         hourly_rate = COALESCE($13, hourly_rate),
         use_hours_bank = CASE WHEN $12::varchar IS NOT NULL THEN ($12 = 'hours_bank') ELSE use_hours_bank END
       WHERE id = $9 AND company_id = $10 RETURNING *`,
      [name, business_name, contact_phone, contact_email, description, color, archived, monthly_quota_hours, req.params.id, companyIdOf(req), actingEmployeeId(req), paymentMethod, hourly_rate]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  }
);

/**
 * @openapi
 * /api/projects/{id}/freelancers:
 *   put:
 *     tags: [Projects]
 *     summary: Set which freelancers may log time for this client (empty = open to everyone)
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [employee_ids]
 *             properties:
 *               employee_ids: { type: array, items: { type: integer } }
 *     responses:
 *       200: { description: Updated linked freelancers }
 */
router.put(
  '/:id/freelancers',
  requireScope('write'),
  (req, res, next) => (req.auth.type === 'user' ? requireRole('manager', 'admin')(req, res, next) : next()),
  async (req, res) => {
    const projectCheck = await pool.query('SELECT id FROM projects WHERE id = $1 AND company_id = $2', [req.params.id, companyIdOf(req)]);
    if (!projectCheck.rows[0]) return res.status(404).json({ error: 'not_found' });

    const employeeIds = Array.isArray(req.body.employee_ids) ? req.body.employee_ids : [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM project_freelancers WHERE project_id = $1', [req.params.id]);
      for (const empId of employeeIds) {
        await client.query('INSERT INTO project_freelancers (project_id, employee_id) VALUES ($1,$2)', [req.params.id, empId]);
      }
      await client.query('COMMIT');
      res.json({ project_id: Number(req.params.id), linked_employee_ids: employeeIds });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
);

async function assertProjectInCompany(projectId, companyId) {
  const { rows } = await pool.query('SELECT id FROM projects WHERE id = $1 AND company_id = $2', [projectId, companyId]);
  return !!rows[0];
}

async function assertFieldInCompany(fieldId, companyId) {
  const { rows } = await pool.query('SELECT * FROM company_client_fields WHERE id = $1 AND company_id = $2', [fieldId, companyId]);
  return rows[0] || null;
}

/**
 * @openapi
 * /api/projects/{id}/fields/{fieldId}:
 *   put:
 *     tags: [Projects]
 *     summary: Set a client card's value for a custom field (text/textarea/url/select types)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: fieldId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               value: { type: string }
 *     responses:
 *       200: { description: Value saved }
 */
router.put(
  '/:id/fields/:fieldId',
  (req, res, next) => (req.auth.type === 'user' ? requireRole('manager', 'admin')(req, res, next) : next()),
  async (req, res) => {
    if (!(await assertProjectInCompany(req.params.id, companyIdOf(req)))) return res.status(404).json({ error: 'not_found' });
    const field = await assertFieldInCompany(req.params.fieldId, companyIdOf(req));
    if (!field) return res.status(404).json({ error: 'field_not_found' });
    if (field.field_type === 'file') return res.status(400).json({ error: 'use_file_upload_endpoint' });
    if (field.field_type === 'select' && req.body.value && !(field.options || []).includes(req.body.value)) {
      return res.status(400).json({ error: 'invalid_option' });
    }

    const { rows } = await pool.query(
      `INSERT INTO project_field_values (project_id, field_id, value)
       VALUES ($1,$2,$3)
       ON CONFLICT (project_id, field_id) DO UPDATE SET value = $3, updated_at = now()
       RETURNING *`,
      [req.params.id, req.params.fieldId, req.body.value ?? null]
    );
    res.json(rows[0]);
  }
);

/**
 * @openapi
 * /api/projects/{id}/fields/{fieldId}/file:
 *   post:
 *     tags: [Projects]
 *     summary: Upload a file for a custom field of type "file"
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: fieldId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200: { description: File uploaded }
 *       400: { description: File type not allowed or exceeds size limit }
 */
router.post(
  '/:id/fields/:fieldId/file',
  (req, res, next) => (req.auth.type === 'user' ? requireRole('manager', 'admin')(req, res, next) : next()),
  async (req, res, next) => {
    if (!(await assertProjectInCompany(req.params.id, companyIdOf(req)))) return res.status(404).json({ error: 'not_found' });
    const field = await assertFieldInCompany(req.params.fieldId, companyIdOf(req));
    if (!field) return res.status(404).json({ error: 'field_not_found' });
    if (field.field_type !== 'file') return res.status(400).json({ error: 'not_a_file_field' });
    next();
  },
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'file_too_large', message: 'Max size is 39999KB.' });
      }
      if (err) return res.status(400).json({ error: 'file_type_not_allowed' });
      next();
    });
  },
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no_file' });

    const old = await pool.query('SELECT file_path FROM project_field_values WHERE project_id = $1 AND field_id = $2', [req.params.id, req.params.fieldId]);
    if (old.rows[0]?.file_path) fs.unlink(old.rows[0].file_path, () => {});

    const { rows } = await pool.query(
      `INSERT INTO project_field_values (project_id, field_id, file_name, file_path, file_size, file_mime)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (project_id, field_id) DO UPDATE SET
         file_name = $3, file_path = $4, file_size = $5, file_mime = $6, value = NULL, updated_at = now()
       RETURNING id, project_id, field_id, file_name, file_size, file_mime, updated_at`,
      [req.params.id, req.params.fieldId, req.file.originalname, req.file.path, req.file.size, req.file.mimetype]
    );
    res.json(rows[0]);
  }
);

/**
 * @openapi
 * /api/projects/{id}/fields/{fieldId}/file:
 *   get:
 *     tags: [Projects]
 *     summary: Download the file stored for a custom field
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: fieldId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: File stream }
 *       404: { description: No file stored for this field }
 */
router.get('/:id/fields/:fieldId/file', async (req, res) => {
  if (!(await assertProjectInCompany(req.params.id, companyIdOf(req)))) return res.status(404).json({ error: 'not_found' });
  const { rows } = await pool.query(
    'SELECT * FROM project_field_values WHERE project_id = $1 AND field_id = $2',
    [req.params.id, req.params.fieldId]
  );
  const val = rows[0];
  if (!val || !val.file_path || !fs.existsSync(val.file_path)) return res.status(404).json({ error: 'no_file' });
  res.setHeader('Content-Type', val.file_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(val.file_name || 'file')}"`);
  fs.createReadStream(val.file_path).pipe(res);
});

module.exports = router;
