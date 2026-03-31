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
const crypto  = require('crypto');

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

    // Guardar nota en historial independiente (siempre que no esté vacía)
    if (nota) {
      await db.query(
        `INSERT INTO wellness_notes (id, user_id, mood, categories, nota) VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), req.user.id, mood, JSON.stringify(categories), nota]
      ).catch(e => console.warn('[wellness_notes insert]', e.message));
    }

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

    // Notificar al dashboard admin en tiempo real
    {
      const io = getIO();
      if (io) {
        const { rows: staffWU } = await db.query(
          "SELECT id FROM users WHERE rol IN ('admin','teacher') AND activo=TRUE"
        );
        staffWU.forEach(s =>
          io.to(`user:${s.id}`).emit('wellness_update', { mood, date: hoy })
        );
      }
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

// ══════════════════════════════════════════════════════════════
// PSICOLOGÍA — Config + Algoritmo de Riesgo + Endpoints Admin
// ══════════════════════════════════════════════════════════════

const DEFAULT_CFG = {
  low_mood_threshold: 2,
  weights: {
    low_avg_7d:      20,
    consecutive_low: 10,
    consecutive_cap: 50,
    unread_report:   30,
    high_risk_cat:    5,
    sudden_drop:     15,
    no_data:          8,
  },
  high_risk_categories: ['miedo', 'soledad', 'presion'],
  risk_levels: { attention: 15, priority: 35, urgent: 60 },
  show_notas: true,
};

// ── Crear tablas si no existen ───────────────────────────────
db.query(`
  CREATE TABLE IF NOT EXISTS wellness_notes (
    id         UUID PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mood       INT,
    categories JSONB DEFAULT '[]',
    nota       TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.warn('[wellness_notes]', e.message));

db.query(`
  CREATE TABLE IF NOT EXISTS wellness_backups (
    id          UUID PRIMARY KEY,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    period_days INT NOT NULL,
    record_count INT NOT NULL,
    size_bytes  INT NOT NULL,
    encrypted_data TEXT NOT NULL,
    iv          TEXT NOT NULL,
    auth_tag    TEXT NOT NULL,
    checksum    TEXT NOT NULL
  )
`).catch(e => console.warn('[wellness_backups]', e.message));

db.query(`
  CREATE TABLE IF NOT EXISTS wellness_config (
    id         SERIAL PRIMARY KEY,
    config     JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`).then(async () => {
  const { rows } = await db.query('SELECT id FROM wellness_config LIMIT 1');
  if (!rows.length)
    await db.query('INSERT INTO wellness_config (config) VALUES ($1)', [JSON.stringify(DEFAULT_CFG)]);
}).catch(e => console.warn('[wellness_config]', e.message));

async function getWellnessCfg() {
  try {
    const { rows } = await db.query('SELECT config FROM wellness_config LIMIT 1');
    if (!rows.length) return DEFAULT_CFG;
    const c = rows[0].config;
    return {
      ...DEFAULT_CFG, ...c,
      weights:      { ...DEFAULT_CFG.weights,      ...(c.weights      || {}) },
      risk_levels:  { ...DEFAULT_CFG.risk_levels,  ...(c.risk_levels  || {}) },
    };
  } catch { return DEFAULT_CFG; }
}

function daysAgoAR(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 10);
}

function computeRisk(student, entries, unreadReports, cfg) {
  const w   = cfg.weights;
  const thr = cfg.low_mood_threshold ?? 2;

  // Una entrada por día (la más reciente), ordenadas desc
  const byDate = new Map();
  entries.forEach(e => {
    const d = String(e.date).slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, parseInt(e.mood));
  });
  const daily = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  const d7  = daysAgoAR(7);
  const d14 = daysAgoAR(14);

  const recent7  = entries.filter(e => String(e.date).slice(0, 10) >= d7);
  const prev7    = entries.filter(e => { const d = String(e.date).slice(0, 10); return d >= d14 && d < d7; });

  const avg7d    = recent7.length ? recent7.reduce((s, e) => s + parseInt(e.mood), 0) / recent7.length    : null;
  const avgPrev7 = prev7.length   ? prev7.reduce((s,   e) => s + parseInt(e.mood), 0) / prev7.length      : null;

  // Días consecutivos bajos desde el más reciente
  let consecutive = 0;
  for (const [, mood] of daily) { if (mood <= thr) consecutive++; else break; }

  const lastDate  = daily[0]?.[0] ?? null;
  const lastMood  = daily[0]?.[1] ?? null;
  const today     = todayAR();
  const daysSince = lastDate ? Math.floor((new Date(today) - new Date(lastDate)) / 86400000) : null;

  // Frecuencia de categorías (últimos 7 días)
  const catCnt = {};
  recent7.forEach(e => {
    const cats = Array.isArray(e.categories) ? e.categories : [];
    cats.forEach(c => { catCnt[c] = (catCnt[c] || 0) + 1; });
  });
  const hrCats    = (cfg.high_risk_categories || ['miedo','soledad','presion']).filter(c => catCnt[c]);
  const suddenDrop = lastMood !== null && avgPrev7 !== null && (avgPrev7 - lastMood) >= 2;

  // Puntuación
  const br = {};
  br.low_avg      = (avg7d !== null && avg7d <= thr + 0.5)
    ? Math.min(w.low_avg_7d, Math.round((thr + 1 - avg7d) * w.low_avg_7d)) : 0;
  br.consecutive  = Math.min(w.consecutive_cap, consecutive * w.consecutive_low);
  br.reports      = unreadReports * w.unread_report;
  br.high_risk    = hrCats.length * w.high_risk_cat;
  br.sudden_drop  = suddenDrop ? w.sudden_drop : 0;
  br.no_data      = (daysSince === null || daysSince >= 7) ? w.no_data : 0;
  const score     = Object.values(br).reduce((s, v) => s + v, 0);

  const lvl = cfg.risk_levels;
  const risk_level = score >= (lvl.urgent    ?? 60) ? 'urgent'
    :                score >= (lvl.priority  ?? 35) ? 'priority'
    :                score >= (lvl.attention ?? 15) ? 'attention'
    :                'normal';

  // Tendencia: promedio de los últimos 3 días vs los 3 anteriores
  let trend = 'stable';
  if (daily.length >= 4) {
    const r3 = daily.slice(0, 3).reduce((s, [, m]) => s + m, 0) / 3;
    const p  = daily.slice(3, 6);
    if (p.length) {
      const o3 = p.reduce((s, [, m]) => s + m, 0) / p.length;
      if (r3 - o3 >  0.5) trend = 'improving';
      if (o3 - r3 >  0.5) trend = 'declining';
    }
  }

  return {
    ...student,
    risk_score:      Math.round(score),
    risk_level,
    avg_7d:          avg7d !== null ? Math.round(avg7d * 10) / 10 : null,
    consecutive_low: consecutive,
    last_mood:       lastMood,
    last_entry_date: lastDate,
    days_since_entry:daysSince,
    unread_reports:  unreadReports,
    top_cats:        Object.entries(catCnt).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, cnt]) => ({ id, cnt })),
    high_risk_cats:  hrCats,
    trend,
    has_nota:        entries.some(e => e.has_nota),
    total_entries:   daily.length,
    score_breakdown: br,
  };
}

