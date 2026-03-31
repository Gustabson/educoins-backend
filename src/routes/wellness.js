// src/routes/wellness.js
// GET  /api/v1/wellness/today        -> estado del día actual del alumno
// POST /api/v1/wellness/checkin      -> registrar/actualizar estado de ánimo (monedas solo 1 vez/día)
// POST /api/v1/wellness/report       -> reporte formal (anónimo o no), sin límite con antispam
// GET  /api/v1/wellness/reports      -> admin/docente: ver reportes
// PATCH /api/v1/wellness/reports/:id -> marcar como revisado

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');
const { getAccountByUserId } = require('../services/balance');
const { getIO } = require('../socket');
const { v4: uuidv4 } = require('uuid');

const COINS = 3;
const TZ    = 'America/Argentina/Buenos_Aires';

function todayAR() {
  return new Date().toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 10);
}

// ── Rate limiter en memoria ───────────────────────────────────
// Evita que alguien envíe 300 requests por minuto
const rateWindows = new Map(); // userId:action -> [timestamps]

function isRateLimited(key, maxCount, windowMs) {
  const now   = Date.now();
  const times = (rateWindows.get(key) || []).filter(t => now - t < windowMs);
  if (times.length >= maxCount) return true;
  times.push(now);
  rateWindows.set(key, times);
  return false;
}

