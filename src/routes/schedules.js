// src/routes/schedules.js — Weekly school schedule per user
// One active turno (manana/tarde/noche/extra) + N subjects per day within that turno.
//
// GET    /schedules        → all entries for the logged-in user
// POST   /schedules        → create one entry
// PATCH  /schedules/:id    → update one entry
// DELETE /schedules/:id    → remove one entry

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

// Auto-migrate: drop old slot-based table, create turno-based one
db.query(`DROP TABLE IF EXISTS user_schedules`).catch(() => {});
db.query(`
  CREATE TABLE IF NOT EXISTS user_schedules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    turno       TEXT NOT NULL CHECK (turno IN ('manana','tarde','noche','extra')),
    day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    subject     TEXT NOT NULL,
    time_from   TEXT,
    time_to     TEXT,
    color       TEXT DEFAULT '#3b82f6',
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.warn('[schedules] migration:', e.message));

// ── GET / ─────────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM user_schedules
       WHERE user_id = $1
       ORDER BY turno, day_of_week, time_from NULLS LAST, created_at`,
      [req.user.id]
    );
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[schedules] GET:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── POST / — create ───────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    const { turno, day_of_week, subject, time_from, time_to, color } = req.body;
    if (!turno || day_of_week === undefined || !subject?.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'turno, day_of_week y subject son requeridos' } });
    }
    const { rows: [entry] } = await db.query(`
      INSERT INTO user_schedules (user_id, turno, day_of_week, subject, time_from, time_to, color)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [req.user.id, turno, day_of_week, subject.trim(),
        time_from || null, time_to || null, color || '#3b82f6']);
    res.status(201).json({ ok: true, data: entry });
  } catch (e) {
    console.error('[schedules] POST:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── PATCH /:id — update ───────────────────────────────────────
router.patch('/:id', auth, async (req, res) => {
  try {
    const { subject, time_from, time_to, color } = req.body;
    if (!subject?.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'subject es requerido' } });
    }
    const { rows: [entry] } = await db.query(`
      UPDATE user_schedules
      SET subject=$3, time_from=$4, time_to=$5, color=$6
      WHERE id=$1 AND user_id=$2
      RETURNING *
    `, [req.params.id, req.user.id, subject.trim(),
        time_from || null, time_to || null, color || '#3b82f6']);
    if (!entry) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Entrada no encontrada' } });
    res.json({ ok: true, data: entry });
  } catch (e) {
    console.error('[schedules] PATCH:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── DELETE /:id ───────────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM user_schedules WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[schedules] DELETE:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

module.exports = router;
