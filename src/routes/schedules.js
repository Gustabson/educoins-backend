// src/routes/schedules.js — Weekly school schedule per user
// One active turno (manana/tarde/noche/extra) + N subjects per day within that turno.
//
// GET    /schedules        → all entries for the logged-in user
// POST   /schedules        → create one entry
// PATCH  /schedules/:id    → update one entry
// DELETE /schedules/:id    → remove one entry
// GET    /schedules/prefs  → UI preferences (view mode, turno order)
// PATCH  /schedules/prefs  → save UI preferences

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

// Auto-migrate
db.query(`DROP TABLE IF EXISTS user_schedules`)
  .then(() => db.query(`
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
  `))
  .catch(e => console.warn('[schedules] migration:', e.message));

// Add ui_prefs column to users for storing schedule view preferences
db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_prefs JSONB DEFAULT '{}'::jsonb`)
  .catch(e => console.warn('[schedules] ui_prefs migration:', e.message));

// ── GET /prefs ────────────────────────────────────────────────
router.get('/prefs', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT ui_prefs FROM users WHERE id=$1', [req.user.id]
    );
    res.json({ ok: true, data: rows[0]?.ui_prefs || {} });
  } catch (e) {
    console.error('[schedules] GET prefs:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── PATCH /prefs ──────────────────────────────────────────────
router.patch('/prefs', auth, async (req, res) => {
  try {
    const allowed = ['sch_view', 'sch_turno_order', 'sch_periods', 'sch_locked',
                     'sch_show_sat', 'sch_show_dom', 'sch_grid_rotated', 'sch_grid_css_angle'];
    const patch = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'Sin campos para actualizar' } });
    }
    const { rows } = await db.query(`
      UPDATE users
      SET ui_prefs = COALESCE(ui_prefs, '{}'::jsonb) || $1::jsonb
      WHERE id=$2
      RETURNING ui_prefs
    `, [JSON.stringify(patch), req.user.id]);
    res.json({ ok: true, data: rows[0]?.ui_prefs || {} });
  } catch (e) {
    console.error('[schedules] PATCH prefs:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

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

// ── DELETE /by-period — remove all entries for a turno+time ──
router.delete('/by-period', auth, async (req, res) => {
  try {
    const { turno, time_from } = req.body;
    if (!turno || !time_from) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'turno y time_from son requeridos' } });
    }
    await db.query(
      'DELETE FROM user_schedules WHERE user_id=$1 AND turno=$2 AND time_from=$3',
      [req.user.id, turno, time_from]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[schedules] DELETE by-period:', e);
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
