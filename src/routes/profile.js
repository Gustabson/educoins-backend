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

// PATCH /profile/apodo — cobra monedas por cambio (precio configurable en shop_items_custom tipo 'nickname')
router.patch('/apodo', auth, async (req, res) => {
  const { apodo } = req.body;
  const { getTreasuryAccountId, getBalance } = require('../services/balance');
  const { v4: uuidv4 } = require('uuid');
  try {
    if (apodo !== null && apodo !== undefined) {
      const clean = apodo.trim();
      if (clean.length < 2 || clean.length > 30)
        return res.status(400).json({ ok:false, error:{code:'INVALID_APODO',message:'Entre 2 y 30 caracteres'} });

      // Buscar item de nickname y verificar permiso (compra o suscripción activa)
      const { rows: items } = await db.query(
        `SELECT s.id, s.precio, s.precio_mensual, s.es_suscripcion
         FROM shop_items_custom s
         WHERE s.tipo='nickname' AND s.activo=true LIMIT 1`
      );
      if (!items.length)
        return res.status(403).json({ ok:false, error:{code:'NOT_AVAILABLE',message:'Item no disponible'} });

      const item = items[0];

      // Verificar que haya comprado el permiso
      const { rows: perm } = await db.query(
        `SELECT 1 FROM user_custom_items uci WHERE uci.user_id=$1 AND uci.item_id=$2
         UNION
         SELECT 1 FROM subscriptions us WHERE us.user_id=$1 AND us.item_id=$2 AND us.activo=true`,
        [req.user.id, item.id]
      );
      if (!perm.length)
        return res.status(403).json({ ok:false, error:{code:'NOT_UNLOCKED',message:'Comprá el permiso de apodo primero'} });

      // Cobrar precio por cambio (precio = costo de cada cambio, configurable en AdminEconomia)
      const precioCambio = item.precio || 0;
      if (precioCambio > 0) {
        const { rows: accs } = await db.query(
          `SELECT id FROM accounts WHERE user_id=$1 AND account_type='student'`, [req.user.id]);
        if (!accs.length) throw new Error('Cuenta no encontrada');
        const bal = await getBalance(accs[0].id);
        if (bal < precioCambio)
          return res.status(422).json({ ok:false, error:{code:'INSUFFICIENT_BALANCE',message:'Saldo insuficiente'} });

        const client = await db.getClient();
        try {
          await client.query('BEGIN');
          const treasury = await getTreasuryAccountId(client);
          const txId = uuidv4();
          await client.query(
            `INSERT INTO transactions (id,type,description,initiated_by) VALUES ($1,'purchase','Cambio de apodo',$2)`,
            [txId, req.user.id]);
          await client.query(
            `INSERT INTO ledger_entries (transaction_id,account_id,amount) VALUES ($1,$2,$3),($1,$4,$5)`,
            [txId, accs[0].id, -precioCambio, treasury, precioCambio]);
          await client.query('UPDATE users SET apodo=$1 WHERE id=$2', [clean, req.user.id]);
          await client.query('COMMIT');
        } catch(e) { await client.query('ROLLBACK'); throw e; }
        finally { client.release(); }
      } else {
        await db.query('UPDATE users SET apodo=$1 WHERE id=$2', [clean, req.user.id]);
      }
    } else {
      await db.query('UPDATE users SET apodo=NULL WHERE id=$1', [req.user.id]);
    }
    const { rows } = await db.query('SELECT apodo FROM users WHERE id=$1', [req.user.id]);
    res.json({ ok:true, data:{ apodo: rows[0].apodo } });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:err.message} });
  }
});

module.exports = router;

