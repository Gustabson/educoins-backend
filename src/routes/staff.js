// src/routes/staff.js
// Endpoints accesibles para cuentas staff (y admin).
// Principalmente: enviar y ver propias solicitudes al superadmin.

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

const STUDENT_ROLES = new Set(['student', 'parent']);

function notStudent(req, res, next) {
  if (!req.user) return res.status(401).json({ ok: false, error: { code: 'NO_TOKEN' } });
  if (STUDENT_ROLES.has(req.user.rol)) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Sin permisos' } });
  }
  next();
}

// ── POST /api/v1/staff/proposals ─────────────────────────────
// Cualquier usuario no-alumno puede enviar una solicitud al superadmin
router.post('/proposals', auth, notStudent, async (req, res) => {
  try {
    const { seccion, titulo, descripcion } = req.body;
    if (!seccion || !titulo || !descripcion) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'seccion, titulo y descripcion son requeridos' } });
    }
    const { rows } = await db.query(
      `INSERT INTO admin_proposals (id, from_user_id, seccion, titulo, descripcion)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)
       RETURNING *`,
      [req.user.id, seccion.slice(0,50), titulo.slice(0,100), descripcion.slice(0,1000)]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /api/v1/staff/proposals/mine ─────────────────────────
// Cada staff ve solo sus propias propuestas
router.get('/proposals/mine', auth, notStudent, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*, r.nombre AS resolved_nombre
       FROM admin_proposals p
       LEFT JOIN users r ON r.id = p.resolved_by
       WHERE p.from_user_id = $1
       ORDER BY p.created_at DESC`,
      [req.user.id]
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;
