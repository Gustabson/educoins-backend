// src/routes/schedules.js — Weekly schedule per user
// GET    /schedules        → full schedule for the logged-in user
// PUT    /schedules        → upsert one slot
// DELETE /schedules/:id   → remove one entry

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

// Auto-migrate
db.query(`
  CREATE TABLE IF NOT EXISTS user_schedules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    slot        TEXT NOT NULL CHECK (slot IN ('manana','tarde','noche','extra')),
    subject     TEXT NOT NULL,
    time_from   TEXT,
    time_to     TEXT,
    color       TEXT DEFAULT '#3b82f6',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, day_of_week, slot)
  )
`).catch(e => console.warn('[schedules] migration:', e.message));

// GET /schedules
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM user_schedules WHERE user_id=$1 ORDER BY day_of_week, slot',
      [req.user.id]
    );
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[schedules] GET:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// PUT /schedules — upsert
router.put('/', auth, async (req, res) => {
  try {
    const { day_of_week, slot, subject, time_from, time_to, color } = req.body;
    if (day_of_week === undefined || !slot || !subject?.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'day_of_week, slot y subject son requeridos' } });
    }
    const { rows: [entry] } = await db.query(`
      INSERT INTO user_schedules (user_id, day_of_week, slot, subject, time_from, time_to, color)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (user_id, day_of_week, slot)
      DO UPDATE SET subject=$4, time_from=$5, time_to=$6, color=$7, updated_at=NOW()
      RETURNING *
    `, [req.user.id, day_of_week, slot, subject.trim(),
        time_from || null, time_to || null, color || '#3b82f6']);
    res.json({ ok: true, data: entry });
  } catch (e) {
    console.error('[schedules] PUT:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// DELETE /schedules/:id
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