// PATCH /profile/foto
router.patch('/foto', auth, async (req, res) => {
  try {
    const { foto_url } = req.body;
    if (foto_url === null || foto_url === undefined) {
      // Always allow removing photo
      await db.query('UPDATE users SET foto_url=NULL WHERE id=$1', [req.user.id]);
      return res.json({ ok: true, data: { foto_url: null } });
    }
    // Check if user bought photo_profile access within the last hour
    const { rows: perm } = await db.query(`
      SELECT uci.created_at FROM user_custom_items uci
      JOIN shop_items_custom s ON s.id = uci.item_id
      WHERE uci.user_id = $1 AND s.tipo = 'photo_profile'
      ORDER BY uci.purchased_at DESC LIMIT 1
    `, [req.user.id]);
    if (!perm.length)
      return res.status(403).json({ ok: false, error: { code: 'NOT_UNLOCKED', message: 'Comprá el acceso de foto primero' } });
    // Check if within 1 hour
    const purchased = new Date(perm[0].purchased_at);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    if (purchased < hourAgo)
      return res.status(403).json({ ok: false, error: { code: 'ACCESS_EXPIRED', message: 'El acceso de foto expiró, comprá de nuevo' } });
    if (foto_url.length > 500000)
      return res.status(400).json({ ok: false, error: { code: 'TOO_LARGE', message: 'Imagen muy grande (max ~500KB)' } });
    await db.query('UPDATE users SET foto_url=$1 WHERE id=$2', [foto_url, req.user.id]);
    res.json({ ok: true, data: { foto_url: foto_url } });
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
             u.foto_url, u.total_earned, u.rol, u.estado, u.active_titles, u.avatar_bg,
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
  const VALID = ['skin','border','title','avatar_bg'];
  if (!VALID.includes(type)) return res.status(400).json({ ok:false, error:{code:'INVALID_TYPE'} });

  const PRICES = {
    skin:      { s1:0, s2:150, s3:200, s4:250, s5:300, s6:350, s7:400, s8:500 },
    border:    { b1:0, b2:100, b3:150, b4:200, b5:300 },
    title:     { tl1:0, tl2:100, tl3:200, tl4:300, tl5:500 },
    avatar_bg: { ab0:0, ab1:80, ab2:80, ab3:80, ab4:80, ab5:100, ab6:150, ab7:150, ab8:200 },
  };

  const precio = PRICES[type]?.[item_id];
  if (precio === undefined) return res.status(400).json({ ok:false, error:{code:'ITEM_NOT_FOUND'} });

  const { getTreasuryAccountId, getBalance } = require('../services/balance');
  const { v4: uuidv4 } = require('uuid');
  const arrCol = {
    skin:'unlocked_skins', border:'unlocked_borders',
    title:'unlocked_titles', avatar_bg:'unlocked_avatar_bgs'
  }[type];

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT u.${arrCol}, a.id as account_id FROM users u
       JOIN accounts a ON a.user_id=u.id AND a.account_type='student'
       WHERE u.id=$1`, [req.user.id]);
    if (!rows.length) throw new Error('Usuario no encontrado');
    if (rows[0][arrCol].includes(item_id)) {
      await client.query('ROLLBACK');
      return res.status(422).json({ ok:false, error:{code:'ALREADY_OWNED', message:'Ya tenés este ítem'} });
    }

    if (precio > 0) {
      const balance = await getBalance(rows[0].account_id);
      if (balance < precio) {
        await client.query('ROLLBACK');
        return res.status(422).json({ ok:false, error:{code:'INSUFFICIENT_BALANCE', message:'Saldo insuficiente'} });
      }
      const treasuryId = await getTreasuryAccountId(client);
      const txId = uuidv4();
      await client.query(
        `INSERT INTO transactions (id,type,description,initiated_by) VALUES ($1,'purchase',$2,$3)`,
        [txId, `Compra de ${type}: ${item_id}`, req.user.id]);
      await client.query(
        `INSERT INTO ledger_entries (transaction_id,account_id,amount) VALUES ($1,$2,$3),($1,$4,$5)`,
        [txId, rows[0].account_id, -precio, treasuryId, precio]);
    }

    await client.query(
      `UPDATE users SET ${arrCol} = array_append(${arrCol}, $1) WHERE id=$2`,
      [item_id, req.user.id]);

    await client.query('COMMIT');
    const { rows: updated } = await db.query(
      `SELECT unlocked_skins, unlocked_borders, unlocked_titles, skin, border, title FROM users WHERE id=$1`,
      [req.user.id]);
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
  const { titulo, precio } = req.body;
  if (!titulo?.trim()) return res.status(400).json({ ok:false, error:{code:'INVALID_TITULO'} });
  if (titulo.trim().length > 30) return res.status(400).json({ ok:false, error:{code:'TOO_LONG'} });

  const { getTreasuryAccountId, getBalance } = require('../services/balance');
  const { v4: uuidv4 } = require('uuid');
  const precioFinal = precio || 0;

  try {
    if (precioFinal > 0) {
      const { rows } = await db.query(
        `SELECT a.id as account_id FROM accounts a WHERE a.user_id=$1 AND a.account_type='student'`,
        [req.user.id]);
      if (!rows.length) return res.status(404).json({ ok:false, error:{code:'ACCOUNT_NOT_FOUND'} });

      const balance = await getBalance(rows[0].account_id);
      if (balance < precioFinal) return res.status(422).json({ ok:false, error:{code:'INSUFFICIENT_BALANCE', message:'Saldo insuficiente'} });

      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        const treasuryId = await getTreasuryAccountId(client);
        const txId = uuidv4();
        await client.query(
          `INSERT INTO transactions (id,type,description,initiated_by) VALUES ($1,'purchase','Cambio de título personalizado',$2)`,
          [txId, req.user.id]);
        await client.query(
          `INSERT INTO ledger_entries (transaction_id,account_id,amount) VALUES ($1,$2,$3),($1,$4,$5)`,
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

// ── PATCH /profile/active-titles ─────────────────────────────
// Actualiza los títulos activos del alumno (máximo 3)
// Body: { titles: ["tl2", "custom:Ninja 🥷", ...] }
router.patch('/active-titles', auth, roles('student'), async (req, res) => {
  try {
    const { titles } = req.body;
    if (!Array.isArray(titles)) return res.status(400).json({ ok:false, error:{code:'INVALID'} });
    if (titles.length > 3) return res.status(400).json({ ok:false, error:{code:'TOO_MANY', message:'Máximo 3 títulos'} });

    // Validate: each title is either a known system id or "custom:text"
    const VALID_IDS = ['tl1','tl2','tl3','tl4','tl5'];
    for(const t of titles){
      if(!t) continue;
      if(t.startsWith('custom:')){
        const text = t.slice(7);
        if(text.length > 30) return res.status(400).json({ ok:false, error:{code:'TITLE_TOO_LONG'} });
      } else if(!VALID_IDS.includes(t)){
        return res.status(400).json({ ok:false, error:{code:'INVALID_TITLE_ID', message: `ID inválido: ${t}`} });
      }
    }

    // If any custom titles, verify user has bought title_custom permission
    const hasCustom = titles.some(t=>t.startsWith('custom:'));
    if(hasCustom){
      const { rows: perm } = await db.query(
        `SELECT uci.id FROM user_custom_items uci
         JOIN shop_items_custom s ON s.id=uci.item_id
         WHERE uci.user_id=$1 AND s.tipo='title_custom'`,
        [req.user.id]
      );
      // Also check if they have an active subscription for title_custom
      const { rows: sub } = await db.query(
        `SELECT us.id FROM subscriptions us
         JOIN shop_items_custom s ON s.id=us.item_id
         WHERE us.user_id=$1 AND s.tipo='title_custom' AND us.activo=true`,
        [req.user.id]
      );
      if(!perm.length && !sub.length){
        return res.status(403).json({ ok:false, error:{code:'NOT_OWNED', message:'Comprá el permiso de título personalizado primero'} });
      }
    }

    await db.query(
      'UPDATE users SET active_titles=$1 WHERE id=$2',
      [JSON.stringify(titles), req.user.id]
    );

    res.json({ ok:true, data:{ active_titles: titles } });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR', message:err.message} });
  }
});

// ── GET /profile/earned-titles ────────────────────────────────
router.get('/earned-titles', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM earned_titles WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ ok:true, data: rows });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR', message:err.message} });
  }
});

// ── GET /profile/earned-titles/:userId (para ver el de otro) ──
router.get('/earned-titles/:userId', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM earned_titles WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.params.userId]
    );
    res.json({ ok:true, data: rows });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR', message:err.message} });
  }
});

// ── POST /profile/earned-titles (admin otorga) ────────────────
router.post('/earned-titles', auth, roles('admin','teacher'), async (req, res) => {
  try {
    const { user_id, name, rarity, color, glow_color, emoji, note } = req.body;
    if (!user_id||!name) return res.status(400).json({ ok:false, error:{code:'MISSING_FIELDS'} });
    const VALID_RARITIES = ['common','rare','epic','legendary'];
    if (rarity && !VALID_RARITIES.includes(rarity))
      return res.status(400).json({ ok:false, error:{code:'INVALID_RARITY'} });

    const { rows } = await db.query(
      `INSERT INTO earned_titles (user_id,name,rarity,color,glow_color,emoji,note,granted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [user_id, name.trim(), rarity||'common', color||'#ffffff',
       glow_color||null, emoji||null, note||null, req.user.id]
    );
    res.status(201).json({ ok:true, data: rows[0] });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR', message:err.message} });
  }
});

