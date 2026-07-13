// src/routes/store.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db    = require('../config/db');
const auth  = require('../middleware/auth');
const roles = require('../middleware/roles');
const uuidParams = require('../middleware/uuid-params');
const router = express.Router();
uuidParams(router, 'id');

const text = (value, max, field, required=false) => {
  if (value == null || value === '') {
    if (required) {
      const err = new Error(`${field} es requerido`);
      err.code = 'MISSING_FIELDS';
      throw err;
    }
    return null;
  }
  if (typeof value !== 'string') {
    const err = new Error(`${field} debe ser texto`);
    err.code = 'INVALID_FIELD';
    throw err;
  }
  const clean = value.trim();
  if (required && !clean) {
    const err = new Error(`${field} es requerido`);
    err.code = 'MISSING_FIELDS';
    throw err;
  }
  if (clean.length > max) {
    const err = new Error(`${field} supera el máximo de ${max} caracteres`);
    err.code = 'FIELD_TOO_LONG';
    throw err;
  }
  return clean || null;
};

const positiveInteger = (value, field, { unlimited=false }={}) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (unlimited ? parsed < -1 : parsed <= 0)) {
    const err = new Error(`${field} debe ser un entero ${unlimited ? 'mayor o igual a -1' : 'positivo'}`);
    err.code = 'INVALID_FIELD';
    throw err;
  }
  return parsed;
};

const imageUrl = value => {
  const clean = text(value, 750000, 'imagen_url');
  if (!clean) return null;
  if (!/^https:\/\//i.test(clean) && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(clean)) {
    const err = new Error('La imagen debe usar HTTPS o ser una imagen PNG, JPG, WebP o GIF');
    err.code = 'INVALID_IMAGE';
    throw err;
  }
  return clean;
};

// ── Startup migrations ────────────────────────────────────────
db.query(`ALTER TABLE store_items ADD COLUMN IF NOT EXISTS published_by UUID REFERENCES users(id) ON DELETE SET NULL`)
  .catch(e => console.warn('[store] migration published_by:', e.message));

db.query(`
  CREATE TABLE IF NOT EXISTS store_reports (
    id          SERIAL PRIMARY KEY,
    item_id     UUID NOT NULL REFERENCES store_items(id) ON DELETE CASCADE,
    reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason      TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(item_id, reporter_id)
  )
`).catch(e => console.warn('[store] migration store_reports:', e.message));

// ── Helper: publisher info query ──────────────────────────────
const ITEM_SELECT = `
  SELECT si.id, si.nombre, si.descripcion, si.precio, si.stock,
         si.icon, si.activo, si.imagen_url, si.mensaje_oculto,
         si.published_by, si.created_at,
         u.nombre  AS publisher_nombre,
         u.rol     AS publisher_rol,
         u.foto_url AS publisher_foto
  FROM store_items si
  LEFT JOIN users u ON si.published_by = u.id
`;

