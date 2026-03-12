// src/routes/missions.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db    = require('../config/db');
const auth  = require('../middleware/auth');
const roles = require('../middleware/roles');
const ledger = require('../services/ledger');

const router = express.Router();

// ── GET /api/v1/missions ──────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM missions WHERE activa = true ORDER BY created_at DESC'
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /api/v1/missions ─────────────────────────────────────
router.post('/', auth, roles('teacher', 'admin'), async (req, res) => {
  try {
    const { titulo, descripcion, recompensa, dificultad } = req.body;
    if (!titulo || !recompensa || !dificultad) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'Título, recompensa y dificultad son requeridos' } });
    }
    const { rows } = await db.query(
      `INSERT INTO missions (id, titulo, descripcion, recompensa, dificultad, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [uuidv4(), titulo, descripcion, recompensa, dificultad, req.user.id]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /api/v1/missions/:id/submit ─────────────────────────
router.post('/:id/submit', auth, roles('student'), async (req, res) => {
  try {
    // Verificar que no haya entregado esta misión antes
    const existing = await db.query(
      "SELECT id FROM mission_submissions WHERE mission_id=$1 AND student_id=$2 AND estado != 'rechazada'",
      [req.params.id, req.user.id]
    );
    if (existing.rows.length > 0) {
      return res.status(422).json({ ok: false, error: { code: 'DUPLICATE_SUBMISSION', message: 'Ya entregaste esta misión' } });
    }

    const { rows } = await db.query(
      `INSERT INTO mission_submissions (id, mission_id, student_id, estado)
       VALUES ($1,$2,$3,'pendiente') RETURNING *`,
      [uuidv4(), req.params.id, req.user.id]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /api/v1/missions/submissions ─────────────────────────
router.get('/submissions', auth, roles('teacher', 'admin'), async (req, res) => {
  try {
    const estado = req.query.estado || 'pendiente';
    // Teacher solo ve submissions de sus propias misiones
    const isAdmin = req.user.rol === 'admin';

    const { rows } = await db.query(
      `SELECT ms.*, m.titulo, m.recompensa, u.nombre AS alumno_nombre
       FROM mission_submissions ms
       JOIN missions m ON ms.mission_id = m.id
       JOIN users u ON ms.student_id = u.id
       WHERE ms.estado = $1
         AND ($2 OR m.created_by = $3)
       ORDER BY ms.submitted_at DESC`,
      [estado, isAdmin, req.user.id]
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /api/v1/missions/submissions/:id/approve ────────────
router.post('/submissions/:id/approve', auth, roles('teacher', 'admin'), async (req, res) => {
  try {
    const sub = await db.query(
      `SELECT ms.*, m.recompensa, m.titulo, m.created_by
       FROM mission_submissions ms
       JOIN missions m ON ms.mission_id = m.id
       WHERE ms.id = $1`,
      [req.params.id]
    );

    if (sub.rows.length === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Entrega no encontrada' } });
    }

    const submission = sub.rows[0];

    // Teacher solo puede aprobar sus propias misiones
    if (req.user.rol === 'teacher' && submission.created_by !== req.user.id) {
      return res.status(403).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Solo podés aprobar tus propias misiones' } });
    }

    if (submission.estado !== 'pendiente') {
      return res.status(422).json({ ok: false, error: { code: 'INVALID_STATE', message: 'Esta entrega ya fue procesada' } });
    }

    // Ejecutar transacción de recompensa
    const txId = await ledger.reward({
      teacherId:   req.user.id,
      studentId:   submission.student_id,
      amount:      submission.recompensa,
      description: `Misión completada: ${submission.titulo}`,
      meta:        { referenceId: submission.mission_id, referenceType: 'mission' },
    });

    // Actualizar estado de la submission
    await db.query(
      `UPDATE mission_submissions
       SET estado='aprobada', reviewed_at=NOW(), reviewed_by=$1, transaction_id=$2
       WHERE id=$3`,
      [req.user.id, txId, req.params.id]
    );

    res.json({ ok: true, data: { message: 'Misión aprobada y monedas acreditadas', transaction_id: txId } });
  } catch (err) {
    const status = err.code === 'BUDGET_EXCEEDED' ? 422 : 500;
    res.status(status).json({ ok: false, error: { code: err.code || 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /api/v1/missions/submissions/:id/reject ─────────────
router.post('/submissions/:id/reject', auth, roles('teacher', 'admin'), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'El motivo de rechazo es requerido' } });
    }
    await db.query(
      `UPDATE mission_submissions
       SET estado='rechazada', reviewed_at=NOW(), reviewed_by=$1
       WHERE id=$2`,
      [req.user.id, req.params.id]
    );
    res.json({ ok: true, data: { message: 'Entrega rechazada' } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;