// ── GET /wellness/admin/dashboard ────────────────────────────
router.get('/admin/dashboard', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const today = todayAR();
    const [todayStats, moodDist, catStats, alertRows, unreadCnt, totalSt] = await Promise.all([
      db.query(
        `SELECT COUNT(DISTINCT user_id) AS checked_today,
                ROUND(AVG(mood)::numeric, 1) AS avg_mood
         FROM mood_entries WHERE DATE(created_at AT TIME ZONE $1) = $2`,
        [TZ, today]
      ),
      db.query(
        `SELECT mood, COUNT(*) AS cnt FROM mood_entries
         WHERE DATE(created_at AT TIME ZONE $1) = $2 GROUP BY mood ORDER BY mood`,
        [TZ, today]
      ),
      db.query(
        `SELECT cat, COUNT(*) AS cnt
         FROM mood_entries, UNNEST(categories) AS cat
         WHERE DATE(created_at AT TIME ZONE $1) >= $2::date - 7
         GROUP BY cat ORDER BY cnt DESC LIMIT 8`,
        [TZ, today]
      ),
      db.query(
        `SELECT u.id, u.nombre,
                COUNT(*) FILTER (WHERE me.mood <= 2) AS low_days
         FROM mood_entries me
         JOIN users u ON u.id = me.user_id
         WHERE DATE(me.created_at AT TIME ZONE $1) >= $2::date - 7
         GROUP BY u.id, u.nombre
         HAVING COUNT(*) FILTER (WHERE me.mood <= 2) >= 3
         ORDER BY low_days DESC LIMIT 5`,
        [TZ, today]
      ),
      db.query(`SELECT COUNT(*) AS cnt FROM wellness_reports WHERE NOT reviewed`),
      db.query(`SELECT COUNT(*) AS cnt FROM users WHERE rol='student' AND activo=TRUE`),
    ]);

    res.json({ ok: true, data: {
      total_students:  parseInt(totalSt.rows[0].cnt),
      checked_today:   parseInt(todayStats.rows[0].checked_today),
      avg_mood_today:  todayStats.rows[0].avg_mood ? parseFloat(todayStats.rows[0].avg_mood) : null,
      unread_reports:  parseInt(unreadCnt.rows[0].cnt),
      mood_dist:       moodDist.rows.map(r => ({ mood: parseInt(r.mood), cnt: parseInt(r.cnt) })),
      top_categories:  catStats.rows.map(r => ({ cat: r.cat, cnt: parseInt(r.cnt) })),
      recent_alerts:   alertRows.rows.map(r => ({ ...r, low_days: parseInt(r.low_days) })),
    }});
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /wellness/admin/students ─────────────────────────────
router.get('/admin/students', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const cfg    = await getWellnessCfg();
    const filter = req.query.filter || 'all';
    const today  = todayAR();

    const [stRes, entRes, repRes] = await Promise.all([
      db.query(`SELECT id, nombre, avatar_bg FROM users WHERE rol='student' AND activo=TRUE ORDER BY nombre`),
      db.query(
        `SELECT user_id, mood, categories,
                (nota IS NOT NULL AND nota <> '') AS has_nota,
                DATE(created_at AT TIME ZONE $1)::text AS date
         FROM mood_entries
         WHERE DATE(created_at AT TIME ZONE $1) >= $2::date - 30
         ORDER BY created_at DESC`,
        [TZ, today]
      ),
      db.query(
        `SELECT user_id, COUNT(*) AS unread
         FROM wellness_reports WHERE user_id IS NOT NULL AND NOT reviewed
         GROUP BY user_id`
      ),
    ]);

    const byUser  = new Map();
    entRes.rows.forEach(e => {
      if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
      byUser.get(e.user_id).push(e);
    });
    const repMap = new Map(repRes.rows.map(r => [r.user_id, parseInt(r.unread)]));

    let result = stRes.rows.map(s =>
      computeRisk(s, byUser.get(s.id) || [], repMap.get(s.id) || 0, cfg)
    );
    if (filter !== 'all') result = result.filter(s => s.risk_level === filter);
    result.sort((a, b) => b.risk_score - a.risk_score);

    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /wellness/admin/student/:userId ──────────────────────
router.get('/admin/student/:userId', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const cfg  = await getWellnessCfg();
    const uid  = req.params.userId;
    const days = Math.min(730, Math.max(7, parseInt(req.query.days) || 30));

    const [stRes, entRes, repRes, unreadRes] = await Promise.all([
      db.query(`SELECT id, nombre, avatar_bg FROM users WHERE id = $1`, [uid]),
      db.query(
        `SELECT mood, categories,
                (nota IS NOT NULL AND nota <> '') AS has_nota,
                DATE(created_at AT TIME ZONE $2)::text AS date
         FROM mood_entries WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 60`,
        [uid, TZ]
      ),
      db.query(
        `SELECT id, tipo, descripcion, is_anonymous, reviewed, reviewed_at, created_at
         FROM wellness_reports WHERE user_id = $1 ORDER BY created_at DESC`,
        [uid]
      ),
      db.query(`SELECT COUNT(*) AS unread FROM wellness_reports WHERE user_id=$1 AND NOT reviewed`, [uid]),
    ]);

    // wellness_notes separado: si la tabla no existe aún, devuelve [] sin romper el endpoint
    let notesRows = [];
    try {
      const notesRes = await db.query(
        `SELECT id,
                CASE WHEN $2 THEN nota ELSE NULL END AS nota,
                mood, categories,
                DATE(created_at AT TIME ZONE $3)::text    AS date,
                TO_CHAR(created_at AT TIME ZONE $3, 'HH24:MI') AS time,
                created_at
         FROM wellness_notes
         WHERE user_id = $1
           AND created_at >= NOW() - ($4::text || ' days')::INTERVAL
         ORDER BY created_at DESC`,
        [uid, !!cfg.show_notas, TZ, days]
      );
      notesRows = notesRes.rows;
    } catch(e) { console.warn('[student notes]', e.message); }

    if (!stRes.rows.length)
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });

    const student = stRes.rows[0];
    const risk    = computeRisk(student, entRes.rows, parseInt(unreadRes.rows[0].unread), cfg);

    res.json({ ok: true, data: {
      student, risk,
      entries: entRes.rows,
      notes:   notesRows,
      reports: repRes.rows,
    } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /wellness/admin/explore ──────────────────────────────
// Vista manual: todos los alumnos con su entrada más reciente del período, con nota
router.get('/admin/explore', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const cfg    = await getWellnessCfg();
    const days   = Math.min(730, Math.max(1, parseInt(req.query.days) || 30));
    const today  = todayAR();
    const since  = daysAgoAR(days - 1);

    const [stRes, entRes] = await Promise.all([
      db.query(
        `SELECT id, nombre, avatar_bg FROM users WHERE rol='student' AND activo=TRUE ORDER BY nombre`
      ),
      db.query(
        `SELECT DISTINCT ON (user_id)
                user_id, mood, categories,
                (nota IS NOT NULL AND nota <> '') AS has_nota,
                DATE(created_at AT TIME ZONE $2)::text AS date
         FROM mood_entries
         WHERE DATE(created_at AT TIME ZONE $2) >= $1::date
         ORDER BY user_id, created_at DESC`,
        [since, TZ]
      ),
    ]);

    // wellness_notes separado: si la tabla no existe aún, devuelve [] sin romper el endpoint
    let notesAllRows = [];
    try {
      const notesRes = await db.query(
        `SELECT user_id,
                CASE WHEN $1 THEN nota ELSE NULL END AS nota,
                mood, categories,
                DATE(created_at AT TIME ZONE $2)::text        AS date,
                TO_CHAR(created_at AT TIME ZONE $2, 'HH24:MI') AS time
         FROM wellness_notes
         WHERE created_at >= NOW() - ($3::text || ' days')::INTERVAL
         ORDER BY created_at DESC`,
        [!!cfg.show_notas, TZ, days]
      );
      notesAllRows = notesRes.rows;
    } catch(e) { console.warn('[explore notes]', e.message); }

    const entMap   = new Map(entRes.rows.map(e => [e.user_id, e]));
    const notesMap = new Map();
    notesAllRows.forEach(n => {
      if (!notesMap.has(n.user_id)) notesMap.set(n.user_id, []);
      notesMap.get(n.user_id).push({ ...n, mood: n.mood ? parseInt(n.mood) : null });
    });

    const result = stRes.rows.map(s => ({
      ...s,
      entry: entMap.get(s.id)
        ? { ...entMap.get(s.id), mood: parseInt(entMap.get(s.id).mood) }
        : null,
      notes: notesMap.get(s.id) || [],
    }));

    // Orden: sin entrada al fondo, con entrada ordenado por mood asc (más bajo primero)
    result.sort((a, b) => {
      if (!a.entry && !b.entry) return 0;
      if (!a.entry) return 1;
      if (!b.entry) return -1;
      return a.entry.mood - b.entry.mood;
    });

    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /wellness/admin/config ───────────────────────────────
router.get('/admin/config', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    res.json({ ok: true, data: await getWellnessCfg() });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── PUT /wellness/admin/config ───────────────────────────────
router.put('/admin/config', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT id FROM wellness_config LIMIT 1');
    if (rows.length)
      await db.query('UPDATE wellness_config SET config=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(req.body), rows[0].id]);
    else
      await db.query('INSERT INTO wellness_config (config) VALUES ($1)', [JSON.stringify(req.body)]);
    res.json({ ok: true, data: await getWellnessCfg() });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════
// BACKUPS CIFRADOS — AES-256-GCM
// ══════════════════════════════════════════════════════════════

function getBackupKey() {
  const secret = process.env.JWT_SECRET || process.env.BACKUP_KEY || 'wellness_backup_default_key_change_in_prod';
  return crypto.createHash('sha256').update(secret + ':wellness_backup').digest();
}

async function runBackup(periodDays = 730) {
  const [entries, notes, reports] = await Promise.all([
    db.query(`SELECT me.id, me.user_id, u.nombre, me.mood, me.categories,
                     DATE(me.created_at AT TIME ZONE $2)::text AS date, me.created_at
              FROM mood_entries me JOIN users u ON u.id=me.user_id
              WHERE me.created_at >= NOW() - ($1 || ' days')::INTERVAL
              ORDER BY me.created_at DESC`, [periodDays, TZ]),
    db.query(`SELECT wn.id, wn.user_id, u.nombre, wn.mood, wn.categories, wn.nota,
                     DATE(wn.created_at AT TIME ZONE $2)::text AS date,
                     TO_CHAR(wn.created_at AT TIME ZONE $2, 'HH24:MI') AS time, wn.created_at
              FROM wellness_notes wn JOIN users u ON u.id=wn.user_id
              WHERE wn.created_at >= NOW() - ($1 || ' days')::INTERVAL
              ORDER BY wn.created_at DESC`, [periodDays, TZ]),
    db.query(`SELECT wr.id, wr.user_id, u.nombre, wr.tipo, wr.descripcion, wr.is_anonymous,
                     wr.reviewed, wr.reviewed_at, wr.created_at
              FROM wellness_reports wr LEFT JOIN users u ON u.id=wr.user_id
              WHERE wr.created_at >= NOW() - ($1 || ' days')::INTERVAL
              ORDER BY wr.created_at DESC`, [periodDays]),
  ]);

  const payload = JSON.stringify({
    backup_date:  new Date().toISOString(),
    period_days:  periodDays,
    entries:      entries.rows,
    notes:        notes.rows,
    reports:      reports.rows,
  });

  const key    = getBackupKey();
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc1   = cipher.update(payload, 'utf8', 'hex');
  const enc2   = cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  const encrypted = enc1 + enc2;
  const checksum  = crypto.createHash('sha256').update(payload).digest('hex');

  const total = entries.rows.length + notes.rows.length + reports.rows.length;

  const { rows } = await db.query(
    `INSERT INTO wellness_backups
       (id, period_days, record_count, size_bytes, encrypted_data, iv, auth_tag, checksum)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at, period_days, record_count, size_bytes`,
    [uuidv4(), periodDays, total, Buffer.byteLength(encrypted,'hex'),
     encrypted, iv.toString('hex'), authTag, checksum]
  );
  return rows[0];
}

// ── GET /wellness/admin/backups ───────────────────────────────
router.get('/admin/backups', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, created_at, period_days, record_count, size_bytes
       FROM wellness_backups ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /wellness/admin/backups — generar backup manual ──────
router.post('/admin/backups', auth, roles('admin'), async (req, res) => {
  try {
    const days = Math.min(730, Math.max(7, parseInt(req.body?.days) || 730));
    const backup = await runBackup(days);
    res.status(201).json({ ok: true, data: backup });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /wellness/admin/backups/:id/download ──────────────────
router.get('/admin/backups/:id/download', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM wellness_backups WHERE id=$1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });

    const b = rows[0];
    const key    = getBackupKey();
    const iv     = Buffer.from(b.iv, 'hex');
    const authTag = Buffer.from(b.auth_tag, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const dec1 = decipher.update(b.encrypted_data, 'hex', 'utf8');
    const dec2 = decipher.final('utf8');
    const plaintext = dec1 + dec2;

    const checksum = crypto.createHash('sha256').update(plaintext).digest('hex');
    if (checksum !== b.checksum) {
      return res.status(500).json({ ok: false, error: { code: 'CHECKSUM_MISMATCH', message: 'Integridad del backup comprometida' } });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="wellness_backup_${b.created_at.toISOString().slice(0,10)}.json"`);
    res.send(plaintext);
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── DELETE /wellness/admin/backups/:id ────────────────────────
router.delete('/admin/backups/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`DELETE FROM wellness_backups WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── Backup automático cada 14 días ────────────────────────────
(function scheduleBackups() {
  const INTERVAL_MS = 14 * 24 * 60 * 60 * 1000; // 14 días
  async function doBackup() {
    try {
      const b = await runBackup(730);
      console.log(`[wellness] Backup automático creado: ${b.id} — ${b.record_count} registros`);
      // Eliminar backups viejos (conservar últimos 10)
      await db.query(
        `DELETE FROM wellness_backups WHERE id NOT IN (
           SELECT id FROM wellness_backups ORDER BY created_at DESC LIMIT 10
         )`
      );
    } catch(e) {
      console.warn('[wellness] Backup automático falló:', e.message);
    }
  }
  setTimeout(function tick() {
    doBackup();
    setTimeout(tick, INTERVAL_MS);
  }, INTERVAL_MS);
})();

module.exports = router;
