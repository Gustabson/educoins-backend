const express = require('express');
const router  = express.Router();
const { query } = require('../config/db');
const auth    = require('../middleware/auth');

// ── Startup migration ─────────────────────────────────────────
query(`
  CREATE TABLE IF NOT EXISTS academic_events (
    id          SERIAL PRIMARY KEY,
    titulo      TEXT NOT NULL,
    descripcion TEXT,
    fecha       DATE NOT NULL,
    tipo        TEXT NOT NULL DEFAULT 'evento',
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.error('[academic] migration:', e.message));

// ── Admin / administracion guard ──────────────────────────────
function guard(req, res, next) {
  const { rol, permisos } = req.user;
  if (rol === 'admin') return next();
  if (Array.isArray(permisos) && (permisos.includes('*') || permisos.includes('administracion'))) return next();
  return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Sin permiso' } });
}

// ── GET all — any authenticated user ─────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM academic_events ORDER BY fecha ASC, id ASC`
    );
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── POST create ───────────────────────────────────────────────
router.post('/', auth, guard, async (req, res) => {
  const { titulo, descripcion, fecha, tipo } = req.body;
  if (!titulo || !fecha)
    return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'titulo y fecha requeridos' } });
  try {
    const { rows } = await query(
      `INSERT INTO academic_events (titulo, descripcion, fecha, tipo, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [titulo, descripcion || null, fecha, tipo || 'evento', req.user.id]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── PATCH update ──────────────────────────────────────────────
router.patch('/:id', auth, guard, async (req, res) => {
  const { titulo, descripcion, fecha, tipo } = req.body;
  try {
    const { rows } = await query(
      `UPDATE academic_events SET titulo=$1, descripcion=$2, fecha=$3, tipo=$4
       WHERE id=$5 RETURNING *`,
      [titulo, descripcion || null, fecha, tipo || 'evento', req.params.id]
    );
    if (!rows[0])
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Evento no encontrado' } });
    res.json({ ok: true, data: rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── DELETE ────────────────────────────────────────────────────
router.delete('/:id', auth, guard, async (req, res) => {
  try {
    await query(`DELETE FROM academic_events WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, data: null });
  } catch (e) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

module.exports = router;
