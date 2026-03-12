// src/routes/reports.js
// Módulo de Reportes
//
// POST   /api/v1/reports              → crear reporte (cualquier usuario autenticado)
// GET    /api/v1/reports/mine         → mis reportes (student)
// GET    /api/v1/reports              → todos los reportes (admin)
// PATCH  /api/v1/reports/:id/estado   → cambiar estado (admin)

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');

const TIPOS_VALIDOS  = ['bullying', 'accidente', 'perdido', 'sugerencia', 'otro'];
const ESTADOS_VALIDOS = ['recibido', 'en_revision', 'resuelto', 'descartado'];

// ── POST /reports ─────────────────────────────────────────────
// Crear un reporte. Si anonimo=true, no se guarda el reporter_id.
// Body: { tipo, descripcion, anonimo?: boolean }
router.post('/', auth, async (req, res) => {
  try {
    const { tipo, descripcion, anonimo = false } = req.body;

    if (!tipo || !TIPOS_VALIDOS.includes(tipo)) {
      return res.status(400).json({
        ok: false,
        error: { code: 'INVALID_TIPO', message: `Tipo inválido. Opciones: ${TIPOS_VALIDOS.join(', ')}` }
      });
    }
    if (!descripcion || descripcion.trim().length < 10) {
      return res.status(400).json({
        ok: false,
        error: { code: 'INVALID_DESC', message: 'La descripción debe tener al menos 10 caracteres' }
      });
    }

    const reporterId = anonimo ? null : req.user.id;

    const { rows } = await db.query(`
      INSERT INTO reports (tipo, descripcion, reporter_id, estado)
      VALUES ($1, $2, $3, 'recibido')
      RETURNING id, tipo, descripcion, estado, created_at,
                (reporter_id IS NULL) AS anonimo
    `, [tipo, descripcion.trim(), reporterId]);

    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('POST /reports error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al crear reporte' } });
  }
});

// ── GET /reports/mine ─────────────────────────────────────────
// El alumno ve solo sus propios reportes NO anónimos
router.get('/mine', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        id, tipo, descripcion, estado, resolucion, created_at,
        (reporter_id IS NULL) AS anonimo
      FROM reports
      WHERE reporter_id = $1
      ORDER BY created_at DESC
    `, [req.user.id]);

    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('GET /reports/mine error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al obtener reportes' } });
  }
});

// ── GET /reports ──────────────────────────────────────────────
// Admin ve todos los reportes con filtros opcionales
// Query: ?estado=recibido&tipo=bullying&page=1
router.get('/', auth, roles('admin'), async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const estado = req.query.estado || null;
    const tipo   = req.query.tipo   || null;

    const { rows } = await db.query(`
      SELECT
        r.id,
        r.tipo,
        r.descripcion,
        r.estado,
        r.resolucion,
        r.created_at,
        r.updated_at,
        CASE WHEN r.reporter_id IS NULL THEN 'Anónimo'
             ELSE u.nombre END AS reporter_nombre,
        (r.reporter_id IS NULL) AS anonimo
      FROM reports r
      LEFT JOIN users u ON u.id = r.reporter_id
      WHERE ($1::text IS NULL OR r.estado = $1)
        AND ($2::text IS NULL OR r.tipo   = $2)
      ORDER BY r.created_at DESC
      LIMIT $3 OFFSET $4
    `, [estado, tipo, limit, offset]);

    const { rows: countRows } = await db.query(`
      SELECT COUNT(*)::int AS total FROM reports
      WHERE ($1::text IS NULL OR estado = $1)
        AND ($2::text IS NULL OR tipo   = $2)
    `, [estado, tipo]);

    // Resumen de conteos por estado (útil para el panel admin)
    const { rows: summary } = await db.query(`
      SELECT estado, COUNT(*)::int AS cantidad
      FROM reports
      GROUP BY estado
    `);

    res.json({
      ok: true,
      data: {
        reports: rows,
        total:   countRows[0].total,
        page,
        pages:   Math.ceil(countRows[0].total / limit),
        summary: Object.fromEntries(summary.map(s => [s.estado, s.cantidad]))
      }
    });
  } catch (err) {
    console.error('GET /reports error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al obtener reportes' } });
  }
});

// ── PATCH /reports/:id/estado ─────────────────────────────────
// Admin actualiza el estado de un reporte
// Body: { estado: string, resolucion?: string }
router.patch('/:id/estado', auth, roles('admin'), async (req, res) => {
  try {
    const { estado, resolucion } = req.body;

    if (!estado || !ESTADOS_VALIDOS.includes(estado)) {
      return res.status(400).json({
        ok: false,
        error: { code: 'INVALID_ESTADO', message: `Estado inválido. Opciones: ${ESTADOS_VALIDOS.join(', ')}` }
      });
    }

    const { rows, rowCount } = await db.query(`
      UPDATE reports
      SET
        estado     = $1,
        resolucion = COALESCE($2, resolucion),
        updated_at = NOW()
      WHERE id = $3
      RETURNING id, tipo, descripcion, estado, resolucion, updated_at
    `, [estado, resolucion?.trim() || null, req.params.id]);

    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Reporte no encontrado' } });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('PATCH /reports/:id/estado error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al actualizar reporte' } });
  }
});

module.exports = router;
