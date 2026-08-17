const express = require('express');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const pool = require('../db/pool');
const { authenticate, requireRole, requireScope } = require('../middleware/auth');
const { sendWelcomeEmail } = require('../lib/authEmails');

const router = express.Router();
router.use(authenticate);

const EMPLOYEE_FIELDS = `id, public_id, full_name, email, phone, role, active, hourly_rate, business_type, created_at,
  notes, foreign_worker, bank_beneficiary, bank_name, bank_branch, bank_account, bank_tax_id`;

const EMPLOYEE_LIST_FIELDS = `${EMPLOYEE_FIELDS},
  COALESCE(
    (SELECT jsonb_object_agg(fv.field_id, jsonb_build_object(
        'value', fv.value, 'file_name', fv.file_name, 'file_size', fv.file_size, 'file_mime', fv.file_mime
      ))
     FROM employee_field_values fv WHERE fv.employee_id = employees.id),
    '{}'::jsonb
  ) AS field_values`;

// Non-admin/manager employees can see who else is in the company (needed for e.g.
// "linked freelancers" display), but not their bank details, rate, notes, or
// uploaded custom-field files — that stays admin/manager-only.
const EMPLOYEE_LIST_FIELDS_BASIC = 'id, public_id, full_name, role, active';

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
      const dir = path.join(UPLOAD_ROOT, `company_${req.auth.companyId}`, `employee_${req.params.id}`);
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

/**
 * @openapi
 * /api/employees:
 *   get:
 *     tags: [Employees]
 *     summary: List employees (freelancers) in the caller's company
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     responses:
 *       200: { description: List of employees }
 *   post:
 *     tags: [Employees]
 *     summary: Add a new employee/freelancer to the caller's company (admin only)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [full_name, email, password]
 *             properties:
 *               full_name: { type: string }
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8 }
 *               phone: { type: string }
 *               hourly_rate: { type: number }
 *               business_type: { type: string }
 *               role: { type: string, enum: [employee, manager, admin] }
 *     responses:
 *       201: { description: Employee created }
 */
router.get(
  '/',
  requireScope('read'),
  async (req, res) => {
    const isAdminOrManager = req.auth.type !== 'user' || ['manager', 'admin'].includes(req.auth.role);
    const fields = isAdminOrManager ? EMPLOYEE_LIST_FIELDS : EMPLOYEE_LIST_FIELDS_BASIC;
    const { rows } = await pool.query(
      `SELECT ${fields} FROM employees WHERE company_id = $1 ORDER BY full_name`,
      [req.auth.companyId]
    );
    res.json(rows);
  }
);

router.post(
  '/',
  requireRole('admin'),
  body('full_name').isString().trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('password').isString().isLength({ min: 8 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'validation_error', details: errors.array() });
    const {
      full_name, email, password, role, phone, hourly_rate, business_type,
      notes, foreign_worker, bank_beneficiary, bank_name, bank_branch, bank_account, bank_tax_id,
    } = req.body;
    const password_hash = await bcrypt.hash(password, 12);
    try {
      const { rows } = await pool.query(
        `INSERT INTO employees (
           full_name, email, password_hash, role, company_id, phone, hourly_rate, business_type,
           notes, foreign_worker, bank_beneficiary, bank_name, bank_branch, bank_account, bank_tax_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING ${EMPLOYEE_FIELDS}`,
        [
          full_name, email, password_hash,
          ['employee', 'admin'].includes(role) ? role : 'employee',
          req.auth.companyId, phone || null, hourly_rate || 0, business_type || null,
          notes || null, !!foreign_worker, bank_beneficiary || null, bank_name || null,
          bank_branch || null, bank_account || null, bank_tax_id || null,
        ]
      );
      sendWelcomeEmail(rows[0], null).catch(() => {});
      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'email_taken' });
      throw err;
    }
  }
);

/**
 * @openapi
 * /api/employees/{id}:
 *   patch:
 *     tags: [Employees]
 *     summary: Update an employee's details (role, rate, active status, or reset their password)
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Updated employee }
 */
