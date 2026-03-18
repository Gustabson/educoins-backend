// src/routes/store.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db    = require('../config/db');
const auth  = require('../middleware/auth');
const roles = require('../middleware/roles');
const router = express.Router();

// GET /items — alumnos ven solo activos; admin ve todos
router.get('/items', auth, async (req, res) => {
  try {
    const isAdmin = req.user.rol === 'admin';
    const { rows } = await db.query(
      `SELECT id,nombre,descripcion,precio,stock,icon,activo,imagen_url,
        CASE WHEN $1 THEN mensaje_oculto ELSE NULL END AS mensaje_oculto_admin
       FROM store_items
       WHERE ($1 OR activo=true)
       ORDER BY precio ASC`,
      [isAdmin]
    );
    // Para alumnos que compraron, revelar mensaje_oculto
    if (!isAdmin) {
      const { rows: purchased } = await db.query(
        `SELECT reference_id FROM transactions
         WHERE initiated_by=$1 AND type='purchase' AND reference_type='store_item'`,
        [req.user.id]
      );
      const purchasedIds = new Set(purchased.map(p => p.reference_id));
      return res.json({ ok: true, data: rows.map(item => ({
        ...item,
        mensaje_oculto: purchasedIds.has(item.id) ? item.mensaje_oculto_admin : null,
        mensaje_oculto_admin: undefined,
      })) });
    }
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /items — crear
router.post('/items', auth, roles('admin'), async (req, res) => {
  try {
    const { nombre, descripcion, precio, stock, icon, imagen_url, mensaje_oculto, activo=true } = req.body;
    if (!nombre || precio === undefined)
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS' } });
    const { rows } = await db.query(`
      INSERT INTO store_items (id,nombre,descripcion,precio,stock,icon,imagen_url,mensaje_oculto,activo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [uuidv4(), nombre, descripcion||null, precio, stock??-1, icon||'🎁', imagen_url||null, mensaje_oculto||null, activo]);
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// PATCH /items/:id — editar
router.patch('/items/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { nombre, descripcion, precio, stock, icon, activo, imagen_url, mensaje_oculto } = req.body;
    const { rows } = await db.query(`
      UPDATE store_items SET
        nombre        = COALESCE($1,nombre),
        descripcion   = COALESCE($2,descripcion),
        precio        = COALESCE($3,precio),
        stock         = COALESCE($4,stock),
        icon          = COALESCE($5,icon),
        activo        = COALESCE($6,activo),
        imagen_url    = COALESCE($7,imagen_url),
        mensaje_oculto= COALESCE($8,mensaje_oculto)
      WHERE id=$9 RETURNING *
    `, [nombre, descripcion, precio, stock, icon, activo, imagen_url, mensaje_oculto, req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// DELETE /items/:id — eliminar (admin)
router.delete('/items/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM store_items WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;

  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.patch('/items/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { nombre, descripcion, precio, stock, icon, activo } = req.body;
    const { rows } = await db.query(
      `UPDATE store_items SET
         nombre=COALESCE($1,nombre), descripcion=COALESCE($2,descripcion),
         precio=COALESCE($3,precio), stock=COALESCE($4,stock),
         icon=COALESCE($5,icon), activo=COALESCE($6,activo)
       WHERE id=$7 RETURNING *`,
      [nombre, descripcion, precio, stock, icon, activo, req.params.id]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;
