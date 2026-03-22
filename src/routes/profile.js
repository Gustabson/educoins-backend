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

// ── POST /profile/buy-item ────────────────────────────────────
// Comprar una skin, border o título de la tienda del perfil
// Body: { type: 'skin'|'border'|'title', item_id: string }
router.post('/buy-item', auth, roles('student'), async (req, res) => {
  const { type, item_id } = req.body;
  const VALID = ['skin','border','title'];
  if (!VALID.includes(type)) return res.status(400).json({ ok:false, error:{code:'INVALID_TYPE'} });

  // Precios hardcodeados — deben coincidir con SKINS/TITLES/BORDERS en constants.js
  const PRICES = {
    skin:   { s1:0, s2:150, s3:200, s4:250, s5:300, s6:350, s7:400, s8:500 },
    border: { b1:0, b2:100, b3:150, b4:200, b5:300 },
    title:  { tl1:0, tl2:100, tl3:200, tl4:300, tl5:500 },
  };

  const precio = PRICES[type]?.[item_id];
  if (precio === undefined) return res.status(400).json({ ok:false, error:{code:'ITEM_NOT_FOUND'} });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar que no lo tenga ya
    const arrCol = { skin:'unlocked_skins', border:'unlocked_borders', title:'unlocked_titles' }[type];
    const { rows } = await client.query(`SELECT ${arrCol}, account_id FROM users u JOIN accounts a ON a.user_id=u.id AND a.account_type='student' WHERE u.id=$1`, [req.user.id]);
    if (!rows.length) throw new Error('Usuario no encontrado');
    if (rows[0][arrCol].includes(item_id)) {
      await client.query('ROLLBACK');
      return res.status(422).json({ ok:false, error:{code:'ALREADY_OWNED', message:'Ya tenés este ítem'} });
    }

    // Cobrar si tiene precio
    if (precio > 0) {
      const { ledger } = require('../services/ledger');
      const { getBalance, getTreasuryAccountId } = require('../services/balance');
      const balance = await getBalance(rows[0].account_id);
      if (balance < precio) {
        await client.query('ROLLBACK');
        return res.status(422).json({ ok:false, error:{code:'INSUFFICIENT_BALANCE', message:'Saldo insuficiente'} });
      }
      const treasuryId = await getTreasuryAccountId(client);
      // Doble entrada: -precio del alumno, +precio a tesorería
      const txId = require('uuid').v4();
      await client.query(`INSERT INTO transactions (id,type,description,initiated_by) VALUES ($1,'purchase','Compra de ${type}: ${item_id}',$2)`, [txId, req.user.id]);
      await client.query(`INSERT INTO ledger_entries (transaction_id,account_id,amount) VALUES ($1,$2,$3),($1,$4,$5)`,
        [txId, rows[0].account_id, -precio, treasuryId, precio]);
    }

    // Agregar al array de desbloqueados
    await client.query(`UPDATE users SET ${arrCol} = array_append(${arrCol}, $1) WHERE id=$2`, [item_id, req.user.id]);

    await client.query('COMMIT');
    const { rows: updated } = await db.query(`SELECT unlocked_skins, unlocked_borders, unlocked_titles, skin, border, title FROM users WHERE id=$1`, [req.user.id]);
    res.json({ ok:true, data: updated[0] });
  } catch(err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR', message:err.message} });
  } finally { client.release(); }
});

// ── POST /profile/buy-titulo-change ──────────────────────────
// Cobra cada vez que el alumno cambia el título personalizado
// Body: { titulo: string }
router.post('/buy-titulo-change', auth, roles('student'), async (req, res) => {
  try {
    const { titulo, precio } = req.body;
    if (!titulo?.trim()) return res.status(400).json({ ok:false, error:{code:'INVALID_TITULO'} });
    if (titulo.trim().length > 20) return res.status(400).json({ ok:false, error:{code:'TOO_LONG'} });

    const precioFinal = precio || 0;

    if (precioFinal > 0) {
      const { rows } = await db.query(`SELECT a.id as account_id FROM accounts a WHERE a.user_id=$1 AND a.account_type='student'`, [req.user.id]);
      if (!rows.length) return res.status(404).json({ ok:false, error:{code:'ACCOUNT_NOT_FOUND'} });
      const { getBalance } = require('../services/balance');
      const balance = await getBalance(rows[0].account_id);
      if (balance < precioFinal) return res.status(422).json({ ok:false, error:{code:'INSUFFICIENT_BALANCE', message:'Saldo insuficiente'} });

      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        const { getTreasuryAccountId } = require('../services/balance');
        const treasuryId = await getTreasuryAccountId(client);
        const txId = require('uuid').v4();
        await client.query(`INSERT INTO transactions (id,type,description,initiated_by) VALUES ($1,'purchase','Cambio de título personalizado',$2)`, [txId, req.user.id]);
        await client.query(`INSERT INTO ledger_entries (transaction_id,account_id,amount) VALUES ($1,$2,$3),($1,$4,$5)`,
          [txId, rows[0].account_id, -precioFinal, treasuryId, precioFinal]);
        await client.query('UPDATE users SET titulo_custom=$1 WHERE id=$2', [titulo.trim(), req.user.id]);
        await client.query('COMMIT');
      } catch(e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    } else {
      await db.query('UPDATE users SET titulo_custom=$1 WHERE id=$2', [titulo.trim(), req.user.id]);
    }

    res.json({ ok:true, data:{ titulo_custom: titulo.trim() } });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR', message:err.message} });
  }
});

// ── PATCH /profile/estado ─────────────────────────────────────
router.patch('/estado', auth, async (req, res) => {
  try {
    const { estado } = req.body;
    const val = estado?.trim().slice(0,40)||null;
    await db.query('UPDATE users SET estado=$1 WHERE id=$2', [val, req.user.id]);
    res.json({ ok:true, data:{ estado: val } });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR', message:err.message} });
  }
});
