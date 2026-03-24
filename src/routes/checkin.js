// src/routes/checkin.js
// POST /api/v1/checkin          -> hacer check-in del día
// GET  /api/v1/checkin/me       -> mi estado de check-in (racha, último día, etc)
// GET  /api/v1/checkin/config   -> config actual de recompensas
// PATCH /api/v1/checkin/config  -> admin: actualizar config

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');
const { getAccountByUserId } = require('../services/balance');
const { getIO } = require('../socket');

// ── GET /checkin/config ───────────────────────────────────────
router.get('/config', auth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM checkin_config WHERE activo=TRUE LIMIT 1');
    res.json({ ok: true, data: rows[0] || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── PATCH /checkin/config ─────────────────────────────────────
router.patch('/config', auth, roles('admin'), async (req, res) => {
  try {
    const { base_reward, bonus_3days, bonus_7days, bonus_30days, activo } = req.body;
    const { rows } = await db.query(`
      UPDATE checkin_config SET
        base_reward  = COALESCE($1, base_reward),
        bonus_3days  = COALESCE($2, bonus_3days),
        bonus_7days  = COALESCE($3, bonus_7days),
        bonus_30days = COALESCE($4, bonus_30days),
        activo       = COALESCE($5, activo),
        updated_at   = NOW()
      RETURNING *
    `, [base_reward, bonus_3days, bonus_7days, bonus_30days, activo]);
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /checkin/me ───────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const hoy = new Date().toISOString().slice(0,10);
    const { rows: hoyRow } = await db.query(
      'SELECT * FROM daily_checkins WHERE user_id=$1 AND fecha=$2', [req.user.id, hoy]
    );
    const { rows: last } = await db.query(
      'SELECT * FROM daily_checkins WHERE user_id=$1 ORDER BY fecha DESC LIMIT 1', [req.user.id]
    );
    const { rows: config } = await db.query('SELECT * FROM checkin_config WHERE activo=TRUE LIMIT 1');
    const { rows: totalRow } = await db.query(
      'SELECT COUNT(*)::int AS total FROM daily_checkins WHERE user_id=$1', [req.user.id]
    );

    const yaHizoHoy = hoyRow.length > 0;
    const rachaActual = last[0]?.racha || 0;

    res.json({ ok: true, data: {
      ya_hizo_hoy:   yaHizoHoy,
      racha_actual:  rachaActual,
      ultimo_checkin: last[0]?.fecha || null,
      total_checkins: totalRow[0]?.total || 0,
      hoy:           hoyRow[0] || null,
      config:        config[0] || { base_reward:5, bonus_3days:10, bonus_7days:25, bonus_30days:100 },
    }});
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /checkin ─────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  const client = await db.getClient();
  try {
    const hoy  = new Date().toISOString().slice(0,10);
    const ayer = new Date(Date.now() - 86400000).toISOString().slice(0,10);

    // Verificar si ya hizo check-in hoy
    const { rows: yaHizo } = await client.query(
      'SELECT 1 FROM daily_checkins WHERE user_id=$1 AND fecha=$2', [req.user.id, hoy]
    );
    if (yaHizo.length) {
      return res.status(409).json({ ok: false, error: { code: 'ALREADY_DONE', message: 'Ya hiciste check-in hoy' } });
    }

    // Calcular racha
    const { rows: ayer_row } = await client.query(
      'SELECT racha FROM daily_checkins WHERE user_id=$1 AND fecha=$2', [req.user.id, ayer]
    );
    const racha = ayer_row.length > 0 ? ayer_row[0].racha + 1 : 1;

    // Obtener config de recompensas
    const { rows: cfg } = await client.query('SELECT * FROM checkin_config WHERE activo=TRUE LIMIT 1');
    const config = cfg[0] || { base_reward:5, bonus_3days:10, bonus_7days:25, bonus_30days:100 };

    // Calcular recompensa
    let recompensa = config.base_reward;
    let bonus_tipo = null;
    if (racha >= 30) { recompensa += config.bonus_30days; bonus_tipo = '30dias'; }
    else if (racha >= 7) { recompensa += config.bonus_7days; bonus_tipo = '7dias'; }
    else if (racha >= 3) { recompensa += config.bonus_3days; bonus_tipo = '3dias'; }

    await client.query('BEGIN');

    // Guardar check-in
    const { rows: checkin } = await client.query(`
      INSERT INTO daily_checkins (user_id, fecha, racha, recompensa)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [req.user.id, hoy, racha, recompensa]);

    // Acreditar monedas — Tesorería → Alumno
    const { rows: treasury } = await client.query(
      "SELECT id FROM accounts WHERE account_type='treasury' AND is_active=TRUE LIMIT 1"
    );
    const studentAcc = await getAccountByUserId(req.user.id, client);
    const txId = require('uuid').v4();
    await client.query(`
      INSERT INTO transactions (id,type,description,initiated_by,metadata)
      VALUES ($1,'reward',$2,$3,$4)
    `, [txId, `Check-in diario — Racha ${racha} día${racha!==1?'s':''}`, req.user.id,
        JSON.stringify({ racha, bonus_tipo, recompensa })]);
    await client.query(`INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)`,
      [require('uuid').v4(), txId, treasury[0].id, -recompensa]);
    await client.query(`INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)`,
      [require('uuid').v4(), txId, studentAcc, recompensa]);

    // Actualizar total_earned
    await client.query(
      'UPDATE users SET total_earned = total_earned + $1 WHERE id = $2', [recompensa, req.user.id]
    );

    // Guardar notificación persistente
    await client.query(`
      INSERT INTO notifications (user_id, tipo, titulo, cuerpo, data)
      VALUES ($1,'reward',$2,$3,$4)
    `, [req.user.id,
        `Check-in día ${racha}! +${recompensa} monedas`,
        bonus_tipo ? `Bonus de racha ${bonus_tipo} incluido!` : 'Seguí así todos los días',
        JSON.stringify({ racha, recompensa, bonus_tipo })]);

    await client.query('COMMIT');

    // Notificar en tiempo real
    const io = getIO();
    if (io) io.to(`user:${req.user.id}`).emit('notification', {
      type: 'checkin', racha, recompensa, bonus_tipo
    });

    res.status(201).json({ ok: true, data: {
      ...checkin[0], recompensa, bonus_tipo,
      mensaje: bonus_tipo
        ? `Racha de ${racha} dias! Bonus incluido`
        : `Check-in dia ${racha}! +${recompensa} monedas`
    }});
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: { code: err.code||'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

module.exports = router;
