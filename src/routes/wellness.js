// src/routes/wellness.js
// GET  /api/v1/wellness/today        -> estado del día actual del alumno
// POST /api/v1/wellness/checkin      -> registrar estado de ánimo (+monedas)
// POST /api/v1/wellness/report       -> reporte formal (anónimo o no)
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

const COINS   = 3;
const TZ      = 'America/Argentina/Buenos_Aires';

function todayAR() {
  return new Date().toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 10);
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
router.post('/checkin', auth, async (req, res) => {
  const client = await db.getClient();
  try {
    const hoy = todayAR();

    // Una sola entrada por día
    const { rows: ya } = await client.query(
      `SELECT id FROM mood_entries WHERE user_id=$1 AND DATE(created_at AT TIME ZONE $2) = $3::date`,
      [req.user.id, TZ, hoy]
    );
    if (ya.length) {
      return res.status(409).json({ ok: false, error: { code: 'ALREADY_DONE', message: 'Ya registraste tu estado hoy' } });
    }

    const mood       = req.body.mood ? Math.min(5, Math.max(1, parseInt(req.body.mood))) : 3;
    const categories = Array.isArray(req.body.categories) ? req.body.categories.slice(0, 6) : [];
    const nota       = req.body.nota ? req.body.nota.trim().slice(0, 500) : null;

    await client.query('BEGIN');

    const { rows: entry } = await client.query(
      `INSERT INTO mood_entries (user_id, mood, categories, nota, coins_earned)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.id, mood, categories, nota, COINS]
    );

    // Acreditar monedas — Tesorería → Alumno
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
            type:  'wellness_alert',
            titulo: 'Alerta de bienestar',
            cuerpo: 'Un alumno registró estado bajo 3 días seguidos',
          })
        );
      }
    }

    // Notificar al alumno para que refresque su balance
    const io = getIO();
    if (io) io.to(`user:${req.user.id}`).emit('notification', {
      type:   'reward',
      amount:  COINS,
      message: `+${COINS} monedas por tu reporte de bienestar`,
    });

    res.status(201).json({ ok: true, data: { ...entry[0], coins_earned: COINS } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: { code: err.code || 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// ── POST /wellness/report ─────────────────────────────────────
router.post('/report', auth, async (req, res) => {
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

    // Notificar al staff
    const { rows: staff } = await db.query(
      "SELECT id FROM users WHERE rol IN ('admin','teacher') AND activo=TRUE"
    );
    const io = getIO();
    if (io) staff.forEach(s =>
      io.to(`user:${s.id}`).emit('notification', {
        type:  'wellness_report',
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
