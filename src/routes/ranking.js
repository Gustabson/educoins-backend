// src/routes/ranking.js
// GET  /api/v1/ranking/live          -> ranking en vivo (diario/semanal/mensual × global/aula)
// GET  /api/v1/ranking/config        -> configuración de premios (admin)
// PATCH /api/v1/ranking/config/:id   -> editar premio (admin)
// POST /api/v1/ranking/close         -> cerrar período y pagar premios (admin)
// GET  /api/v1/ranking/payouts       -> historial de pagos de ranking
// POST /api/v1/ranking/payouts/:id/revert -> revertir un pago

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');
const uuidParams = require('../middleware/uuid-params');
const { getIO } = require('../socket');
uuidParams(router, 'id');
const { validate: isUuid } = require('uuid');

// ── Helpers de período ────────────────────────────────────────
function getPeriodLabel(periodo) {
  const now = new Date();
  if (periodo === 'daily') {
    return now.toISOString().slice(0, 10); // "2026-03-20"
  }
  if (periodo === 'weekly') {
    const day = now.getDay() || 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - day + 1);
    const year = monday.getFullYear();
    const week = Math.ceil(((monday - new Date(year, 0, 1)) / 86400000 + 1) / 7);
    return `${year}-W${String(week).padStart(2,'0')}`;
  }
  if (periodo === 'monthly') {
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  }
  return 'unknown';
}

