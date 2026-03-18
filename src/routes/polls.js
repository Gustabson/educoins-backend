// src/routes/polls.js — version completa con scope, likes, comentarios
const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');

async function enrichPoll(pollId, userId) {
  const { rows: poll } = await db.query(`
    SELECT p.id, p.titulo, p.activa, p.fin, p.created_at,
           p.scope, p.classroom_id,
           u.nombre AS creador_nombre, u.rol AS creador_rol
    FROM polls p JOIN users u ON u.id = p.created_by
    WHERE p.id = $1
  `, [pollId]);
  if (poll.length === 0) return null;

  const { rows: options } = await db.query(`
    SELECT po.id, po.texto, po.orden, COUNT(pv.id)::int AS votos
    FROM poll_options po LEFT JOIN poll_votes pv ON pv.option_id = po.id
    WHERE po.poll_id = $1 GROUP BY po.id ORDER BY po.orden
  `, [pollId]);

  const { rows: myVote } = await db.query(
    'SELECT option_id FROM poll_votes WHERE poll_id=$1 AND user_id=$2', [pollId, userId]);

  const { rows: reacts } = await db.query(
    'SELECT tipo, COUNT(*)::int AS total FROM poll_reactions WHERE poll_id=$1 GROUP BY tipo', [pollId]);
  const { rows: myReact } = await db.query(
    'SELECT tipo FROM poll_reactions WHERE poll_id=$1 AND user_id=$2', [pollId, userId]);

  const { rows: cCount } = await db.query(
    'SELECT COUNT(*)::int AS total FROM poll_comments WHERE poll_id=$1 AND parent_id IS NULL', [pollId]);

  const reactions = { like: 0, dislike: 0 };
  reacts.forEach(r => { reactions[r.tipo] = r.total; });

  return {
    ...poll[0],
    opciones:          options,
    total_votos:       options.reduce((s, o) => s + o.votos, 0),
    mi_voto:           myVote[0]?.option_id || null,
    reactions,
    mi_reaccion:       myReact[0]?.tipo || null,
    total_comentarios: cCount[0].total,
  };
}

