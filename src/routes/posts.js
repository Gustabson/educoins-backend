// src/routes/posts.js
// Módulo de Noticias (Posts)
//
// GET    /api/v1/posts          → lista paginada (todos los usuarios)
// GET    /api/v1/posts/:id      → detalle de una noticia
// POST   /api/v1/posts          → crear noticia (admin / teacher)
// PATCH  /api/v1/posts/:id      → editar noticia (solo el autor o admin)
// DELETE /api/v1/posts/:id      → desactivar noticia (admin)

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');

// ── GET /posts ────────────────────────────────────────────────
// Devuelve noticias activas, más recientes primero.
// Query params: ?page=1&limit=20&tag=Deportes
router.get('/', auth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const tag   = req.query.tag || null;

    const { rows } = await db.query(`
      SELECT
        p.id,
        p.titulo,
        p.cuerpo,
        p.tag,
        p.created_at,
        u.nombre   AS autor_nombre,
        u.rol      AS autor_rol
      FROM posts p
      JOIN users u ON u.id = p.autor_id
      WHERE p.activo = TRUE
        AND ($3::text IS NULL OR p.tag = $3)
      ORDER BY p.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset, tag]);

    const { rows: countRows } = await db.query(
      'SELECT COUNT(*)::int AS total FROM posts WHERE activo = TRUE AND ($1::text IS NULL OR tag = $1)',
      [tag]
    );

    res.json({
      ok: true,
      data: {
        posts: rows,
        total: countRows[0].total,
        page,
        pages: Math.ceil(countRows[0].total / limit)
      }
    });
  } catch (err) {
    console.error('GET /posts error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al obtener noticias' } });
  }
});

// ── GET /posts/:id ────────────────────────────────────────────
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        p.id, p.titulo, p.cuerpo, p.tag, p.created_at, p.updated_at,
        u.nombre AS autor_nombre,
        u.rol    AS autor_rol
      FROM posts p
      JOIN users u ON u.id = p.autor_id
      WHERE p.id = $1 AND p.activo = TRUE
    `, [req.params.id]);

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Noticia no encontrada' } });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('GET /posts/:id error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al obtener noticia' } });
  }
});

// ── POST /posts ───────────────────────────────────────────────
// Solo admin y teacher pueden crear noticias
router.post('/', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { titulo, cuerpo, tag = 'General' } = req.body;

    // Validaciones
    if (!titulo || titulo.trim().length < 3) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_TITULO', message: 'El título debe tener al menos 3 caracteres' } });
    }
    if (!cuerpo || cuerpo.trim().length < 10) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_CUERPO', message: 'El cuerpo debe tener al menos 10 caracteres' } });
    }
    const tagsValidos = ['General', 'Académico', 'Deportes', 'Evento', 'Aviso'];
    if (!tagsValidos.includes(tag)) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_TAG', message: `Tag inválido. Opciones: ${tagsValidos.join(', ')}` } });
    }

    const { rows } = await db.query(`
      INSERT INTO posts (titulo, cuerpo, autor_id, tag)
      VALUES ($1, $2, $3, $4)
      RETURNING id, titulo, cuerpo, tag, created_at
    `, [titulo.trim(), cuerpo.trim(), req.user.id, tag]);

    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('POST /posts error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al crear noticia' } });
  }
});

// ── PATCH /posts/:id ──────────────────────────────────────────
// Solo el autor o un admin pueden editar
router.patch('/:id', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { rows: existing } = await db.query(
      'SELECT id, autor_id FROM posts WHERE id = $1 AND activo = TRUE',
      [req.params.id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Noticia no encontrada' } });
    }
    // Un teacher solo puede editar sus propias noticias; admin puede editar todas
    if (req.user.rol === 'teacher' && existing[0].autor_id !== req.user.id) {
      return res.status(403).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Solo podés editar tus propias noticias' } });
    }

    const { titulo, cuerpo, tag } = req.body;
    const { rows } = await db.query(`
      UPDATE posts
      SET
        titulo     = COALESCE($1, titulo),
        cuerpo     = COALESCE($2, cuerpo),
        tag        = COALESCE($3, tag),
        updated_at = NOW()
      WHERE id = $4
      RETURNING id, titulo, cuerpo, tag, updated_at
    `, [titulo?.trim() || null, cuerpo?.trim() || null, tag || null, req.params.id]);

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('PATCH /posts/:id error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al editar noticia' } });
  }
});

// ── DELETE /posts/:id ─────────────────────────────────────────
// Soft delete — solo admin
router.delete('/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'UPDATE posts SET activo = FALSE, updated_at = NOW() WHERE id = $1 AND activo = TRUE',
      [req.params.id]
    );
    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Noticia no encontrada' } });
    }
    res.json({ ok: true, data: { message: 'Noticia desactivada' } });
  } catch (err) {
    console.error('DELETE /posts/:id error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al eliminar noticia' } });
  }
});

module.exports = router;
