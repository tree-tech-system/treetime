const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pool = require('../db/pool');
const { authenticate, requireOwner } = require('../middleware/auth');

const router = express.Router();

const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads', 'branding');
const DEFAULT_LOGO = path.join(__dirname, '..', '..', '..', '..', 'var', 'www', 'html', 'owner', 'icon.png');
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'svg', 'webp']);
const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp' };

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
      cb(null, UPLOAD_ROOT);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(1).toLowerCase();
      cb(null, `logo_${Date.now()}.${ext}`);
    },
  }),
  limits: { fileSize: MAX_LOGO_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(1).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) return cb(new Error('file_type_not_allowed'));
    cb(null, true);
  },
});

/**
 * @openapi
 * /api/branding/logo:
 *   get:
 *     tags: [Branding]
 *     summary: Public — current platform logo (favicon/brand mark), or the built-in default if none was uploaded
 *     responses:
 *       200: { description: Image stream }
 */
router.get('/logo', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM platform_branding WHERE id = 1');
  const branding = rows[0];
  if (branding?.logo_path && fs.existsSync(branding.logo_path)) {
    res.setHeader('Content-Type', branding.logo_mime || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return fs.createReadStream(branding.logo_path).pipe(res);
  }
  if (fs.existsSync(DEFAULT_LOGO)) {
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return fs.createReadStream(DEFAULT_LOGO).pipe(res);
  }
  res.status(404).json({ error: 'no_logo' });
});

/**
 * @openapi
 * /api/branding/meta:
 *   get:
 *     tags: [Branding]
 *     summary: Public — when the logo was last updated (for cache-busting)
 *     responses:
 *       200: { description: Metadata }
 */
router.get('/meta', async (req, res) => {
  const { rows } = await pool.query('SELECT updated_at FROM platform_branding WHERE id = 1');
  res.json({ updated_at: rows[0]?.updated_at || null });
});

/**
 * @openapi
 * /api/owner/branding/logo:
 *   post:
 *     tags: [Branding]
 *     summary: Upload a new platform logo — replaces it everywhere immediately (owner only)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200: { description: Logo updated }
 *       400: { description: File type not allowed or exceeds size limit }
 */
router.post(
  '/owner/logo',
  authenticate,
  requireOwner,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'file_too_large', message: 'Max size is 5MB.' });
      }
      if (err) return res.status(400).json({ error: 'file_type_not_allowed' });
      next();
    });
  },
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no_file' });
    const ext = path.extname(req.file.originalname).slice(1).toLowerCase();

    const old = await pool.query('SELECT logo_path FROM platform_branding WHERE id = 1');
    if (old.rows[0]?.logo_path) fs.unlink(old.rows[0].logo_path, () => {});

    const { rows } = await pool.query(
      `INSERT INTO platform_branding (id, logo_path, logo_mime, updated_at) VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET logo_path = $1, logo_mime = $2, updated_at = now()
       RETURNING *`,
      [req.file.path, MIME_BY_EXT[ext] || req.file.mimetype]
    );
    res.json({ ok: true, updated_at: rows[0].updated_at });
  }
);

module.exports = router;