// ── DELETE /profile/earned-titles/:id (admin revoca) ─────────
router.delete('/earned-titles/:id', auth, roles('admin'), async (req, res) => {
  try {
    await db.query(`DELETE FROM earned_titles WHERE id=$1`, [req.params.id]);
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR', message:err.message} });
  }
});

// ── PATCH /profile/avatar-bg ──────────────────────────────────
router.patch('/avatar-bg', auth, async (req, res) => {
  try {
    const { avatar_bg } = req.body;
    await db.query('UPDATE users SET avatar_bg=$1 WHERE id=$2',
      [avatar_bg ? JSON.stringify(avatar_bg) : null, req.user.id]);
    res.json({ ok:true, data:{ avatar_bg } });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR', message:err.message} });
  }
});

// ── GET /profile/loaned-items ─────────────────────────────────
router.get('/loaned-items', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM loaned_items
       WHERE user_id=$1 AND active=true
       AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ ok:true, data: rows });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:err.message} });
  }
});

// ── POST /profile/loaned-items (admin presta) ─────────────────
router.post('/loaned-items', auth, roles('admin','teacher'), async (req, res) => {
  try {
    const { user_id, type, item_data, note, expires_days } = req.body;
    if (!user_id||!type||!item_data)
      return res.status(400).json({ ok:false, error:{code:'MISSING_FIELDS'} });
    const expires_at = expires_days
      ? new Date(Date.now() + expires_days * 86400000).toISOString()
      : null;
    const { rows } = await db.query(
      `INSERT INTO loaned_items (user_id,type,item_data,note,expires_at,granted_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [user_id, type, JSON.stringify(item_data), note||null, expires_at, req.user.id]
    );
    res.status(201).json({ ok:true, data: rows[0] });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:err.message} });
  }
});

// ── DELETE /profile/loaned-items/:id (admin revoca) ───────────
router.delete('/loaned-items/:id', auth, roles('admin'), async (req, res) => {
  try {
    await db.query(`UPDATE loaned_items SET active=false WHERE id=$1`, [req.params.id]);
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:err.message} });
  }
});
