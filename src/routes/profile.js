// src/routes/profile.js
const express = require('express');
const db    = require('../config/db');
const auth  = require('../middleware/auth');
const roles = require('../middleware/roles');
const router = express.Router();

// Equipar skin, border o título (ya desbloqueado)
router.post('/equip', auth, roles('student'), async (req, res) => {
  try {
    const { type, item_id } = req.body;
    const col = { skin: 'skin', border: 'border', title: 'title' }[type];
    if (!col) return res.status(400).json({ ok: false, error: { code: 'INVALID_TYPE', message: 'Tipo inválido' } });

    // Verificar que lo tenga desbloqueado
    const arr = { skin: 'unlocked_skins', border: 'unlocked_borders', title: 'unlocked_titles' }[type];
    const { rows } = await db.query(`SELECT ${arr} FROM users WHERE id=$1`, [req.user.id]);
    if (!rows[0][arr].includes(item_id)) {
      return res.status(422).json({ ok: false, error: { code: 'NOT_UNLOCKED', message: 'Todavía no desbloqueaste este ítem' } });
    }

    await db.query(`UPDATE users SET ${col}=$1 WHERE id=$2`, [item_id, req.user.id]);
    res.json({ ok: true, data: { message: 'Equipado correctamente' } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// Ranking de alumnos por total_earned
router.get('/ranking', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, nombre, apodo, total_earned, skin, border, title
       FROM users WHERE rol='student' AND activo=true
       ORDER BY total_earned DESC LIMIT 20`
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// PATCH /profile/apodo
router.patch('/apodo', auth, async (req, res) => {
  try {
    const { apodo } = req.body;
    // null = borrar apodo, string = setear
    if (apodo !== null && apodo !== undefined) {
      const clean = apodo.trim();
      if (clean.length < 2 || clean.length > 30)
        return res.status(400).json({ ok: false, error: { code: 'INVALID_APODO', message: 'El apodo debe tener entre 2 y 30 caracteres' } });

      // Verificar que haya comprado el "Cambio de Apodo" en la tienda personalización
      const { rows: perm } = await db.query(`
        SELECT 1 FROM user_custom_items uci
        JOIN shop_items_custom s ON s.id = uci.item_id
        WHERE uci.user_id = $1 AND s.tipo = 'nickname'
      `, [req.user.id]);
      if (!perm.length) {
        return res.status(403).json({ ok: false, error: { code: 'NOT_UNLOCKED', message: 'Necesitas comprar el item Cambio de Apodo primero' } });
      }

      await db.query('UPDATE users SET apodo=$1 WHERE id=$2', [clean, req.user.id]);
    } else {
      await db.query('UPDATE users SET apodo=NULL WHERE id=$1', [req.user.id]);
    }
    const { rows } = await db.query('SELECT apodo FROM users WHERE id=$1', [req.user.id]);
    res.json({ ok: true, data: { apodo: rows[0].apodo } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;

// PATCH /profile/foto
router.patch('/foto', auth, async (req, res) => {
  try {
    const { foto_url } = req.body;
    const { rows: perm } = await db.query(`
      SELECT 1 FROM user_custom_items uci
      JOIN shop_items_custom s ON s.id = uci.item_id
      WHERE uci.user_id = $1 AND s.tipo = 'photo_profile'
    `, [req.user.id]);
    if (!perm.length)
      return res.status(403).json({ ok: false, error: { code: 'NOT_UNLOCKED', message: 'Compra el item Foto de Perfil primero' } });
    if (foto_url && foto_url.length > 500000)
      return res.status(400).json({ ok: false, error: { code: 'TOO_LARGE' } });
    await db.query('UPDATE users SET foto_url=$1 WHERE id=$2', [foto_url||null, req.user.id]);
    res.json({ ok: true, data: { foto_url: foto_url||null } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// PATCH /profile/titulo-custom
router.patch('/titulo-custom', auth, async (req, res) => {
  try {
    const { titulo } = req.body;
    const { rows: perm } = await db.query(`
      SELECT 1 FROM user_custom_items uci
      JOIN shop_items_custom s ON s.id = uci.item_id
      WHERE uci.user_id = $1 AND s.tipo = 'title_custom'
    `, [req.user.id]);
    if (!perm.length)
      return res.status(403).json({ ok: false, error: { code: 'NOT_UNLOCKED' } });
    if (titulo && titulo.length > 20)
      return res.status(400).json({ ok: false, error: { code: 'TOO_LONG' } });
    await db.query('UPDATE users SET titulo_custom=$1 WHERE id=$2', [titulo?.trim()||null, req.user.id]);
    res.json({ ok: true, data: { titulo_custom: titulo?.trim()||null } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /profile/user/:id — perfil público
router.get('/user/:id', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.nombre, u.apodo, u.titulo_custom, u.skin, u.border, u.title,
             u.foto_url, u.total_earned, u.rol,
             COALESCE(SUM(le.amount),0)::integer AS balance,
             (SELECT COUNT(*)::int FROM mission_submissions ms
              WHERE ms.student_id=u.id AND ms.estado='aprobada') AS misiones,
             (SELECT COUNT(*)::int FROM daily_checkins dc WHERE dc.user_id=u.id) AS checkins,
             (SELECT COALESCE(MAX(racha),0) FROM daily_checkins dc WHERE dc.user_id=u.id) AS racha
      FROM users u
      LEFT JOIN accounts a ON a.user_id=u.id AND a.account_type IN ('student','teacher')
      LEFT JOIN ledger_entries le ON le.account_id=a.id
      WHERE u.id=$1 AND u.activo=TRUE
      GROUP BY u.id
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('publicProfile error:', err.message);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /profile/block
router.post('/block', auth, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id || user_id === req.user.id)
      return res.status(400).json({ ok: false, error: { code: 'INVALID' } });
    await db.query('INSERT INTO user_blocks (blocker_id,blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [req.user.id, user_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// DELETE /profile/block/:id
router.delete('/block/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM user_blocks WHERE blocker_id=$1 AND blocked_id=$2',
      [req.user.id, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /profile/blocked
router.get('/blocked', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.nombre, u.skin FROM user_blocks ub
      JOIN users u ON u.id=ub.blocked_id WHERE ub.blocker_id=$1
    `, [req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});