// ── GET /wellness/today ───────────────────────────────────────
router.get('/today', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, mood, categories, coins_earned, created_at
       FROM mood_entries
       WHERE user_id = $1
         AND DATE(created_at AT TIME ZONE $2) = $3::date`,
      [req.user.id, TZ, todayAR()]
    );
    res.json({ ok: true, data: rows[0] || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /wellness/checkin ────────────────────────────────────
// Primera vez del día: INSERT + monedas
// Actualizaciones posteriores: UPDATE sin monedas (pueden cambiar el ánimo cuando quieran)
router.post('/checkin', auth, async (req, res) => {
  // Antispam: max 20 actualizaciones de ánimo por minuto
  if (isRateLimited(`mood:${req.user.id}`, 20, 60_000)) {
    return res.status(429).json({ ok: false, error: { code: 'RATE_LIMIT', message: 'Demasiadas actualizaciones. Esperá un momento.' } });
  }

  const client = await db.getClient();
  try {
    const hoy        = todayAR();
    const mood       = req.body.mood ? Math.min(5, Math.max(1, parseInt(req.body.mood))) : 3;
    const categories = Array.isArray(req.body.categories) ? req.body.categories.slice(0, 6) : [];
    const nota       = req.body.nota ? req.body.nota.trim().slice(0, 500) : null;

    // ¿Ya existe entrada para hoy?
    const { rows: existing } = await client.query(
      `SELECT id, coins_earned FROM mood_entries
       WHERE user_id=$1 AND DATE(created_at AT TIME ZONE $2) = $3::date`,
      [req.user.id, TZ, hoy]
    );

    await client.query('BEGIN');

    let entry, coinsAwarded = 0;

    if (existing.length > 0) {
      // Actualizar sin dar monedas de nuevo
      const { rows } = await client.query(
        `UPDATE mood_entries SET mood=$1, categories=$2, nota=$3, updated_at=NOW()
         WHERE id=$4 RETURNING *`,
        [mood, categories, nota, existing[0].id]
      );
      entry = rows[0];
    } else {
      // Primera vez del día: INSERT + monedas
      const { rows } = await client.query(
        `INSERT INTO mood_entries (user_id, mood, categories, nota, coins_earned)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.user.id, mood, categories, nota, COINS]
      );
      entry = rows[0];
      coinsAwarded = COINS;

      const { rows: treasury } = await client.query(
        "SELECT id FROM accounts WHERE account_type='treasury' AND is_active=TRUE LIMIT 1"
      );
      const studentAcc = await getAccountByUserId(req.user.id, client);
      const txId = uuidv4();
      await client.query(
        `INSERT INTO transactions (id, type, description, initiated_by, metadata)
         VALUES ($1, 'reward', $2, $3, $4)`,
        [txId, 'Bienestar diario — Estado de ánimo', req.user.id,
         JSON.stringify({ mood, coins: COINS })]
      );
      await client.query(
        `INSERT INTO ledger_entries (id, transaction_id, account_id, amount) VALUES ($1,$2,$3,$4)`,
        [uuidv4(), txId, treasury[0].id, -COINS]
      );
      await client.query(
        `INSERT INTO ledger_entries (id, transaction_id, account_id, amount) VALUES ($1,$2,$3,$4)`,
        [uuidv4(), txId, studentAcc, COINS]
      );
      await client.query(
        'UPDATE users SET total_earned = total_earned + $1 WHERE id = $2',
        [COINS, req.user.id]
      );
    }

    await client.query('COMMIT');

    // Alerta: 3+ días consecutivos con mood <= 2
    if (mood <= 2) {
      const { rows: recent } = await db.query(
        `SELECT mood FROM mood_entries WHERE user_id=$1 ORDER BY created_at DESC LIMIT 3`,
        [req.user.id]
      );
      if (recent.length >= 3 && recent.every(r => r.mood <= 2)) {
        const { rows: staff } = await db.query(
          "SELECT id FROM users WHERE rol IN ('admin','teacher') AND activo=TRUE"
        );
        const io = getIO();
        if (io) staff.forEach(s =>
          io.to(`user:${s.id}`).emit('notification', {
            type:   'wellness_alert',
            titulo: 'Alerta de bienestar',
            cuerpo: 'Un alumno registró estado bajo 3 días seguidos',
          })
        );
      }
    }

    if (coinsAwarded > 0) {
      const io = getIO();
      if (io) io.to(`user:${req.user.id}`).emit('notification', {
        type:   'reward',
        amount:  coinsAwarded,
        message: `+${coinsAwarded} monedas por tu reporte de bienestar`,
      });
    }

    res.status(existing.length > 0 ? 200 : 201).json({
      ok: true,
      data: { ...entry, coins_awarded: coinsAwarded, updated: existing.length > 0 },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: { code: err.code || 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// ── POST /wellness/report ─────────────────────────────────────
// Sin límite diario — pueden reportar cuando quieran
// Antispam: max 5 reportes por hora
router.post('/report', auth, async (req, res) => {
  if (isRateLimited(`report:${req.user.id}`, 5, 60 * 60_000)) {
    return res.status(429).json({ ok: false, error: { code: 'RATE_LIMIT', message: 'Enviaste demasiados reportes. Esperá un momento.' } });
  }

  try {
    const { tipo, descripcion, is_anonymous = true } = req.body;
    const tiposValidos = ['bullying','violencia_domestica','maltrato_docente','acoso','otro'];
    if (!tiposValidos.includes(tipo)) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_TIPO' } });
    }
    if (!descripcion?.trim() || descripcion.trim().length < 10) {
      return res.status(400).json({ ok: false, error: { code: 'TOO_SHORT', message: 'Describí qué pasó (mínimo 10 caracteres)' } });
    }

    const userId = is_anonymous ? null : req.user.id;
    const { rows } = await db.query(
      `INSERT INTO wellness_reports (user_id, tipo, descripcion, is_anonymous)
       VALUES ($1, $2, $3, $4) RETURNING id, tipo, is_anonymous, created_at`,
      [userId, tipo, descripcion.trim().slice(0, 1000), !!is_anonymous]
    );

    const { rows: staff } = await db.query(
      "SELECT id FROM users WHERE rol IN ('admin','teacher') AND activo=TRUE"
    );
    const io = getIO();
    if (io) staff.forEach(s =>
      io.to(`user:${s.id}`).emit('notification', {
        type:   'wellness_report',
        titulo: 'Nuevo reporte de bienestar',
        cuerpo: `Tipo: ${tipo}${is_anonymous ? ' (anónimo)' : ''}`,
      })
    );

    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /wellness/reports — admin/docente ─────────────────────
router.get('/reports', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT wr.id, wr.tipo, wr.descripcion, wr.is_anonymous,
             wr.reviewed, wr.reviewed_at, wr.created_at,
             CASE WHEN wr.is_anonymous THEN NULL ELSE u.nombre END AS nombre,
             CASE WHEN wr.is_anonymous THEN NULL ELSE u.rol    END AS rol
      FROM wellness_reports wr
      LEFT JOIN users u ON u.id = wr.user_id
      ORDER BY wr.reviewed ASC, wr.created_at DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── PATCH /wellness/reports/:id — marcar revisado ─────────────
router.patch('/reports/:id', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE wellness_reports SET reviewed=TRUE, reviewed_by=$1, reviewed_at=NOW()
       WHERE id=$2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;
