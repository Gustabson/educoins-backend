// src/routes/reports.js
//
// POST   /api/v1/reports                → crear reporte (cualquier autenticado)
// GET    /api/v1/reports/mine           → mis reportes (alumno)
// GET    /api/v1/reports                → todos (admin) / compartidos (staff)
// PATCH  /api/v1/reports/:id/estado     → cambiar estado (admin)
// PATCH  /api/v1/reports/:id/compartir  → compartir con dominios (admin)
// GET    /api/v1/reports/:id/messages   → historial de mensajes
// POST   /api/v1/reports/:id/messages   → enviar mensaje

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');

// Todos los tipos válidos (sincronizado con constants.js del frontend)
const TIPOS_VALIDOS = [
  // Situaciones
  'bullying', 'acoso', 'maltrato_docente', 'violencia', 'discriminacion',
  // Escuela
  'infraestructura', 'accidente', 'perdido',
  // Mejora
  'mejora_educativa', 'mejora_convivencia', 'sugerencia',
  // Economía
  'error_cobro', 'beca_ayuda', 'cuota_problema',
  // Otro
  'otro',
];

const ESTADOS_VALIDOS = ['recibido', 'en_revision', 'resuelto', 'descartado'];

// Migración: añadir columnas nuevas si no existen
db.query(`
  ALTER TABLE reports ADD COLUMN IF NOT EXISTS grupo           TEXT;
  ALTER TABLE reports ADD COLUMN IF NOT EXISTS adjuntos        JSONB DEFAULT '[]'::jsonb;
  ALTER TABLE reports ADD COLUMN IF NOT EXISTS compartido_con  TEXT[] DEFAULT ARRAY[]::text[];
`).catch(e => console.warn('[reports migration]', e.message));

// Helper: verifica si un usuario (staff/teacher) tiene acceso a un reporte
function staffHasAccess(user, reportRow) {
  if (user.rol === 'admin') return true;
  const userPerms = user.permisos || [];
  if (userPerms.includes('*')) return true;
  const shared = reportRow.compartido_con || [];
  return shared.some(d => userPerms.includes(d)) ||
         (user.rol === 'teacher' && shared.includes('psicologia'));
}

// ── POST /reports ─────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    const { tipo, descripcion, anonimo = false, adjuntos = [] } = req.body;

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

    // Validar adjuntos (máx 3, solo metadata — no guardar archivos enormes)
    const adjuntosLimpios = Array.isArray(adjuntos)
      ? adjuntos.slice(0, 3).map(a => ({ nombre: a.nombre || 'archivo', tipo: a.tipo || 'application/octet-stream', data: a.data || '' }))
      : [];

    const reporterId = anonimo ? null : req.user.id;

    const { rows } = await db.query(`
      INSERT INTO reports (tipo, descripcion, reporter_id, estado, adjuntos)
      VALUES ($1, $2, $3, 'recibido', $4::jsonb)
      RETURNING id, tipo, descripcion, estado, adjuntos, created_at,
                (reporter_id IS NULL) AS anonimo
    `, [tipo, descripcion.trim(), reporterId, JSON.stringify(adjuntosLimpios)]);

    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('POST /reports error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al crear reporte' } });
  }
});

