// src/routes/customization.js
// GET  /api/v1/custom/shop          -> listar items de la tienda de personalización
// GET  /api/v1/custom/me            -> mis items comprados + activos
// POST /api/v1/custom/buy           -> comprar item { item_id }
// POST /api/v1/custom/equip         -> equipar item { tipo, item_id } (null para desequipar)
// GET  /api/v1/custom/user/:id      -> perfil de personalización de otro usuario
// POST /api/v1/custom/gift          -> regalar { to_user_id, item_id?, coins?, mensaje? }
// GET  /api/v1/custom/gifts         -> mis regalos recibidos
// PATCH /api/v1/custom/gifts/:id/read -> marcar regalo como leído
// GET  /api/v1/custom/admin/items   -> admin: listar todos
// POST /api/v1/custom/admin/items   -> admin: crear item
// PATCH /api/v1/custom/admin/items/:id -> admin: editar precio/activo

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');
const { getAccountByUserId, assertSufficientBalance } = require('../services/balance');
const audit   = require('../services/audit');

// ── GET /custom/shop ──────────────────────────────────────────
router.get('/shop', auth, async (req, res) => {
  try {
    const tipo = req.query.tipo || null;
    const { rows } = await db.query(`
      SELECT s.id, s.tipo, s.nombre, s.descripcion, s.precio, s.config,
             s.preview, s.orden,
             (SELECT 1 FROM user_custom_items WHERE user_id=$1 AND item_id=s.id) IS NOT NULL AS owned
      FROM shop_items_custom s
      WHERE s.activo = TRUE
        AND ($2::text IS NULL OR s.tipo = $2)
      ORDER BY s.tipo, s.orden, s.precio
    `, [req.user.id, tipo]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /custom/me ────────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const { rows: owned } = await db.query(`
      SELECT s.id, s.tipo, s.nombre, s.config, s.preview, uci.purchased_at
      FROM user_custom_items uci
      JOIN shop_items_custom s ON s.id = uci.item_id
      WHERE uci.user_id = $1
      ORDER BY uci.purchased_at DESC
    `, [req.user.id]);

    // Incluir configs de items activos para que el frontend pueda aplicarlos
    const { rows: active } = await db.query(`
      SELECT uca.*,
        t.config  AS theme_config,
        nc.config AS name_color_config,
        ep.config AS emoji_pack_config,
        sm.config AS screen_mode_config
      FROM user_custom_active uca
      LEFT JOIN shop_items_custom t  ON t.id  = uca.theme_id
      LEFT JOIN shop_items_custom nc ON nc.id = uca.name_color_id
      LEFT JOIN shop_items_custom ep ON ep.id = uca.emoji_pack_id
      LEFT JOIN shop_items_custom sm ON sm.id = uca.screen_mode_id
      WHERE uca.user_id = $1
    `, [req.user.id]);

    res.json({ ok: true, data: { owned, active: active[0] || null } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /custom/user/:id ──────────────────────────────────────
router.get('/user/:id', auth, async (req, res) => {
  try {
    const { rows: active } = await db.query(`
      SELECT
        uca.*,
        t.config  AS theme_config,
        nc.config AS name_color_config,
        ep.config AS emoji_pack_config,
        te.config AS title_effect_config,
        ne.config AS name_effect_config,
        af.config AS avatar_frame_config
      FROM user_custom_active uca
      LEFT JOIN shop_items_custom t  ON t.id  = uca.theme_id
      LEFT JOIN shop_items_custom nc ON nc.id = uca.name_color_id
      LEFT JOIN shop_items_custom ep ON ep.id = uca.emoji_pack_id
      LEFT JOIN shop_items_custom te ON te.id = uca.title_effect_id
      LEFT JOIN shop_items_custom ne ON ne.id = uca.name_effect_id
      LEFT JOIN shop_items_custom af ON af.id = uca.avatar_frame_id
      WHERE uca.user_id = $1
    `, [req.params.id]);
    res.json({ ok: true, data: active[0] || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /custom/buy ──────────────────────────────────────────
router.post('/buy', auth, async (req, res) => {
  const client = await db.getClient();
  try {
    const { item_id } = req.body;
    if (!item_id) return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD' } });

    const { rows: item } = await db.query(
      'SELECT * FROM shop_items_custom WHERE id=$1 AND activo=TRUE', [item_id]
    );
    if (!item.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Item no encontrado' } });

    // Verificar que no lo tiene ya
    const { rows: alreadyOwned } = await db.query(
      'SELECT 1 FROM user_custom_items WHERE user_id=$1 AND item_id=$2', [req.user.id, item_id]
    );
    if (alreadyOwned.length) return res.status(409).json({ ok: false, error: { code: 'ALREADY_OWNED', message: 'Ya tenés este item' } });

    await client.query('BEGIN');

    // Si tiene precio, descontar de la cuenta del usuario
    if (item[0].precio > 0) {
      const accId = await getAccountByUserId(req.user.id, client);
      await assertSufficientBalance(accId, item[0].precio, client);

      // Buscar cuenta de tienda
      const { rows: store } = await client.query(
        "SELECT id FROM accounts WHERE account_type='store' AND is_active=TRUE LIMIT 1"
      );
      if (!store.length) throw new Error('Cuenta de tienda no configurada');

      const txId = require('uuid').v4();
      await client.query(`
        INSERT INTO transactions (id,type,description,initiated_by,metadata)
        VALUES ($1,'purchase',$2,$3,$4)
      `, [txId, `Compra personalización: ${item[0].nombre}`, req.user.id,
          JSON.stringify({ item_id, tipo: item[0].tipo })]);

      await client.query(`INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)`,
        [require('uuid').v4(), txId, accId, -item[0].precio]);
      await client.query(`INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)`,
        [require('uuid').v4(), txId, store[0].id, item[0].precio]);
    }

    await client.query(
      'INSERT INTO user_custom_items (user_id, item_id) VALUES ($1,$2)', [req.user.id, item_id]
    );

    await audit.log({ actorId: req.user.id, action: 'purchase', targetType: 'custom_item',
      targetId: item_id, details: { nombre: item[0].nombre, precio: item[0].precio } }, client);

    await client.query('COMMIT');
    res.status(201).json({ ok: true, data: { item: item[0], mensaje: `Compraste: ${item[0].nombre}` } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /custom/buy error:', err);
    res.status(500).json({ ok: false, error: { code: err.code||'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// ── POST /custom/equip ────────────────────────────────────────
// Body: { tipo: 'theme'|'name_color'|..., item_id: UUID|null }
router.post('/equip', auth, async (req, res) => {
  try {
    const { tipo, item_id } = req.body;
    const VALID_TIPOS = ['theme','name_color','emoji_pack','title_effect','name_effect','avatar_frame','screen_mode'];
    if (!VALID_TIPOS.includes(tipo)) return res.status(400).json({ ok: false, error: { code: 'INVALID_TIPO' } });

    // Si se quiere equipar (no desequipar), verificar que lo tiene
    if (item_id) {
      const { rows } = await db.query(
        'SELECT 1 FROM user_custom_items WHERE user_id=$1 AND item_id=$2', [req.user.id, item_id]
      );
      // Items gratis (precio=0) se pueden equipar sin comprar
      const { rows: item } = await db.query(
        'SELECT precio FROM shop_items_custom WHERE id=$1', [item_id]
      );
      if (!rows.length && item[0]?.precio > 0) {
        return res.status(403).json({ ok: false, error: { code: 'NOT_OWNED', message: 'No tenés este item' } });
      }
    }

    const col = `${tipo}_id`;
    await db.query(`
      INSERT INTO user_custom_active (user_id, ${col}, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) DO UPDATE SET ${col}=$2, updated_at=NOW()
    `, [req.user.id, item_id || null]);

    // Devolver activos completos con configs
    const { rows: active } = await db.query(`
      SELECT uca.*,
        t.config  AS theme_config,  t.nombre  AS theme_nombre,
        nc.config AS name_color_config, nc.nombre AS name_color_nombre,
        ep.config AS emoji_pack_config, ep.nombre AS emoji_pack_nombre,
        te.config AS title_effect_config,
        ne.config AS name_effect_config,
        af.config AS avatar_frame_config,
        sm.config AS screen_mode_config, sm.nombre AS screen_mode_nombre
      FROM user_custom_active uca
      LEFT JOIN shop_items_custom t  ON t.id  = uca.theme_id
      LEFT JOIN shop_items_custom nc ON nc.id = uca.name_color_id
      LEFT JOIN shop_items_custom ep ON ep.id = uca.emoji_pack_id
      LEFT JOIN shop_items_custom te ON te.id = uca.title_effect_id
      LEFT JOIN shop_items_custom ne ON ne.id = uca.name_effect_id
      LEFT JOIN shop_items_custom af ON af.id = uca.avatar_frame_id
      LEFT JOIN shop_items_custom sm ON sm.id = uca.screen_mode_id
      WHERE uca.user_id = $1
    `, [req.user.id]);

    res.json({ ok: true, data: active[0] || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /custom/gift ─────────────────────────────────────────
router.post('/gift', auth, async (req, res) => {
  const client = await db.getClient();
  try {
    const { to_user_id, item_id, coins, mensaje } = req.body;
    if (!to_user_id) return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD' } });
    if (to_user_id === req.user.id) return res.status(400).json({ ok: false, error: { code: 'SELF_GIFT', message: 'No podés regalarte a vos mismo' } });
    if (!item_id && (!coins || coins <= 0)) return res.status(400).json({ ok: false, error: { code: 'EMPTY_GIFT', message: 'El regalo debe tener un item o monedas' } });

    await client.query('BEGIN');

    // Regalo de monedas — transferir directamente
    if (coins && coins > 0) {
      const fromAcc = await getAccountByUserId(req.user.id, client);
      const toAcc   = await getAccountByUserId(to_user_id, client);
      await assertSufficientBalance(fromAcc, coins, client);
      const txId = require('uuid').v4();
      await client.query(`INSERT INTO transactions (id,type,description,initiated_by,metadata) VALUES ($1,'transfer',$2,$3,$4)`,
        [txId, `Regalo de ${req.user.nombre}${mensaje?`: "${mensaje}"`:''}`, req.user.id, JSON.stringify({regalo:true})]);
      await client.query(`INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)`,
        [require('uuid').v4(), txId, fromAcc, -coins]);
      await client.query(`INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)`,
        [require('uuid').v4(), txId, toAcc, coins]);
    }

    // Regalo de item — clonar la propiedad
    if (item_id) {
      // Verificar que el remitente tiene el item
      const { rows: owned } = await client.query(
        'SELECT 1 FROM user_custom_items WHERE user_id=$1 AND item_id=$2', [req.user.id, item_id]
      );
      if (!owned.length) {
        await client.query('ROLLBACK');
        return res.status(403).json({ ok: false, error: { code: 'NOT_OWNED' } });
      }
      // Dar al receptor si no lo tiene
      await client.query(`
        INSERT INTO user_custom_items (user_id, item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING
      `, [to_user_id, item_id]);
    }

    const { rows: gift } = await client.query(`
      INSERT INTO gifts (from_user_id, to_user_id, item_id, coins, mensaje)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [req.user.id, to_user_id, item_id||null, coins||0, mensaje||null]);

    await client.query('COMMIT');

    // Notificar al receptor
    try {
      const { getIO } = require('../socket');
      const io = getIO();
      if (io) io.to(`user:${to_user_id}`).emit('notification', {
        type: 'gift', from: req.user.nombre,
        coins: coins||0, item_id,
        mensaje: mensaje||null,
      });
    } catch(e) {}

    res.status(201).json({ ok: true, data: gift[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: { code: err.code||'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// ── GET /custom/gifts ─────────────────────────────────────────
router.get('/gifts', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT g.*, u.nombre AS from_nombre, u.skin AS from_skin,
             s.nombre AS item_nombre, s.preview AS item_preview, s.tipo AS item_tipo
      FROM gifts g
      JOIN users u ON u.id = g.from_user_id
      LEFT JOIN shop_items_custom s ON s.id = g.item_id
      WHERE g.to_user_id = $1
      ORDER BY g.created_at DESC
      LIMIT 30
    `, [req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── PATCH /custom/gifts/:id/read ─────────────────────────────
router.patch('/gifts/:id/read', auth, async (req, res) => {
  try {
    await db.query('UPDATE gifts SET leido=TRUE WHERE id=$1 AND to_user_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── ADMIN: GET /custom/admin/items ────────────────────────────
router.get('/admin/items', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT s.*, 
        (SELECT COUNT(*)::int FROM user_custom_items WHERE item_id=s.id) AS total_vendidos
      FROM shop_items_custom s ORDER BY s.tipo, s.orden
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── ADMIN: POST /custom/admin/items ──────────────────────────
router.post('/admin/items', auth, roles('admin'), async (req, res) => {
  try {
    const { tipo, nombre, descripcion, precio, config, preview, orden } = req.body;
    const { rows } = await db.query(`
      INSERT INTO shop_items_custom (tipo,nombre,descripcion,precio,config,preview,orden)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [tipo, nombre, descripcion||null, precio||0, config||{}, preview||null, orden||0]);
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── ADMIN: PATCH /custom/admin/items/:id ─────────────────────
router.patch('/admin/items/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { precio, activo, nombre, descripcion, config, preview } = req.body;
    const updates = [];
    const vals = [];
    let i = 1;
    if (precio !== undefined) { updates.push(`precio=$${i++}`); vals.push(precio); }
    if (activo !== undefined) { updates.push(`activo=$${i++}`); vals.push(activo); }
    if (nombre)               { updates.push(`nombre=$${i++}`); vals.push(nombre); }
    if (descripcion !== undefined) { updates.push(`descripcion=$${i++}`); vals.push(descripcion); }
    if (config)               { updates.push(`config=$${i++}`); vals.push(config); }
    if (preview !== undefined){ updates.push(`preview=$${i++}`); vals.push(preview); }
    if (!updates.length) return res.status(400).json({ ok: false, error: { code: 'NOTHING_TO_UPDATE' } });
    vals.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE shop_items_custom SET ${updates.join(',')} WHERE id=$${i} RETURNING *`, vals
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;