router.patch(
  '/:id',
  requireScope('write'),
  (req, res, next) => (req.auth.type === 'user' ? requireRole('admin')(req, res, next) : next()),
  async (req, res) => {
    const {
      active, full_name, email, password, phone, hourly_rate, business_type,
      notes, foreign_worker, bank_beneficiary, bank_name, bank_branch, bank_account, bank_tax_id,
    } = req.body;
    const role = ['employee', 'admin'].includes(req.body.role) ? req.body.role : undefined;
    const password_hash = password ? await bcrypt.hash(password, 12) : null;
    const { rows } = await pool.query(
      `UPDATE employees SET
         role = COALESCE($1, role),
         active = COALESCE($2, active),
         full_name = COALESCE($3, full_name),
         email = COALESCE($4, email),
         password_hash = COALESCE($5, password_hash),
         phone = COALESCE($6, phone),
         hourly_rate = COALESCE($7, hourly_rate),
         business_type = COALESCE($8, business_type),
         notes = COALESCE($9, notes),
         foreign_worker = COALESCE($10, foreign_worker),
         bank_beneficiary = COALESCE($11, bank_beneficiary),
         bank_name = COALESCE($12, bank_name),
         bank_branch = COALESCE($13, bank_branch),
         bank_account = COALESCE($14, bank_account),
         bank_tax_id = COALESCE($15, bank_tax_id)
       WHERE id = $16 AND company_id = $17 RETURNING ${EMPLOYEE_FIELDS}`,
      [
        role, active, full_name, email, password_hash, phone, hourly_rate, business_type,
        notes, foreign_worker, bank_beneficiary, bank_name, bank_branch, bank_account, bank_tax_id,
        req.params.id, req.auth.companyId,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  }
);

async function assertEmployeeInCompany(employeeId, companyId) {
  const { rows } = await pool.query('SELECT id FROM employees WHERE id = $1 AND company_id = $2', [employeeId, companyId]);
  return !!rows[0];
}

async function assertEmployeeFieldInCompany(fieldId, companyId) {
  const { rows } = await pool.query('SELECT * FROM company_employee_fields WHERE id = $1 AND company_id = $2', [fieldId, companyId]);
  return rows[0] || null;
}

/**
 * @openapi
 * /api/employees/{id}/fields/{fieldId}:
 *   put:
 *     tags: [Employees]
 *     summary: Set an employee card's value for a custom field (text/textarea/url/select types) — admin only
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Value saved }
 */
router.put('/:id/fields/:fieldId', requireRole('admin'), async (req, res) => {
  if (!(await assertEmployeeInCompany(req.params.id, req.auth.companyId))) return res.status(404).json({ error: 'not_found' });
  const field = await assertEmployeeFieldInCompany(req.params.fieldId, req.auth.companyId);
  if (!field) return res.status(404).json({ error: 'field_not_found' });
  if (field.field_type === 'file') return res.status(400).json({ error: 'use_file_upload_endpoint' });
  if (field.field_type === 'select' && req.body.value && !(field.options || []).includes(req.body.value)) {
    return res.status(400).json({ error: 'invalid_option' });
  }

  const { rows } = await pool.query(
    `INSERT INTO employee_field_values (employee_id, field_id, value)
     VALUES ($1,$2,$3)
     ON CONFLICT (employee_id, field_id) DO UPDATE SET value = $3, updated_at = now()
     RETURNING *`,
    [req.params.id, req.params.fieldId, req.body.value ?? null]
  );
  res.json(rows[0]);
});

/**
 * @openapi
 * /api/employees/{id}/fields/{fieldId}/file:
 *   post:
 *     tags: [Employees]
 *     summary: Upload a file for a custom field of type "file" on an employee card (admin only)
 *     security: [{ bearerAuth: [] }]
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
  requireRole('admin'),
  async (req, res, next) => {
    if (!(await assertEmployeeInCompany(req.params.id, req.auth.companyId))) return res.status(404).json({ error: 'not_found' });
    const field = await assertEmployeeFieldInCompany(req.params.fieldId, req.auth.companyId);
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

    const old = await pool.query('SELECT file_path FROM employee_field_values WHERE employee_id = $1 AND field_id = $2', [req.params.id, req.params.fieldId]);
    if (old.rows[0]?.file_path) fs.unlink(old.rows[0].file_path, () => {});

    const { rows } = await pool.query(
      `INSERT INTO employee_field_values (employee_id, field_id, file_name, file_path, file_size, file_mime)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (employee_id, field_id) DO UPDATE SET
         file_name = $3, file_path = $4, file_size = $5, file_mime = $6, value = NULL, updated_at = now()
       RETURNING id, employee_id, field_id, file_name, file_size, file_mime, updated_at`,
      [req.params.id, req.params.fieldId, req.file.originalname, req.file.path, req.file.size, req.file.mimetype]
    );
    res.json(rows[0]);
  }
);

/**
 * @openapi
 * /api/employees/{id}/fields/{fieldId}/file:
 *   get:
 *     tags: [Employees]
 *     summary: Download the file stored for a custom field on an employee card
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: File stream }
 *       404: { description: No file stored for this field }
 */
router.get('/:id/fields/:fieldId/file', async (req, res) => {
  if (!(await assertEmployeeInCompany(req.params.id, req.auth.companyId))) return res.status(404).json({ error: 'not_found' });
  const { rows } = await pool.query(
    'SELECT * FROM employee_field_values WHERE employee_id = $1 AND field_id = $2',
    [req.params.id, req.params.fieldId]
  );
  const val = rows[0];
  if (!val || !val.file_path || !fs.existsSync(val.file_path)) return res.status(404).json({ error: 'no_file' });
  res.setHeader('Content-Type', val.file_mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(val.file_name || 'file')}"`);
  fs.createReadStream(val.file_path).pipe(res);
});

module.exports = router;
