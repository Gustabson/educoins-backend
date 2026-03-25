// src/routes/prizes.js — Sistema de premios por ranking
const router  = require('express').Router();
const db      = require('../config/db');
const auth  = require('../middleware/auth');
const roles = require('../middleware/roles');

// ── GET /prizes/sets — listar todos los prize sets con sus ítems ──
router.get('/sets', auth, roles('admin'), async (req, res) => {
  try {
    const { rows: sets } = await db.query(
      `SELECT ps.*, 
        COALESCE(json_agg(pi ORDER BY pi.created_at) FILTER (WHERE pi.id IS NOT NULL), '[]') AS items
       FROM ranking_prize_sets ps
       LEFT JOIN ranking_prize_items pi ON pi.prize_set_id = ps.id
       GROUP BY ps.id
       ORDER BY ps.periodo, ps.puesto`
    );
    res.json({ ok: true, data: sets });
  } catch(err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /prizes/sets/:id/items — agregar ítem a un prize set ──
router.post('/sets/:id/items', auth, roles('admin'), async (req, res) => {
  try {
    const { tipo, valor } = req.body;
    const VALID = ['monedas','titulo','borde','skin','marco','name_color','custom_unlock'];
    if (!VALID.includes(tipo))
      return res.status(400).json({ ok: false, error: { code: 'INVALID_TYPE' } });
    const { rows } = await db.query(
      `INSERT INTO ranking_prize_items (prize_set_id, tipo, valor) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, tipo, JSON.stringify(valor)]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  } catch(err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── DELETE /prizes/items/:id — eliminar ítem de prize set ──
router.delete('/items/:id', auth, roles('admin'), async (req, res) => {
  try {
    await db.query(`DELETE FROM ranking_prize_items WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /prizes/grant-manual — otorgamiento manual a un alumno ──
router.post('/grant-manual', auth, roles('admin','teacher'), async (req, res) => {
  const { user_id, premios } = req.body;
  // premios = [{ tipo, valor }]
  if (!user_id || !Array.isArray(premios) || !premios.length)
    return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS' } });

  const results = [];
  for (const premio of premios) {
    try {
      const result = await grantPrize(user_id, premio, req.user.id);
      results.push({ tipo: premio.tipo, ok: true, ...result });
    } catch(e) {
      results.push({ tipo: premio.tipo, ok: false, error: e.message });
    }
  }
  res.json({ ok: true, data: results });
});

// ── POST /prizes/execute/:periodo — ejecutar premios de un período ──
router.post('/execute/:periodo', auth, roles('admin'), async (req, res) => {
  const { periodo } = req.params;
  if (!['daily','weekly','monthly'].includes(periodo))
    return res.status(400).json({ ok: false, error: { code: 'INVALID_PERIODO' } });

  try {
    // Obtener TODOS los alumnos del ranking
    const { rows: ranking } = await db.query(
      `SELECT u.id, u.nombre, u.total_earned
       FROM users u WHERE u.rol='student' AND u.activo=true
       ORDER BY u.total_earned DESC`
    );

    // Obtener prize sets del período (con soporte de rangos)
    const { rows: sets } = await db.query(
      `SELECT ps.*, 
        COALESCE(json_agg(pi ORDER BY pi.created_at) FILTER (WHERE pi.id IS NOT NULL), '[]') AS items
       FROM ranking_prize_sets ps
       LEFT JOIN ranking_prize_items pi ON pi.prize_set_id = ps.id
       WHERE ps.periodo=$1 AND ps.activo=true
       GROUP BY ps.id ORDER BY ps.puesto`, [periodo]
    );

    const results = [];
    for (const set of sets) {
      // Determinar qué alumnos reciben este premio
      let targetAlumnos = [];
      if (set.puesto_hasta === null) {
        // Puesto específico
        const alumno = ranking[set.puesto - 1];
        if (alumno) targetAlumnos = [alumno];
      } else if (set.puesto_hasta === 0) {
        // Desde puesto X hasta el último
        targetAlumnos = ranking.slice(set.puesto - 1);
      } else {
        // Rango puesto A hasta B
        targetAlumnos = ranking.slice(set.puesto - 1, set.puesto_hasta);
      }
      if (!targetAlumnos.length) continue;
      for (const alumno of targetAlumnos) {
      const items = typeof set.items === 'string' ? JSON.parse(set.items) : set.items;
      for (const item of items) {
        try {
          const valor = typeof item.valor === 'string' ? JSON.parse(item.valor) : item.valor;
          await grantPrize(alumno.id, { tipo: item.tipo, valor }, 'system');
          results.push({ puesto: set.puesto, alumno: alumno.nombre, tipo: item.tipo, ok: true });
        } catch(e) {
          results.push({ puesto: set.puesto, alumno: alumno.nombre, tipo: item.tipo, ok: false, error: e.message });
        }
      }
      } // end for alumno
      // Registrar en historial (una vez por set)
      if (targetAlumnos.length > 0) {
        await db.query(
          `INSERT INTO ranking_prizes_granted (user_id, prize_set_id, periodo, puesto, premio_data, granted_by)
           VALUES ($1,$2,$3,$4,$5,'system')`,
          [targetAlumnos[0].id, set.id, periodo, set.puesto, JSON.stringify({ items, count: targetAlumnos.length })]
        ).catch(()=>{});
      }
    }

    // Actualizar ultima_ejecucion
    await db.query(
      `UPDATE prize_schedules SET ultima_ejecucion=NOW() WHERE periodo=$1`,
      [periodo]
    ).catch(()=>{});
    res.json({ ok: true, data: { periodo, ejecutados: results.length, results } });
  } catch(err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /prizes/history — historial de premios entregados ──
router.get('/history', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT rpg.*, u.nombre AS alumno_nombre
       FROM ranking_prizes_granted rpg
       JOIN users u ON u.id = rpg.user_id
       ORDER BY rpg.granted_at DESC LIMIT 50`
    );
    res.json({ ok: true, data: rows });
  } catch(err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── Función central: ejecutar un premio ──────────────────────
async function grantPrize(userId, { tipo, valor }, grantedBy) {
  const { getTreasuryAccountId, getBalance } = require('../services/balance');
  const { v4: uuidv4 } = require('uuid');

  switch(tipo) {

    case 'monedas': {
      const cantidad = valor.cantidad || 0;
      if (cantidad <= 0) throw new Error('Cantidad inválida');
      const { rows: accs } = await db.query(
        `SELECT a.id FROM accounts a WHERE a.user_id=$1 AND a.account_type='student'`, [userId]);
      if (!accs.length) throw new Error('Cuenta no encontrada');
      const client = await db.getClient();
      try {
        await client.query('BEGIN');
        const treasury = await getTreasuryAccountId(client);
        const txId = uuidv4();
        await client.query(
          `INSERT INTO transactions (id,type,description,initiated_by) VALUES ($1,'reward',$2,$3)`,
          [txId, `Premio: ${valor.motivo||'Premio de ranking'}`, grantedBy]);
        await client.query(
          `INSERT INTO ledger_entries (transaction_id,account_id,amount) VALUES ($1,$2,$3),($1,$4,$5)`,
          [txId, treasury, -cantidad, accs[0].id, cantidad]);
        await client.query('UPDATE users SET total_earned=total_earned+$1 WHERE id=$2',[cantidad,userId]);
        await client.query('COMMIT');
      } catch(e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
      break;
    }

    case 'titulo': {
      const expiresAt = valor.expires_days
        ? new Date(Date.now() + valor.expires_days * 86400000).toISOString() : null;
      await db.query(
        `INSERT INTO earned_titles (user_id,name,rarity,color,glow_color,emoji,note,granted_by,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [userId, valor.name, valor.rarity||'common', valor.color||'#ffffff',
         valor.glow_color||null, valor.emoji||null,
         valor.note||`Premio puesto ${valor.puesto||'?'} del ranking`, grantedBy, expiresAt]);
      // Notificar alumno
      await notifyUser(userId, {
        tipo: 'titulo_otorgado',
        titulo: valor.name,
        rarity: valor.rarity,
        mensaje: `¡Recibiste el título "${valor.name}"! ${expiresAt?`Válido hasta ${new Date(expiresAt).toLocaleDateString('es-AR')}`:'Permanente'}`
      });
      break;
    }

    case 'borde': {
      const expiresAt = valor.expires_days
        ? new Date(Date.now() + valor.expires_days * 86400000).toISOString() : null;
      // Unlock border for the user (or loan it)
      if (!valor.expires_days) {
        await db.query(
          `UPDATE users SET unlocked_borders=array_append(unlocked_borders,$1) WHERE id=$2 AND NOT ($1=ANY(unlocked_borders))`,
          [valor.item_id, userId]);
      } else {
        await db.query(
          `INSERT INTO loaned_items (user_id,type,item_data,note,expires_at,granted_by)
           VALUES ($1,'border',$2,$3,$4,$5)`,
          [userId, JSON.stringify({id:valor.item_id,name:valor.name}),
           valor.note||'Premio de ranking', expiresAt, grantedBy]);
      }
      await notifyUser(userId, { tipo: 'premio', mensaje: `¡Ganaste el borde "${valor.name||valor.item_id}"!` });
      break;
    }

    case 'skin': {
      const expiresAtSkin = valor.expires_days
        ? new Date(Date.now() + valor.expires_days * 86400000).toISOString() : null;
      if (!expiresAtSkin) {
        // Permanente → va a unlocked_skins
        await db.query(
          `UPDATE users SET unlocked_skins=array_append(unlocked_skins,$1) WHERE id=$2 AND NOT ($1=ANY(unlocked_skins))`,
          [valor.item_id, userId]);
      } else {
        // Temporal → va a loaned_items
        await db.query(
          `INSERT INTO loaned_items (user_id,type,item_data,note,expires_at,granted_by)
           VALUES ($1,'skin',$2,$3,$4,$5)`,
          [userId, JSON.stringify({id:valor.item_id,name:valor.name}),
           valor.note||'Premio', expiresAtSkin, grantedBy]);
      }
      await notifyUser(userId, { tipo: 'premio', mensaje: `¡Ganaste la skin "${valor.name||valor.item_id}"!` });
      break;
    }

    case 'marco': {
      const expiresAt = valor.expires_days
        ? new Date(Date.now() + valor.expires_days * 86400000).toISOString() : null;
      await db.query(
        `INSERT INTO loaned_items (user_id,type,item_data,note,expires_at,granted_by)
         VALUES ($1,'avatar_bg',$2,$3,$4,$5)`,
        [userId, JSON.stringify({id:'loaned_'+Date.now(),name:valor.name,type:valor.type||'frame',value:valor.value,glow:valor.glow||null}),
         valor.note||'Premio de ranking', expiresAt, grantedBy]);
      await notifyUser(userId, { tipo: 'premio', mensaje: `¡Ganaste el marco "${valor.name}"!` });
      break;
    }

    case 'name_color': {
      const expiresAt = valor.expires_days
        ? new Date(Date.now() + valor.expires_days * 86400000).toISOString() : null;
      // Loan the name_color item
      await db.query(
        `INSERT INTO loaned_items (user_id,type,item_data,note,expires_at,granted_by)
         VALUES ($1,'name_color',$2,$3,$4,$5)`,
        [userId, JSON.stringify({item_id:valor.item_id,name:valor.name}),
         valor.note||'Premio de ranking', expiresAt, grantedBy]);
      await notifyUser(userId, { tipo: 'premio', mensaje: `¡Ganaste el color de nombre "${valor.name}"!` });
      break;
    }

    case 'custom_unlock': {
      // Give the user access to a customization item
      const { rows: item } = await db.query(
        `SELECT id FROM shop_items_custom WHERE tipo=$1 AND activo=true LIMIT 1`,
        [valor.tipo]);
      if (item.length) {
        await db.query(
          `INSERT INTO user_custom_items (user_id,item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [userId, item[0].id]);
      }
      await notifyUser(userId, { tipo: 'premio', mensaje: `¡Desbloqueaste ${valor.tipo}!` });
      break;
    }

    default:
      throw new Error(`Tipo de premio desconocido: ${tipo}`);
  }
  return { ok: true };
}

async function notifyUser(userId, payload) {
  try {
    try {
      const { getIO } = require('../socket');
      const io = getIO();
      if (io) io.to(`user:${userId}`).emit('notification', payload);
    } catch(e) {}
    // Save to DB - notifications table has titulo NOT NULL
    await db.query(
      `INSERT INTO notifications (user_id, tipo, titulo, cuerpo, data)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId, payload.tipo||'premio',
       payload.mensaje||'Nuevo premio',
       payload.mensaje||null,
       JSON.stringify(payload)]
    ).catch(()=>{});
  } catch(e) {}
}

// ── GET /prizes/schedules — obtener configuración de schedules ──
router.get('/schedules', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT * FROM prize_schedules ORDER BY periodo`);
    res.json({ ok: true, data: rows });
  } catch(err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── PATCH /prizes/schedules/:periodo — actualizar schedule ──
router.patch('/schedules/:periodo', auth, roles('admin'), async (req, res) => {
  try {
    const { periodo } = req.params;
    const { hora, dia_semana, dia_mes, activo } = req.body;
    if (!['daily','weekly','monthly'].includes(periodo))
      return res.status(400).json({ ok:false, error:{code:'INVALID_PERIODO'} });
    await db.query(
      `UPDATE prize_schedules SET
        hora = COALESCE($1, hora),
        dia_semana = COALESCE($2, dia_semana),
        dia_mes = COALESCE($3, dia_mes),
        activo = COALESCE($4, activo)
       WHERE periodo = $5`,
      [hora||null, dia_semana||null, dia_mes||null, activo??null, periodo]
    );
    const { rows } = await db.query(`SELECT * FROM prize_schedules WHERE periodo=$1`,[periodo]);
    res.json({ ok:true, data: rows[0] });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR', message:err.message} });
  }
});

// ── POST /prizes/sets — crear nuevo prize set (con rango) ──
router.post('/sets', auth, roles('admin'), async (req, res) => {
  try {
    const { periodo, puesto, puesto_hasta } = req.body;
    if (!['daily','weekly','monthly'].includes(periodo))
      return res.status(400).json({ ok:false, error:{code:'INVALID_PERIODO'} });
    const { rows } = await db.query(
      `INSERT INTO ranking_prize_sets (periodo, puesto, puesto_hasta)
       VALUES ($1,$2,$3) RETURNING *`,
      [periodo, puesto, puesto_hasta||null]
    );
    res.status(201).json({ ok:true, data: rows[0] });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR', message:err.message} });
  }
});

// ── DELETE /prizes/sets/:id ──
router.delete('/sets/:id', auth, roles('admin'), async (req, res) => {
  try {
    await db.query(`DELETE FROM ranking_prize_sets WHERE id=$1`, [req.params.id]);
    res.json({ ok:true });
  } catch(err) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR', message:err.message} });
  }
});


module.exports = { router, grantPrize };