function getPeriodStart(periodo) {
  const now = new Date();
  if (periodo === 'daily') {
    const d = new Date(now); d.setHours(0,0,0,0); return d;
  }
  if (periodo === 'weekly') {
    const d = new Date(now);
    const day = d.getDay() || 7;
    d.setDate(d.getDate() - day + 1);
    d.setHours(0,0,0,0);
    return d;
  }
  if (periodo === 'monthly') {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return new Date(0);
}

// ── GET /ranking/live ─────────────────────────────────────────
// ?periodo=daily|weekly|monthly  ?scope=global|aula  ?classroom_id=...
router.get('/live', auth, async (req, res) => {
  try {
    const periodo     = req.query.periodo || 'weekly';
    const scope       = req.query.scope   || 'global';
    const classroomId = req.query.classroom_id || null;
    if (!['daily','weekly','monthly'].includes(periodo) || !['global','aula'].includes(scope) ||
        (scope === 'aula' && !isUuid(classroomId))) {
      return res.status(400).json({ ok:false, error:{ code:'INVALID_SCOPE', message:'Período o aula inválidos' } });
    }
    const periodStart = getPeriodStart(periodo);
    const periodLabel = getPeriodLabel(periodo);

    // Filtro por aula
    const aulaJoin = scope === 'aula'
      ? 'JOIN classroom_members cm ON cm.user_id=u.id AND cm.classroom_id=$2'
      : '';

    // Ranking basado en monedas ganadas en el período
    const { rows } = await db.query(`
      SELECT u.id, u.nombre, u.apodo, u.skin, u.border, u.avatar_bg, u.foto_url, u.rol,
        COALESCE(SUM(CASE WHEN le.amount > 0 AND t.created_at >= $1 THEN le.amount ELSE 0 END),0)::integer AS ganado_periodo,
        COALESCE(SUM(le.amount),0)::integer AS balance_total
      FROM users u
      ${aulaJoin}
      LEFT JOIN accounts a ON a.user_id=u.id AND a.account_type IN ('student','teacher')
      LEFT JOIN ledger_entries le ON le.account_id=a.id
      LEFT JOIN transactions t ON t.id=le.transaction_id AND t.type IN ('reward','transfer')
      WHERE u.activo=TRUE AND u.rol='student'
      GROUP BY u.id
      ORDER BY ganado_periodo DESC, balance_total DESC
      LIMIT 20
    `, scope === 'aula' ? [periodStart, classroomId] : [periodStart]);

    // Obtener configuración de premios para este período+scope
    const { rows: config } = await db.query(
      'SELECT posicion, premio FROM ranking_config WHERE periodo=$1 AND scope=$2 AND activo=TRUE ORDER BY posicion',
      [periodo, scope]
    );

    // Marcar si ya se pagó este período
    const { rows: paid } = await db.query(
      `SELECT 1 FROM ranking_payouts
        WHERE periodo=$1 AND scope=$2 AND periodo_label=$3
          AND classroom_id IS NOT DISTINCT FROM $4::uuid LIMIT 1`,
      [periodo, scope, periodLabel, scope === 'aula' ? classroomId : null]
    );

    res.json({ ok: true, data: {
      ranking: rows.map((u, i) => ({
        ...u,
        posicion: i + 1,
        premio: config.find(c => c.posicion === i + 1)?.premio || 0,
      })),
      config,
      periodo_label: periodLabel,
      ya_pagado: paid.length > 0,
    }});
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /ranking/config ───────────────────────────────────────
router.get('/config', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM ranking_config ORDER BY periodo, scope, posicion'
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── PATCH /ranking/config/:id ─────────────────────────────────
router.patch('/config/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { premio, activo } = req.body;
    if (!isUuid(req.params.id) ||
        (premio !== undefined && (!Number.isSafeInteger(Number(premio)) || Number(premio) < 0 || Number(premio) > 1000000)) ||
        (activo !== undefined && typeof activo !== 'boolean')) {
      return res.status(400).json({ ok:false, error:{ code:'INVALID_CONFIG' } });
    }
    const { rows } = await db.query(
      'UPDATE ranking_config SET premio=COALESCE($1,premio), activo=COALESCE($2,activo), updated_at=NOW() WHERE id=$3 RETURNING *',
      [premio, activo, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /ranking/config (crear nueva posición) ───────────────
router.post('/config', auth, roles('admin'), async (req, res) => {
  try {
    const { periodo, scope, posicion, premio } = req.body;
    if (!['daily','weekly','monthly'].includes(periodo) || !['global','aula'].includes(scope) ||
        !Number.isSafeInteger(Number(posicion)) || Number(posicion) < 1 || Number(posicion) > 1000 ||
        !Number.isSafeInteger(Number(premio)) || Number(premio) < 0 || Number(premio) > 1000000) {
      return res.status(400).json({ ok:false, error:{ code:'INVALID_CONFIG' } });
    }
    const { rows } = await db.query(`
      INSERT INTO ranking_config (periodo,scope,posicion,premio)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (periodo,scope,posicion) DO UPDATE SET premio=$4, activo=TRUE, updated_at=NOW()
      RETURNING *
    `, [periodo, scope, posicion, premio]);
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /ranking/close ───────────────────────────────────────
// Cierra el período actual y paga los premios automáticamente
router.post('/close', auth, roles('admin'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { periodo, scope, classroom_id } = req.body;
    if (!['daily','weekly','monthly'].includes(periodo) || !['global','aula'].includes(scope) ||
        (scope === 'aula' && !isUuid(classroom_id))) {
      return res.status(400).json({ ok:false, error:{code:'INVALID_SCOPE'} });
    }
    const periodLabel = getPeriodLabel(periodo);
    const periodStart = getPeriodStart(periodo);

    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ranking:${periodo}:${scope}:${classroom_id || ''}:${periodLabel}`]);

    // Verificar que no se haya pagado ya
    const { rows: already } = await client.query(
      `SELECT 1 FROM ranking_payouts
        WHERE periodo=$1 AND scope=$2 AND periodo_label=$3
          AND classroom_id IS NOT DISTINCT FROM $4::uuid LIMIT 1`,
      [periodo, scope, periodLabel, scope === 'aula' ? classroom_id : null]
    );
    if (already.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: { code: 'ALREADY_PAID', message: 'Este período ya fue cerrado y pagado' } });
    }

    // Obtener ranking actual
    const aulaJoin = scope === 'aula' && classroom_id
      ? 'JOIN classroom_members cm ON cm.user_id=u.id AND cm.classroom_id=$2'
      : '';

    const { rows: ranking } = await client.query(`
      SELECT u.id,
        COALESCE(SUM(CASE WHEN le.amount>0 AND t.created_at>=$1 THEN le.amount ELSE 0 END),0)::integer AS ganado
      FROM users u ${aulaJoin}
      LEFT JOIN accounts a ON a.user_id=u.id AND a.account_type IN ('student','teacher')
      LEFT JOIN ledger_entries le ON le.account_id=a.id
      LEFT JOIN transactions t ON t.id=le.transaction_id AND t.type IN ('reward','transfer')
      WHERE u.activo=TRUE AND u.rol='student'
      GROUP BY u.id ORDER BY ganado DESC LIMIT 20
    `, scope === 'aula' ? [periodStart, classroom_id] : [periodStart]);

    const { rows: config } = await client.query(
      'SELECT posicion, premio FROM ranking_config WHERE periodo=$1 AND scope=$2 AND activo=TRUE AND premio>0 ORDER BY posicion',
      [periodo, scope]
    );

    const ledger = require('../services/ledger');
    const io = getIO();
    const payouts = [];

    for (const cfg of config) {
      const user = ranking[cfg.posicion - 1];
      if (!user || user.ganado === 0) continue;

      const txId = await ledger.reward({
          teacherId:   req.user.id,
          studentId:   user.id,
          amount:      cfg.premio,
          description: `Premio Ranking ${periodo} ${scope} - Posición #${cfg.posicion} (${periodLabel})`,
          meta:        { ranking: true, periodo, scope, posicion: cfg.posicion, period_label: periodLabel },
          client,
      });

      const { rows: payout } = await client.query(`
          INSERT INTO ranking_payouts (periodo, scope, periodo_label, classroom_id, user_id, posicion, premio, transaction_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
        `, [periodo, scope, periodLabel, scope === 'aula' ? classroom_id : null, user.id, cfg.posicion, cfg.premio, txId]);

      payouts.push(payout[0]);
    }

    await client.query('COMMIT');
    for (const payout of payouts) {
      if (io) io.to(`user:${payout.user_id}`).emit('notification', {
        type: 'reward', amount: payout.premio,
        description: `Premio Ranking #${payout.posicion} del ${periodo === 'daily' ? 'día' : periodo === 'weekly' ? 'semana' : 'mes'}!`,
        from: 'Ranking EduCoins',
      });
    }
    res.json({ ok: true, data: { pagados: payouts.length, payouts } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// ── GET /ranking/payouts ──────────────────────────────────────
router.get('/payouts', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT rp.*, u.nombre, u.skin, u.border, u.avatar_bg
      FROM ranking_payouts rp
      JOIN users u ON u.id=rp.user_id
      ORDER BY rp.created_at DESC
      LIMIT 100
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /ranking/payouts/:id/revert ─────────────────────────
router.post('/payouts/:id/revert', auth, roles('admin'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { motivo } = req.body;
    if (!isUuid(req.params.id) || (motivo !== undefined && (typeof motivo !== 'string' || motivo.trim().length > 500))) {
      return res.status(400).json({ ok:false, error:{ code:'INVALID_REVERSAL' } });
    }
    await client.query('BEGIN');
    const { rows: pRows } = await client.query('SELECT * FROM ranking_payouts WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!pRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    const payout = pRows[0];
    if (payout.revertida) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: { code: 'ALREADY_REVERTED' } });
    }

    const { getTreasuryAccountId, getAccountByUserId, assertSufficientBalance, lockAccountsForUpdate } = require('../services/balance');
    const { v4: uuidv4 } = require('uuid');

    const treasuryId = await getTreasuryAccountId(client);
    const userAccId  = await getAccountByUserId(payout.user_id, client);
    await lockAccountsForUpdate([userAccId, treasuryId], client);
    await assertSufficientBalance(userAccId, Number(payout.premio), client);

    const revertId = uuidv4();
    await client.query(`
      INSERT INTO transactions (id,type,description,initiated_by,metadata)
      VALUES ($1,'adjustment',$2,$3,$4)
    `, [revertId,
        `Reversa premio ranking: ${motivo||'Admin'}`,
        req.user.id,
        JSON.stringify({ revert_of: payout.transaction_id, motivo, ranking_payout: payout.id })]);

    await client.query('INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)',
      [uuidv4(), revertId, userAccId, -payout.premio]);
    await client.query('INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)',
      [uuidv4(), revertId, treasuryId, payout.premio]);

    await client.query('UPDATE ranking_payouts SET revertida=TRUE WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');

    const io = getIO();
    if (io) io.to(`user:${payout.user_id}`).emit('notification', {
      type: 'tax', amount: payout.premio, motivo: `Reversa premio ranking: ${motivo||''}`,
    });

    res.json({ ok: true, data: { revert_tx: revertId, payout } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

module.exports = router;
