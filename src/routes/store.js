// src/routes/store.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db    = require('../config/db');
const auth  = require('../middleware/auth');
const roles = require('../middleware/roles');
const router = express.Router();

router.get('/items', auth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM store_items WHERE activo=true ORDER BY precio ASC');
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.post('/items', auth, roles('admin'), async (req, res) => {
  try {
    const { nombre, descripcion, precio, stock, icon } = req.body;
    if (!nombre || !precio) return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'Nombre y precio requeridos' } });
    const { rows } = await db.query(
      `INSERT INTO store_items (id,nombre,descripcion,precio,stock,icon) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [uuidv4(), nombre, descripcion, precio, stock ?? -1, icon]
    );
    res.status(201).json({ ok: true, data: rows[0] });
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