// ── GET /reports/mine ─────────────────────────────────────────
router.get('/mine', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        id, tipo, descripcion, estado, resolucion, created_at, adjuntos,
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
// Admin: ve todos. Staff/teacher: solo los compartidos con su dominio.
router.get('/', auth, async (req, res) => {
  const u = req.user;
  const isAdmin = u.rol === 'admin';
  const isStaff = u.rol === 'teacher' || u.rol === 'staff';
  if (!isAdmin && !isStaff) {
    return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Sin acceso' } });
  }

  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const estado = req.query.estado || null;
    const tipo   = req.query.tipo   || null;
    const grupo  = req.query.grupo  || null;

    // Construir filtro de acceso para staff
    const userPerms = u.permisos || [];
    const isSuperAdmin = isAdmin || userPerms.includes('*');
    // si es teacher backward-compat, tiene acceso psicologia
    const effectivePerms = (u.rol === 'teacher' && !userPerms.includes('psicologia'))
      ? [...userPerms, 'psicologia']
      : userPerms;

    const staffFilter = (!isSuperAdmin && isStaff)
      ? `AND r.compartido_con && $7::text[]`
      : '';

    const { rows } = await db.query(`
      SELECT
        r.id,
        r.tipo,
        r.descripcion,
        r.estado,
        r.resolucion,
        r.adjuntos,
        r.compartido_con,
        r.created_at,
        r.updated_at,
        CASE WHEN r.reporter_id IS NULL THEN 'Anónimo'
             ELSE u.nombre END AS reporter_nombre,
        (r.reporter_id IS NULL) AS anonimo
      FROM reports r
      LEFT JOIN users u ON u.id = r.reporter_id
      WHERE ($1::text IS NULL OR r.estado = $1)
        AND ($2::text IS NULL OR r.tipo   = $2)
        AND ($3::text IS NULL OR r.grupo  = $3)
        ${staffFilter}
      ORDER BY r.created_at DESC
      LIMIT $4 OFFSET $5
    `, isSuperAdmin
      ? [estado, tipo, grupo, limit, offset]
      : [estado, tipo, grupo, limit, offset, null, effectivePerms]
    );

    const { rows: countRows } = await db.query(`
      SELECT COUNT(*)::int AS total FROM reports r
      WHERE ($1::text IS NULL OR r.estado = $1)
        AND ($2::text IS NULL OR r.tipo   = $2)
        AND ($3::text IS NULL OR r.grupo  = $3)
        ${staffFilter}
    `, isSuperAdmin
      ? [estado, tipo, grupo]
      : [estado, tipo, grupo, null, null, null, effectivePerms]
    );

    const { rows: summary } = await db.query(`
      SELECT estado, COUNT(*)::int AS cantidad FROM reports r
      ${!isSuperAdmin && isStaff ? `WHERE r.compartido_con && $1::text[]` : ''}
      GROUP BY estado
    `, !isSuperAdmin && isStaff ? [effectivePerms] : []);

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
router.patch('/:id/estado', auth, roles('admin'), async (req, res) => {
  try {
    const { estado, resolucion, recompensa_coins } = req.body;

    if (!estado || !ESTADOS_VALIDOS.includes(estado)) {
      return res.status(400).json({
        ok: false,
        error: { code: 'INVALID_ESTADO', message: `Estado inválido. Opciones: ${ESTADOS_VALIDOS.join(', ')}` }
      });
    }

    const { rows, rowCount } = await db.query(`
      UPDATE reports
      SET
        estado          = $1,
        resolucion      = COALESCE($2, resolucion),
        updated_at      = NOW()
      WHERE id = $3
      RETURNING id, tipo, descripcion, estado, resolucion, compartido_con, updated_at
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

// ── PATCH /reports/:id/compartir ─────────────────────────────
// Superadmin decide con qué dominios compartir el reporte
router.patch('/:id/compartir', auth, roles('admin'), async (req, res) => {
  try {
    const { compartido_con = [] } = req.body;
    const dominiosValidos = ['psicologia', 'economia', 'administracion'];
    const filtrado = compartido_con.filter(d => dominiosValidos.includes(d));

    const { rows, rowCount } = await db.query(`
      UPDATE reports
      SET compartido_con = $1::text[], updated_at = NOW()
      WHERE id = $2
      RETURNING id, compartido_con, updated_at
    `, [filtrado, req.params.id]);

    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Reporte no encontrado' } });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('PATCH /reports/:id/compartir error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /reports/:id/messages ─────────────────────────────────
router.get('/:id/messages', auth, async (req, res) => {
  try {
    const { rows: rep } = await db.query(
      'SELECT id, reporter_id, compartido_con FROM reports WHERE id = $1', [req.params.id]
    );
    if (rep.length === 0)
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Reporte no encontrado' } });

    if (!staffHasAccess(req.user, rep[0]) && rep[0].reporter_id !== req.user.id)
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Sin acceso' } });

    const { rows } = await db.query(`
      SELECT rm.id, rm.texto, rm.created_at,
             u.id AS sender_id, u.nombre AS sender_nombre, u.rol AS sender_rol
      FROM report_messages rm
      JOIN users u ON u.id = rm.sender_id
      WHERE rm.report_id = $1
      ORDER BY rm.created_at ASC
    `, [req.params.id]);

    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('GET /reports/:id/messages error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /reports/:id/messages ────────────────────────────────
router.post('/:id/messages', auth, async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto?.trim())
      return res.status(400).json({ ok: false, error: { code: 'EMPTY', message: 'El mensaje no puede estar vacío' } });

    const { rows: rep } = await db.query(
      'SELECT id, reporter_id, estado, compartido_con FROM reports WHERE id = $1', [req.params.id]
    );
    if (rep.length === 0)
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Reporte no encontrado' } });

    const isReporter = rep[0].reporter_id === req.user.id;
    if (!staffHasAccess(req.user, rep[0]) && !isReporter)
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Sin acceso' } });

    const { rows } = await db.query(`
      INSERT INTO report_messages (report_id, sender_id, texto)
      VALUES ($1, $2, $3)
      RETURNING id, texto, created_at
    `, [req.params.id, req.user.id, texto.trim()]);

    // Si admin/staff responde, pasar a en_revision automáticamente
    const isStaff = req.user.rol === 'admin' || req.user.rol === 'teacher' || req.user.rol === 'staff';
    if (isStaff && rep[0].estado === 'recibido') {
      await db.query(
        "UPDATE reports SET estado = 'en_revision', updated_at = NOW() WHERE id = $1",
        [req.params.id]
      );
    }

    res.status(201).json({ ok: true, data: {
      ...rows[0],
      sender_id:     req.user.id,
      sender_nombre: req.user.nombre,
      sender_rol:    req.user.rol
    }});
  } catch (err) {
    console.error('POST /reports/:id/messages error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;