// ── GET /items/mine — anuncios del usuario actual ─────────────
router.get('/items/mine', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      ITEM_SELECT + ` WHERE si.published_by=$1 ORDER BY si.created_at DESC`,
      [req.user.id]
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /items ────────────────────────────────────────────────
router.get('/items', auth, async (req, res) => {
  try {
    const isMod = ['admin','teacher'].includes(req.user.rol);
    const { rows } = await db.query(
      ITEM_SELECT +
      ` WHERE (si.activo = true OR $1)
          AND (si.published_by IS NULL OR u.activo = TRUE OR $1)
        ORDER BY
          CASE WHEN u.rol IN ('admin','teacher') OR si.published_by IS NULL THEN 0 ELSE 1 END,
          si.created_at DESC`,
      [isMod]
    );

    // Reveal mensaje_oculto only for purchased items (non-admin)
    if (!isMod) {
      const { rows: purchased } = await db.query(
        `SELECT reference_id FROM transactions
         WHERE initiated_by=$1 AND type='purchase' AND reference_type='store_item'`,
        [req.user.id]
      );
      const purchasedIds = new Set(purchased.map(p => p.reference_id));
      return res.json({ ok: true, data: rows.map(item => ({
        ...item,
        mensaje_oculto: purchasedIds.has(item.id) || item.published_by === req.user.id
          ? item.mensaje_oculto
          : null,
      })) });
    }
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /items — cualquier usuario autenticado puede crear ───
router.post('/items', auth, roles('student','teacher','admin'), async (req, res) => {
  try {
    const { nombre, descripcion, precio, stock, icon, imagen_url, mensaje_oculto, activo } = req.body;
    const cleanNombre = text(nombre, 120, 'nombre', true);
    const cleanDescription = text(descripcion, 2000, 'descripcion');
    const cleanPrice = positiveInteger(precio, 'precio');
    const cleanStock = stock == null || stock === '' ? -1 : positiveInteger(stock, 'stock', { unlimited:true });
    const cleanIcon = text(icon, 10, 'icon') || '🎁';
    const cleanImage = imageUrl(imagen_url);
    const cleanHidden = text(mensaje_oculto, 2000, 'mensaje_oculto');

    // Admins/teachers can set activo=true directly; students default to true too (community-moderated)
    const isActive = typeof activo === 'boolean' ? activo : true;

    const { rows } = await db.query(`
      INSERT INTO store_items
        (id, nombre, descripcion, precio, stock, icon, imagen_url, mensaje_oculto, activo, published_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [uuidv4(), cleanNombre, cleanDescription, cleanPrice, cleanStock,
        cleanIcon, cleanImage, cleanHidden, isActive, req.user.id]);

    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    const isValidation = ['MISSING_FIELDS','INVALID_FIELD','FIELD_TOO_LONG','INVALID_IMAGE'].includes(err.code);
    res.status(isValidation ? 400 : 500).json({
      ok: false,
      error: { code: isValidation ? err.code : 'SERVER_ERROR', message: isValidation ? err.message : 'Error interno del servidor' }
    });
  }
});

// ── PATCH /items/:id — owner o admin/teacher ──────────────────
router.patch('/items/:id', auth, async (req, res) => {
  try {
    const isMod = ['admin','teacher'].includes(req.user.rol);
    // Check ownership
    const { rows: existing } = await db.query('SELECT published_by FROM store_items WHERE id=$1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    if (!isMod && existing[0].published_by !== req.user.id)
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } });

    const { nombre, descripcion, precio, stock, icon, activo, imagen_url, mensaje_oculto } = req.body;
    const cleanNombre = nombre === undefined ? null : text(nombre, 120, 'nombre', true);
    const cleanDescription = descripcion === undefined ? null : text(descripcion, 2000, 'descripcion');
    const cleanPrice = precio === undefined ? null : positiveInteger(precio, 'precio');
    const cleanStock = stock === undefined ? null : positiveInteger(stock, 'stock', { unlimited:true });
    const cleanIcon = icon === undefined ? null : text(icon, 10, 'icon', true);
    const cleanActive = typeof activo === 'boolean' ? activo : null;
    const cleanImage = imagen_url === undefined ? null : imageUrl(imagen_url);
    const cleanHidden = mensaje_oculto === undefined ? null : text(mensaje_oculto, 2000, 'mensaje_oculto');
    const { rows } = await db.query(`
      UPDATE store_items SET
        nombre         = COALESCE($1, nombre),
        descripcion    = COALESCE($2, descripcion),
        precio         = COALESCE($3, precio),
        stock          = COALESCE($4, stock),
        icon           = COALESCE($5, icon),
        activo         = COALESCE($6, activo),
        imagen_url     = COALESCE($7, imagen_url),
        mensaje_oculto = COALESCE($8, mensaje_oculto)
      WHERE id=$9 RETURNING *
    `, [cleanNombre, cleanDescription, cleanPrice, cleanStock, cleanIcon, cleanActive, cleanImage, cleanHidden, req.params.id]);
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    const isValidation = ['MISSING_FIELDS','INVALID_FIELD','FIELD_TOO_LONG','INVALID_IMAGE'].includes(err.code);
    res.status(isValidation ? 400 : 500).json({
      ok: false,
      error: { code: isValidation ? err.code : 'SERVER_ERROR', message: isValidation ? err.message : 'Error interno del servidor' }
    });
  }
});

// ── DELETE /items/:id — owner o admin ────────────────────────
router.delete('/items/:id', auth, async (req, res) => {
  try {
    const isMod = ['admin','teacher'].includes(req.user.rol);
    const { rows: existing } = await db.query('SELECT published_by FROM store_items WHERE id=$1', [req.params.id]);
    if (!existing.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    if (!isMod && existing[0].published_by !== req.user.id)
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } });
    await db.query('DELETE FROM store_items WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /items/:id/report — reportar un anuncio ──────────────
router.post('/items/:id/report', auth, async (req, res) => {
  try {
    const reason = text(req.body.reason, 300, 'reason', true);

    const { rows: item } = await db.query('SELECT nombre, published_by FROM store_items WHERE id=$1', [req.params.id]);
    if (!item.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    if (item[0].published_by === req.user.id)
      return res.status(400).json({ ok: false, error: { code: 'SELF_REPORT', message: 'No podés reportar tu propio anuncio' } });

    // Insert report (unique per reporter+item → can't double-report)
    await db.query(
      `INSERT INTO store_reports (item_id, reporter_id, reason) VALUES ($1,$2,$3)
       ON CONFLICT (item_id, reporter_id) DO UPDATE SET reason=$3`,
      [req.params.id, req.user.id, reason]
    );

    // Notify all admins
    const { rows: admins } = await db.query(`SELECT id FROM users WHERE rol='admin'`);
    if (admins.length) {
      await Promise.all(admins.map(a =>
        db.query(
          `INSERT INTO notifications (user_id, tipo, titulo, cuerpo, data)
           VALUES ($1,'store_report','Anuncio reportado',$2,$3)`,
          [a.id, `${item[0].nombre}: ${reason}`, JSON.stringify({ item_id: req.params.id, item_nombre: item[0].nombre, reason, reporter_id: req.user.id })]
        )
      ));
    }

    res.json({ ok: true });
  } catch (err) {
    const isValidation = ['MISSING_FIELDS','INVALID_FIELD','FIELD_TOO_LONG'].includes(err.code);
    res.status(isValidation ? 400 : 500).json({
      ok: false,
      error: { code: isValidation ? err.code : 'SERVER_ERROR', message: isValidation ? err.message : 'Error interno del servidor' }
    });
  }
});

module.exports = router;
