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
      `SELECT id, nombre, total_earned, skin, border, title
       FROM users WHERE rol='student' AND activo=true
       ORDER BY total_earned DESC LIMIT 20`
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;
