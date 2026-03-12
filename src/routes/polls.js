// src/routes/polls.js
// Módulo de Votaciones
//
// GET    /api/v1/polls           → lista de encuestas con conteo de votos
// GET    /api/v1/polls/:id       → detalle con opciones y votos
// POST   /api/v1/polls           → crear encuesta (admin / teacher)
// POST   /api/v1/polls/:id/vote  → votar en una encuesta (student / teacher)
// PATCH  /api/v1/polls/:id       → cerrar / reabrir encuesta (admin)
// DELETE /api/v1/polls/:id       → eliminar encuesta (admin)

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');

// ── Función auxiliar: enriquecer una poll con votos y mi_voto ──
async function enrichPoll(pollId, userId) {
  const { rows: poll } = await db.query(`
    SELECT p.id, p.titulo, p.activa, p.fin, p.created_at,
           u.nombre AS creador_nombre
    FROM polls p
    JOIN users u ON u.id = p.created_by
    WHERE p.id = $1
  `, [pollId]);

  if (poll.length === 0) return null;

  // Opciones con conteo de votos cada una
  const { rows: options } = await db.query(`
    SELECT
      po.id,
      po.texto,
      po.orden,
      COUNT(pv.id)::int AS votos
    FROM poll_options po
    LEFT JOIN poll_votes pv ON pv.option_id = po.id
    WHERE po.poll_id = $1
    GROUP BY po.id, po.texto, po.orden
    ORDER BY po.orden
  `, [pollId]);

  // ¿Ya votó este usuario?
  const { rows: myVote } = await db.query(`
    SELECT option_id FROM poll_votes WHERE poll_id = $1 AND user_id = $2
  `, [pollId, userId]);

  const totalVotos = options.reduce((sum, o) => sum + o.votos, 0);

  return {
    ...poll[0],
    opciones: options,
    total_votos: totalVotos,
    mi_voto: myVote[0]?.option_id || null
  };
}

// ── GET /polls ────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { rows: polls } = await db.query(`
      SELECT id FROM polls ORDER BY created_at DESC
    `);

    const enriched = await Promise.all(
      polls.map(p => enrichPoll(p.id, req.user.id))
    );

    res.json({ ok: true, data: enriched.filter(Boolean) });
  } catch (err) {
    console.error('GET /polls error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al obtener votaciones' } });
  }
});

// ── GET /polls/:id ────────────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const data = await enrichPoll(req.params.id, req.user.id);
    if (!data) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Votación no encontrada' } });
    }
    res.json({ ok: true, data });
  } catch (err) {
    console.error('GET /polls/:id error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al obtener votación' } });
  }
});

// ── POST /polls ───────────────────────────────────────────────
// Admin o teacher crean una encuesta
// Body: { titulo: string, opciones: string[], fin?: "YYYY-MM-DD" }
router.post('/', auth, roles('admin', 'teacher'), async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { titulo, opciones, fin } = req.body;

    if (!titulo || titulo.trim().length < 5) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_TITULO', message: 'El título debe tener al menos 5 caracteres' } });
    }
    if (!Array.isArray(opciones) || opciones.length < 2) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_OPTIONS', message: 'Debe haber al menos 2 opciones' } });
    }
    if (opciones.length > 8) {
      return res.status(400).json({ ok: false, error: { code: 'TOO_MANY_OPTIONS', message: 'Máximo 8 opciones' } });
    }
    if (opciones.some(o => !o || o.trim().length === 0)) {
      return res.status(400).json({ ok: false, error: { code: 'EMPTY_OPTION', message: 'Ninguna opción puede estar vacía' } });
    }

    await client.query('BEGIN');

    const { rows: poll } = await client.query(`
      INSERT INTO polls (titulo, activa, fin, created_by)
      VALUES ($1, TRUE, $2, $3)
      RETURNING id, titulo, activa, fin, created_at
    `, [titulo.trim(), fin || null, req.user.id]);

    const pollId = poll[0].id;

    // Insertar opciones en orden
    for (let i = 0; i < opciones.length; i++) {
      await client.query(
        'INSERT INTO poll_options (poll_id, texto, orden) VALUES ($1, $2, $3)',
        [pollId, opciones[i].trim(), i]
      );
    }

    await client.query('COMMIT');

    const data = await enrichPoll(pollId, req.user.id);
    res.status(201).json({ ok: true, data });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /polls error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al crear votación' } });
  } finally {
    client.release();
  }
});

// ── POST /polls/:id/vote ──────────────────────────────────────
// Registrar un voto. Un usuario solo puede votar una vez por encuesta.
// Body: { option_id: UUID }
router.post('/:id/vote', auth, async (req, res) => {
  try {
    const { option_id } = req.body;

    if (!option_id) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_OPTION', message: 'Debe enviar option_id' } });
    }

    // Verificar que la encuesta exista y esté activa
    const { rows: poll } = await db.query(
      'SELECT id, activa, fin FROM polls WHERE id = $1',
      [req.params.id]
    );
    if (poll.length === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Votación no encontrada' } });
    }
    if (!poll[0].activa) {
      return res.status(400).json({ ok: false, error: { code: 'POLL_CLOSED', message: 'Esta votación ya está cerrada' } });
    }
    if (poll[0].fin && new Date(poll[0].fin) < new Date()) {
      return res.status(400).json({ ok: false, error: { code: 'POLL_EXPIRED', message: 'Esta votación ya venció' } });
    }

    // Verificar que la opción pertenezca a esta encuesta
    const { rows: opt } = await db.query(
      'SELECT id FROM poll_options WHERE id = $1 AND poll_id = $2',
      [option_id, req.params.id]
    );
    if (opt.length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_OPTION', message: 'Opción no válida para esta votación' } });
    }

    // Insertar voto — la constraint UNIQUE(poll_id, user_id) previene duplicados
    try {
      await db.query(
        'INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES ($1, $2, $3)',
        [req.params.id, option_id, req.user.id]
      );
    } catch (e) {
      if (e.code === '23505') { // unique_violation
        return res.status(409).json({ ok: false, error: { code: 'ALREADY_VOTED', message: 'Ya votaste en esta encuesta' } });
      }
      throw e;
    }

    const data = await enrichPoll(req.params.id, req.user.id);
    res.json({ ok: true, data });
  } catch (err) {
    console.error('POST /polls/:id/vote error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al registrar voto' } });
  }
});

// ── PATCH /polls/:id ──────────────────────────────────────────
// Cerrar o reabrir una encuesta (admin)
// Body: { activa: boolean }
router.patch('/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { activa } = req.body;
    if (typeof activa !== 'boolean') {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_BODY', message: 'Enviar { activa: true/false }' } });
    }

    const { rowCount } = await db.query(
      'UPDATE polls SET activa = $1 WHERE id = $2',
      [activa, req.params.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Votación no encontrada' } });
    }

    const data = await enrichPoll(req.params.id, req.user.id);
    res.json({ ok: true, data });
  } catch (err) {
    console.error('PATCH /polls/:id error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al actualizar votación' } });
  }
});

// ── DELETE /polls/:id ─────────────────────────────────────────
router.delete('/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { rowCount } = await db.query('DELETE FROM polls WHERE id = $1', [req.params.id]);
    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Votación no encontrada' } });
    }
    res.json({ ok: true, data: { message: 'Votación eliminada' } });
  } catch (err) {
    console.error('DELETE /polls/:id error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al eliminar votación' } });
  }
});

module.exports = router;