// GET /polls
router.get('/', auth, async (req, res) => {
  try {
    const scope = req.query.scope || null;
    const cid   = req.query.classroom_id || null;
    const { rows } = await db.query(`
      SELECT id FROM polls
      WHERE ($1::text IS NULL OR scope=$1)
        AND ($2::uuid IS NULL OR classroom_id=$2)
      ORDER BY
        CASE WHEN (SELECT rol FROM users WHERE id=created_by)='admin'   THEN 0
             WHEN (SELECT rol FROM users WHERE id=created_by)='teacher' THEN 1
             ELSE 2 END,
        created_at DESC
    `, [scope, cid]);
    const enriched = await Promise.all(rows.map(p => enrichPoll(p.id, req.user.id)));
    res.json({ ok: true, data: enriched.filter(Boolean) });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /polls/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const data = await enrichPoll(req.params.id, req.user.id);
    if (!data) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /polls
router.post('/', auth, roles('admin','teacher'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { titulo, opciones, fin, scope='global', classroom_id=null } = req.body;
    if (!titulo?.trim() || titulo.trim().length < 3)
      return res.status(400).json({ ok: false, error: { code: 'INVALID_TITULO' } });
    if (!Array.isArray(opciones) || opciones.length < 2 || opciones.length > 8)
      return res.status(400).json({ ok: false, error: { code: 'INVALID_OPTIONS' } });

    await client.query('BEGIN');
    const { rows: poll } = await client.query(`
      INSERT INTO polls (titulo, activa, fin, created_by, scope, classroom_id)
      VALUES ($1,TRUE,$2,$3,$4,$5) RETURNING id
    `, [titulo.trim(), fin||null, req.user.id, scope, classroom_id]);

    for (let i = 0; i < opciones.length; i++)
      await client.query('INSERT INTO poll_options (poll_id,texto,orden) VALUES ($1,$2,$3)',
        [poll[0].id, opciones[i].trim(), i]);

    await client.query('COMMIT');
    const data = await enrichPoll(poll[0].id, req.user.id);
    res.status(201).json({ ok: true, data });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// POST /polls/:id/vote
router.post('/:id/vote', auth, async (req, res) => {
  try {
    const { option_id } = req.body;
    if (!option_id) return res.status(400).json({ ok: false, error: { code: 'INVALID_OPTION' } });

    const { rows: poll } = await db.query('SELECT activa, fin FROM polls WHERE id=$1', [req.params.id]);
    if (!poll.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    if (!poll[0].activa) return res.status(400).json({ ok: false, error: { code: 'POLL_CLOSED' } });
    if (poll[0].fin) {
      const finDate = new Date(poll[0].fin);
      finDate.setHours(23,59,59,999);
      if (finDate < new Date()) return res.status(400).json({ ok: false, error: { code: 'POLL_EXPIRED', message: 'Esta votacion ya vencio' } });
    }

    const { rows: opt } = await db.query(
      'SELECT id FROM poll_options WHERE id=$1 AND poll_id=$2', [option_id, req.params.id]);
    if (!opt.length) return res.status(400).json({ ok: false, error: { code: 'INVALID_OPTION' } });

    try {
      await db.query('INSERT INTO poll_votes (poll_id,option_id,user_id) VALUES ($1,$2,$3)',
        [req.params.id, option_id, req.user.id]);
    } catch(e) {
      if (e.code==='23505') return res.status(409).json({ ok: false, error: { code: 'ALREADY_VOTED' } });
      throw e;
    }
    const data = await enrichPoll(req.params.id, req.user.id);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// PATCH /polls/:id
router.patch('/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { activa } = req.body;
    if (typeof activa !== 'boolean') return res.status(400).json({ ok: false, error: { code: 'INVALID_BODY' } });
    await db.query('UPDATE polls SET activa=$1 WHERE id=$2', [activa, req.params.id]);
    const data = await enrichPoll(req.params.id, req.user.id);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /polls/:id/react
router.post('/:id/react', auth, async (req, res) => {
  try {
    const { tipo } = req.body;
    if (!['like','dislike'].includes(tipo))
      return res.status(400).json({ ok: false, error: { code: 'INVALID_TIPO' } });

    const { rows: ex } = await db.query(
      'SELECT id, tipo FROM poll_reactions WHERE poll_id=$1 AND user_id=$2', [req.params.id, req.user.id]);

    if (ex.length && ex[0].tipo===tipo)
      await db.query('DELETE FROM poll_reactions WHERE id=$1', [ex[0].id]);
    else if (ex.length)
      await db.query('UPDATE poll_reactions SET tipo=$1 WHERE id=$2', [tipo, ex[0].id]);
    else
      await db.query('INSERT INTO poll_reactions (poll_id,user_id,tipo) VALUES ($1,$2,$3)',
        [req.params.id, req.user.id, tipo]);

    const data = await enrichPoll(req.params.id, req.user.id);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /polls/:id/comments
router.get('/:id/comments', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT pc.id, pc.texto, pc.created_at, pc.parent_id,
        u.id AS user_id, u.nombre, u.rol, u.skin, u.border,
        (SELECT COUNT(*)::int FROM poll_comment_reactions WHERE comment_id=pc.id AND tipo='like')    AS likes,
        (SELECT COUNT(*)::int FROM poll_comment_reactions WHERE comment_id=pc.id AND tipo='dislike') AS dislikes,
        (SELECT tipo FROM poll_comment_reactions WHERE comment_id=pc.id AND user_id=$2)              AS mi_reaccion,
        (SELECT COUNT(*)::int FROM poll_comments WHERE parent_id=pc.id)                             AS respuestas
      FROM poll_comments pc JOIN users u ON u.id=pc.user_id
      WHERE pc.poll_id=$1 AND pc.parent_id IS NULL
      ORDER BY pc.created_at ASC
    `, [req.params.id, req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /polls/:id/comments/:cid/replies
router.get('/:id/comments/:cid/replies', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT pc.id, pc.texto, pc.created_at, pc.parent_id,
        u.id AS user_id, u.nombre, u.rol, u.skin, u.border,
        (SELECT COUNT(*)::int FROM poll_comment_reactions WHERE comment_id=pc.id AND tipo='like')    AS likes,
        (SELECT COUNT(*)::int FROM poll_comment_reactions WHERE comment_id=pc.id AND tipo='dislike') AS dislikes,
        (SELECT tipo FROM poll_comment_reactions WHERE comment_id=pc.id AND user_id=$2)              AS mi_reaccion
      FROM poll_comments pc JOIN users u ON u.id=pc.user_id
      WHERE pc.parent_id=$1 ORDER BY pc.created_at ASC
    `, [req.params.cid, req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /polls/:id/comments
router.post('/:id/comments', auth, async (req, res) => {
  try {
    const { texto, parent_id=null } = req.body;
    if (!texto?.trim()) return res.status(400).json({ ok: false, error: { code: 'EMPTY' } });
    const { rows } = await db.query(`
      INSERT INTO poll_comments (poll_id,user_id,parent_id,texto) VALUES ($1,$2,$3,$4) RETURNING id,texto,created_at,parent_id
    `, [req.params.id, req.user.id, parent_id, texto.trim()]);
    res.status(201).json({ ok: true, data: { ...rows[0], user_id:req.user.id, nombre:req.user.nombre, rol:req.user.rol, likes:0, dislikes:0, mi_reaccion:null, respuestas:0 } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /polls/:id/comments/:cid/react
router.post('/:id/comments/:cid/react', auth, async (req, res) => {
  try {
    const { tipo } = req.body;
    if (!['like','dislike'].includes(tipo))
      return res.status(400).json({ ok: false, error: { code: 'INVALID_TIPO' } });

    const { rows: ex } = await db.query(
      'SELECT id,tipo FROM poll_comment_reactions WHERE comment_id=$1 AND user_id=$2',
      [req.params.cid, req.user.id]);

    if (ex.length && ex[0].tipo===tipo)
      await db.query('DELETE FROM poll_comment_reactions WHERE id=$1', [ex[0].id]);
    else if (ex.length)
      await db.query('UPDATE poll_comment_reactions SET tipo=$1 WHERE id=$2', [tipo, ex[0].id]);
    else
      await db.query('INSERT INTO poll_comment_reactions (comment_id,user_id,tipo) VALUES ($1,$2,$3)',
        [req.params.cid, req.user.id, tipo]);

    const { rows: counts } = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM poll_comment_reactions WHERE comment_id=$1 AND tipo='like')    AS likes,
        (SELECT COUNT(*)::int FROM poll_comment_reactions WHERE comment_id=$1 AND tipo='dislike') AS dislikes,
        (SELECT tipo FROM poll_comment_reactions WHERE comment_id=$1 AND user_id=$2)              AS mi_reaccion
    `, [req.params.cid, req.user.id]);

    res.json({ ok: true, data: { comment_id: req.params.cid, ...counts[0] } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// DELETE /polls/:id/comments/:cid
router.delete('/:id/comments/:cid', auth, async (req, res) => {
  try {
    const { rows: c } = await db.query('SELECT user_id FROM poll_comments WHERE id=$1', [req.params.cid]);
    if (!c.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    if (c[0].user_id !== req.user.id && req.user.rol !== 'admin')
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } });
    await db.query('DELETE FROM poll_comments WHERE id=$1', [req.params.cid]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// DELETE /polls/:id
router.delete('/:id', auth, roles('admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM polls WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;
