// src/routes/peer-eval.js
// Group formation, peer evaluation, cooperation ranking
// Mounted at /api/v1/peer-eval

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db     = require('../config/db');
const auth   = require('../middleware/auth');
const roles  = require('../middleware/roles');
const ledger = require('../services/ledger');
const { getIO } = require('../socket');
const router = express.Router();

// ── Startup migrations ──────────────────────────────────────────

// New columns on missions for group config
db.query(`ALTER TABLE missions ADD COLUMN IF NOT EXISTS grupo_min_size INTEGER DEFAULT 2`)
  .catch(e => console.warn('[peer-eval] migration grupo_min_size:', e.message));
db.query(`ALTER TABLE missions ADD COLUMN IF NOT EXISTS grupo_max_size INTEGER DEFAULT 2`)
  .catch(e => console.warn('[peer-eval] migration grupo_max_size:', e.message));
db.query(`ALTER TABLE missions ADD COLUMN IF NOT EXISTS requires_peer_eval BOOLEAN DEFAULT FALSE`)
  .catch(e => console.warn('[peer-eval] migration requires_peer_eval:', e.message));

// mission_groups — one per team per mission
db.query(`
  CREATE TABLE IF NOT EXISTS mission_groups (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mission_id    UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    submission_id UUID,
    created_by    UUID NOT NULL REFERENCES users(id),
    status        TEXT NOT NULL DEFAULT 'forming',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT mission_groups_status_check CHECK (status IN ('forming','ready','submitted','approved','rejected'))
  )
`).then(() => {
  db.query(`CREATE INDEX IF NOT EXISTS idx_mgroups_mission ON mission_groups(mission_id)`).catch(()=>{});
}).catch(e => console.warn('[peer-eval] mission_groups:', e.message));

// mission_group_members
db.query(`
  CREATE TABLE IF NOT EXISTS mission_group_members (
    group_id    UUID NOT NULL REFERENCES mission_groups(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    accepted    BOOLEAN DEFAULT FALSE,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
  )
`).then(() => {
  db.query(`CREATE INDEX IF NOT EXISTS idx_gmembers_user ON mission_group_members(user_id)`).catch(()=>{});
}).catch(e => console.warn('[peer-eval] mission_group_members:', e.message));

// peer_evaluations
db.query(`
  CREATE TABLE IF NOT EXISTS peer_evaluations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id      UUID NOT NULL REFERENCES mission_groups(id) ON DELETE CASCADE,
    mission_id    UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
    evaluator_id  UUID NOT NULL REFERENCES users(id),
    evaluatee_id  UUID NOT NULL REFERENCES users(id),
    rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment       TEXT,
    submitted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(group_id, evaluator_id, evaluatee_id)
  )
`).then(() => {
  db.query(`CREATE INDEX IF NOT EXISTS idx_peereval_evaluatee ON peer_evaluations(evaluatee_id)`).catch(()=>{});
  db.query(`CREATE INDEX IF NOT EXISTS idx_peereval_group ON peer_evaluations(group_id)`).catch(()=>{});
}).catch(e => console.warn('[peer-eval] peer_evaluations:', e.message));

// teacher_coop_observations — teacher rates student cooperation
db.query(`
  CREATE TABLE IF NOT EXISTS teacher_coop_observations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id  UUID NOT NULL REFERENCES users(id),
    student_id  UUID NOT NULL REFERENCES users(id),
    group_id    UUID REFERENCES mission_groups(id) ON DELETE SET NULL,
    mission_id  UUID REFERENCES missions(id) ON DELETE SET NULL,
    rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).then(() => {
  db.query(`CREATE INDEX IF NOT EXISTS idx_tcoop_student ON teacher_coop_observations(student_id)`).catch(()=>{});
}).catch(e => console.warn('[peer-eval] teacher_coop_observations:', e.message));

// coop_ranking_config — admin configures weekly cooperation rewards
db.query(`
  CREATE TABLE IF NOT EXISTS coop_ranking_config (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    posicion  INTEGER NOT NULL,
    premio    INTEGER NOT NULL DEFAULT 0,
    activo    BOOLEAN DEFAULT TRUE,
    UNIQUE(posicion)
  )
`).catch(e => console.warn('[peer-eval] coop_ranking_config:', e.message));

// coop_ranking_payouts — weekly payout history
db.query(`
  CREATE TABLE IF NOT EXISTS coop_ranking_payouts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    periodo_label   TEXT NOT NULL,
    user_id         UUID NOT NULL REFERENCES users(id),
    posicion        INTEGER NOT NULL,
    premio          INTEGER NOT NULL,
    transaction_id  UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).then(() => {
  db.query(`CREATE INDEX IF NOT EXISTS idx_coop_payouts_label ON coop_ranking_payouts(periodo_label)`).catch(()=>{});
}).catch(e => console.warn('[peer-eval] coop_ranking_payouts:', e.message));

// peer_eval_config — school hours, rotation rules, etc.
db.query(`
  CREATE TABLE IF NOT EXISTS peer_eval_config (
    id         SERIAL PRIMARY KEY,
    config     JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`).then(async () => {
  const { rows } = await db.query('SELECT id FROM peer_eval_config LIMIT 1');
  if (!rows.length) {
    await db.query('INSERT INTO peer_eval_config (config) VALUES ($1)', [JSON.stringify({
      school_hour_start: "07:00",
      school_hour_end:   "15:00",
      timezone:          "America/Argentina/Buenos_Aires",
      rotation_lookback: 5,
      history_months:    6,
    })]);
  }
}).catch(e => console.warn('[peer-eval] peer_eval_config:', e.message));

// ── Helpers ──────────────────────────────────────────────────────

function notify(userId, payload) {
  try { const io = getIO(); if (io) io.to(`user:${userId}`).emit('notification', payload); } catch(e){}
}

async function getPeerEvalConfig() {
  try {
    const { rows } = await db.query('SELECT config FROM peer_eval_config LIMIT 1');
    return rows[0]?.config || {};
  } catch { return {}; }
}

function isSchoolHours(cfg) {
  const tz = cfg.timezone || 'America/Argentina/Buenos_Aires';
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = timeStr.split(':').map(Number);
  const current = h * 60 + m;
  const [sh, sm] = (cfg.school_hour_start || "07:00").split(':').map(Number);
  const [eh, em] = (cfg.school_hour_end || "15:00").split(':').map(Number);
  return current >= (sh * 60 + sm) && current <= (eh * 60 + em);
}

// ══════════════════════════════════════════════════════════════════
// GROUP FORMATION
// ══════════════════════════════════════════════════════════════════

// GET /peer-eval/classmates?mission_id=X — available classmates for pairing
router.get('/classmates', auth, async (req, res) => {
  try {
    const { mission_id } = req.query;
    if (!mission_id) return res.status(400).json({ ok: false, error: { code: 'MISSING_MISSION_ID' } });

    // Helper: IDs already in a non-rejected group for this mission (only fully accepted groups)
    const { rows: busyRows } = await db.query(`
      SELECT DISTINCT mgm.user_id
      FROM mission_group_members mgm
      JOIN mission_groups mg ON mg.id = mgm.group_id
      WHERE mg.mission_id = $1
        AND mg.status IN ('ready','submitted','approved')
    `, [mission_id]);
    const busyIds = busyRows.map(r => r.user_id);

    // Try classroom-based first
    let { rows } = await db.query(`
      SELECT u.id, u.nombre, u.skin, u.border, u.avatar_bg, u.foto_url
      FROM classroom_members cm
      JOIN users u ON u.id = cm.user_id
      WHERE cm.classroom_id IN (
        SELECT classroom_id FROM classroom_members WHERE user_id = $1
      )
      AND u.id != $1
      AND u.rol = 'student'
      ORDER BY u.nombre
    `, [req.user.id]);

    // Fallback: show ALL students in the school (no classroom filter, no activo filter)
    if (!rows.length) {
      const { rows: fallback } = await db.query(`
        SELECT u.id, u.nombre, u.skin, u.border, u.avatar_bg, u.foto_url
        FROM users u
        WHERE u.id != $1
        AND u.rol = 'student'
        ORDER BY u.nombre
      `, [req.user.id]);
      rows = fallback;
    }

    // Remove students already in a completed/active group for this mission
    if (busyIds.length) {
      rows = rows.filter(u => !busyIds.includes(u.id));
    }

    // Check rotation: how many times paired with each in last N grupal missions
    const cfg = await getPeerEvalConfig();
    const lookback = cfg.rotation_lookback || 5;
    const { rows: history } = await db.query(`
      SELECT mgm2.user_id, COUNT(*)::int AS times_paired
      FROM mission_group_members mgm1
      JOIN mission_group_members mgm2 ON mgm1.group_id = mgm2.group_id AND mgm2.user_id != mgm1.user_id
      JOIN mission_groups mg ON mg.id = mgm1.group_id
      WHERE mgm1.user_id = $1
        AND mg.created_at > NOW() - INTERVAL '3 months'
      GROUP BY mgm2.user_id
    `, [req.user.id]);
    const pairCount = {};
    history.forEach(h => { pairCount[h.user_id] = h.times_paired; });

    const enriched = rows.map(u => ({
      ...u,
      times_paired: pairCount[u.id] || 0,
      rotation_warning: (pairCount[u.id] || 0) >= lookback,
    }));

    res.json({ ok: true, data: enriched });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /peer-eval/groups — create a group and invite partners
router.post('/groups', auth, async (req, res) => {
  const client = await db.getClient();
  try {
    const { mission_id, partner_ids } = req.body;
    if (!mission_id || !Array.isArray(partner_ids) || !partner_ids.length)
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS' } });

    // Validate mission is grupal
    const { rows: mRows } = await client.query('SELECT * FROM missions WHERE id=$1 AND activa=TRUE', [mission_id]);
    if (!mRows.length) return res.status(404).json({ ok: false, error: { code: 'MISSION_NOT_FOUND' } });
    const mission = mRows[0];
    if (mission.tipo !== 'grupal')
      return res.status(400).json({ ok: false, error: { code: 'NOT_GRUPAL', message: 'Solo misiones grupales permiten formar grupo' } });

    const totalSize = partner_ids.length + 1; // +1 for creator
    const minSize = mission.grupo_min_size || 2;
    const maxSize = mission.grupo_max_size || 2;
    if (totalSize < minSize || totalSize > maxSize)
      return res.status(400).json({ ok: false, error: { code: 'INVALID_SIZE', message: `El grupo debe tener entre ${minSize} y ${maxSize} miembros` } });

    // Check student not already in a group for this mission
    const { rows: existing } = await client.query(`
      SELECT mg.id FROM mission_group_members mgm
      JOIN mission_groups mg ON mg.id = mgm.group_id
      WHERE mgm.user_id = $1 AND mg.mission_id = $2 AND mg.status NOT IN ('rejected')
    `, [req.user.id, mission_id]);
    if (existing.length)
      return res.status(422).json({ ok: false, error: { code: 'ALREADY_IN_GROUP', message: 'Ya estás en un grupo para esta mision' } });

    // Check rotation
    const cfg = await getPeerEvalConfig();
    const lookback = cfg.rotation_lookback || 5;
    for (const pid of partner_ids) {
      const { rows: rot } = await client.query(`
        SELECT COUNT(*)::int AS cnt FROM mission_group_members mgm1
        JOIN mission_group_members mgm2 ON mgm1.group_id = mgm2.group_id AND mgm2.user_id = $2
        JOIN mission_groups mg ON mg.id = mgm1.group_id
        WHERE mgm1.user_id = $1 AND mg.created_at > NOW() - INTERVAL '3 months'
      `, [req.user.id, pid]);
      if (rot[0]?.cnt >= lookback)
        return res.status(400).json({ ok: false, error: { code: 'ROTATION_BLOCKED', message: 'Trabajaste con este compañero demasiadas veces seguidas. Elegí otro.' } });
    }

    await client.query('BEGIN');
    const groupId = uuidv4();
    const isReady = partner_ids.length === 0; // solo creator = ready (only if minSize=1)
    await client.query(
      'INSERT INTO mission_groups (id, mission_id, created_by, status) VALUES ($1,$2,$3,$4)',
      [groupId, mission_id, req.user.id, totalSize <= 1 ? 'ready' : 'forming']
    );

    // Add creator (auto-accepted)
    await client.query(
      'INSERT INTO mission_group_members (group_id, user_id, accepted) VALUES ($1,$2,TRUE)',
      [groupId, req.user.id]
    );

    // Add partners (pending acceptance)
    for (const pid of partner_ids) {
      await client.query(
        'INSERT INTO mission_group_members (group_id, user_id, accepted) VALUES ($1,$2,FALSE)',
        [groupId, pid]
      );
      notify(pid, {
        type: 'group_invite',
        group_id: groupId,
        mission_id,
        from: req.user.nombre,
        mision: mission.titulo,
        message: `${req.user.nombre} te invitó a hacer "${mission.titulo}" juntos`,
      });
    }
    await client.query('COMMIT');

    res.status(201).json({ ok: true, data: { id: groupId, status: 'forming' } });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// POST /peer-eval/groups/:id/accept — accept invitation
router.post('/groups/:id/accept', auth, async (req, res) => {
  const client = await db.getClient();
  try {
    const gid = req.params.id;
    const { rows: mem } = await client.query(
      'SELECT * FROM mission_group_members WHERE group_id=$1 AND user_id=$2', [gid, req.user.id]
    );
    if (!mem.length) return res.status(404).json({ ok: false, error: { code: 'NOT_MEMBER' } });
    if (mem[0].accepted) return res.json({ ok: true, data: { already: true } });

    await client.query('BEGIN');
    await client.query(
      'UPDATE mission_group_members SET accepted=TRUE WHERE group_id=$1 AND user_id=$2',
      [gid, req.user.id]
    );

    // Check if all members accepted → set status to ready
    const { rows: pending } = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM mission_group_members WHERE group_id=$1 AND accepted=FALSE',
      [gid]
    );
    if (pending[0].cnt === 0) {
      await client.query("UPDATE mission_groups SET status='ready' WHERE id=$1", [gid]);
    }
    await client.query('COMMIT');

    // Notify group creator
    const { rows: grp } = await db.query('SELECT created_by, mission_id FROM mission_groups WHERE id=$1', [gid]);
    if (grp.length) {
      notify(grp[0].created_by, {
        type: 'group_accepted',
        group_id: gid,
        from: req.user.nombre,
        message: `${req.user.nombre} aceptó unirse al grupo`,
      });
    }

    res.json({ ok: true, data: { accepted: true, all_ready: pending[0].cnt === 0 } });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// POST /peer-eval/groups/:id/leave — decline/leave group
router.post('/groups/:id/leave', auth, async (req, res) => {
  const client = await db.getClient();
  try {
    const gid = req.params.id;
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM mission_group_members WHERE group_id=$1 AND user_id=$2', [gid, req.user.id]
    );
    // Check if group is now empty or below min size → disband
    const { rows: remaining } = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM mission_group_members WHERE group_id=$1', [gid]
    );
    if (remaining[0].cnt === 0) {
      await client.query('DELETE FROM mission_groups WHERE id=$1', [gid]);
    } else {
      // Set back to forming if was ready
      await client.query("UPDATE mission_groups SET status='forming' WHERE id=$1 AND status='ready'", [gid]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// GET /peer-eval/groups/mine — my groups (active)
router.get('/groups/mine', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT mg.id, mg.mission_id, mg.status, mg.created_at, mg.created_by,
             m.titulo AS mision_titulo, m.recompensa, m.requires_peer_eval,
             json_agg(json_build_object(
               'user_id', u.id, 'nombre', u.nombre, 'skin', u.skin,
               'border', u.border, 'avatar_bg', u.avatar_bg, 'accepted', mgm.accepted
             )) AS members
      FROM mission_group_members mgm
      JOIN mission_groups mg ON mg.id = mgm.group_id
      JOIN missions m ON m.id = mg.mission_id
      JOIN mission_group_members mgm2 ON mgm2.group_id = mg.id
      JOIN users u ON u.id = mgm2.user_id
      WHERE mgm.user_id = $1 AND mg.status NOT IN ('rejected')
      GROUP BY mg.id, m.titulo, m.recompensa, m.requires_peer_eval
      ORDER BY mg.created_at DESC
    `, [req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════════
// PEER EVALUATION
// ══════════════════════════════════════════════════════════════════

// GET /peer-eval/pending — missions where I need to evaluate teammates
router.get('/pending', auth, async (req, res) => {
  try {
    // Find groups I'm in that are approved + require peer eval + I haven't evaluated yet
    const { rows } = await db.query(`
      SELECT mg.id AS group_id, mg.mission_id, m.titulo AS mision_titulo,
             json_agg(json_build_object(
               'user_id', u.id, 'nombre', u.nombre, 'skin', u.skin,
               'border', u.border, 'avatar_bg', u.avatar_bg
             )) FILTER (WHERE u.id != $1) AS teammates
      FROM mission_group_members mgm
      JOIN mission_groups mg ON mg.id = mgm.group_id
      JOIN missions m ON m.id = mg.mission_id
      JOIN mission_group_members mgm2 ON mgm2.group_id = mg.id AND mgm2.user_id != $1
      JOIN users u ON u.id = mgm2.user_id
      WHERE mgm.user_id = $1
        AND mg.status = 'approved'
        AND m.requires_peer_eval = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM peer_evaluations pe
          WHERE pe.group_id = mg.id AND pe.evaluator_id = $1
        )
      GROUP BY mg.id, mg.mission_id, m.titulo
    `, [req.user.id]);

    // Check school hours
    const cfg = await getPeerEvalConfig();
    const inSchool = isSchoolHours(cfg);

    res.json({ ok: true, data: rows, school_hours: inSchool });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /peer-eval/evaluate — submit peer evaluations for a group
router.post('/evaluate', auth, async (req, res) => {
  const client = await db.getClient();
  try {
    const { group_id, evaluations } = req.body;
    // evaluations: [{ evaluatee_id, rating, comment? }]
    if (!group_id || !Array.isArray(evaluations) || !evaluations.length)
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS' } });

    // School hours check
    const cfg = await getPeerEvalConfig();
    if (isSchoolHours(cfg))
      return res.status(403).json({ ok: false, error: { code: 'SCHOOL_HOURS', message: 'Las evaluaciones solo se pueden hacer fuera del horario escolar' } });

    // Validate group membership
    const { rows: mem } = await client.query(
      'SELECT * FROM mission_group_members WHERE group_id=$1 AND user_id=$2',
      [group_id, req.user.id]
    );
    if (!mem.length) return res.status(403).json({ ok: false, error: { code: 'NOT_MEMBER' } });

    // Validate group is approved
    const { rows: grp } = await client.query(
      "SELECT * FROM mission_groups WHERE id=$1 AND status='approved'", [group_id]
    );
    if (!grp.length) return res.status(400).json({ ok: false, error: { code: 'NOT_APPROVED', message: 'El grupo aun no fue aprobado' } });

    // Check not already evaluated
    const { rows: existing } = await client.query(
      'SELECT id FROM peer_evaluations WHERE group_id=$1 AND evaluator_id=$2', [group_id, req.user.id]
    );
    if (existing.length) return res.status(422).json({ ok: false, error: { code: 'ALREADY_EVALUATED' } });

    await client.query('BEGIN');
    for (const ev of evaluations) {
      if (!ev.evaluatee_id || !ev.rating || ev.rating < 1 || ev.rating > 5) continue;
      // Verify evaluatee is in the group
      const { rows: isMem } = await client.query(
        'SELECT 1 FROM mission_group_members WHERE group_id=$1 AND user_id=$2',
        [group_id, ev.evaluatee_id]
      );
      if (!isMem.length) continue;
      await client.query(
        `INSERT INTO peer_evaluations (id, group_id, mission_id, evaluator_id, evaluatee_id, rating, comment)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [uuidv4(), group_id, grp[0].mission_id, req.user.id, ev.evaluatee_id, ev.rating, ev.comment || null]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// ══════════════════════════════════════════════════════════════════
// TEACHER / ADMIN DASHBOARD
// ══════════════════════════════════════════════════════════════════

// GET /peer-eval/dashboard — cooperation ranking (teacher/admin only)
router.get('/dashboard', auth, roles('teacher', 'admin'), async (req, res) => {
  try {
    const { classroom_id } = req.query;
    const cfg = await getPeerEvalConfig();
    const months = cfg.history_months || 6;

    // Calculate weighted avg for each student from peer evaluations (last N months)
    let query = `
      SELECT u.id, u.nombre, u.skin, u.border, u.avatar_bg, u.foto_url,
             ROUND(AVG(pe.rating)::numeric, 2) AS avg_rating,
             COUNT(pe.id)::int AS total_evals,
             ROUND(AVG(CASE WHEN pe.submitted_at > NOW() - INTERVAL '30 days' THEN pe.rating END)::numeric, 2) AS recent_avg_30d,
             ROUND(AVG(CASE WHEN pe.submitted_at > NOW() - INTERVAL '90 days' THEN pe.rating END)::numeric, 2) AS recent_avg_90d
      FROM peer_evaluations pe
      JOIN users u ON u.id = pe.evaluatee_id
      WHERE pe.submitted_at > NOW() - ($1::text || ' months')::INTERVAL
        AND u.activo = TRUE
    `;
    const params = [months];

    if (classroom_id) {
      params.push(classroom_id);
      query += ` AND u.id IN (SELECT user_id FROM classroom_members WHERE classroom_id = $${params.length})`;
    }

    query += ` GROUP BY u.id ORDER BY avg_rating DESC, total_evals DESC`;

    const { rows } = await db.query(query, params);

    // Compute trend for each
    const enriched = rows.map(r => {
      let trend = 'stable';
      if (r.recent_avg_30d && r.recent_avg_90d) {
        const diff = parseFloat(r.recent_avg_30d) - parseFloat(r.recent_avg_90d);
        if (diff > 0.3) trend = 'improving';
        else if (diff < -0.3) trend = 'declining';
      }
      return { ...r, trend };
    });

    res.json({ ok: true, data: enriched });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /peer-eval/student/:id — detailed cooperation profile (teacher/admin)
router.get('/student/:id', auth, roles('teacher', 'admin'), async (req, res) => {
  try {
    const sid = req.params.id;
    const cfg = await getPeerEvalConfig();
    const months = cfg.history_months || 6;

    // All evaluations received (anonymized — no evaluator identity)
    const { rows: evals } = await db.query(`
      SELECT pe.rating, pe.comment, pe.submitted_at, m.titulo AS mision_titulo
      FROM peer_evaluations pe
      JOIN missions m ON m.id = pe.mission_id
      WHERE pe.evaluatee_id = $1
        AND pe.submitted_at > NOW() - ($2::text || ' months')::INTERVAL
      ORDER BY pe.submitted_at DESC
    `, [sid, months]);

    // Teacher observations
    const { rows: observations } = await db.query(`
      SELECT tco.rating, tco.note, tco.created_at, u.nombre AS teacher_name, m.titulo AS mision_titulo
      FROM teacher_coop_observations tco
      JOIN users u ON u.id = tco.teacher_id
      LEFT JOIN missions m ON m.id = tco.mission_id
      WHERE tco.student_id = $1
      ORDER BY tco.created_at DESC LIMIT 20
    `, [sid]);

    // Summary stats
    const { rows: stats } = await db.query(`
      SELECT
        ROUND(AVG(rating)::numeric, 2) AS avg_rating,
        COUNT(*)::int AS total_evals,
        ROUND(AVG(CASE WHEN submitted_at > NOW() - INTERVAL '30 days' THEN rating END)::numeric, 2) AS avg_30d,
        MIN(rating) AS min_rating,
        MAX(rating) AS max_rating
      FROM peer_evaluations
      WHERE evaluatee_id = $1 AND submitted_at > NOW() - ($2::text || ' months')::INTERVAL
    `, [sid, months]);

    // Groups this student was in
    const { rows: groups } = await db.query(`
      SELECT mg.id, mg.mission_id, mg.status, m.titulo AS mision_titulo,
             json_agg(json_build_object('nombre', u.nombre, 'user_id', u.id)) AS members
      FROM mission_group_members mgm
      JOIN mission_groups mg ON mg.id = mgm.group_id
      JOIN missions m ON m.id = mg.mission_id
      JOIN mission_group_members mgm2 ON mgm2.group_id = mg.id
      JOIN users u ON u.id = mgm2.user_id
      WHERE mgm.user_id = $1 AND mg.created_at > NOW() - ($2::text || ' months')::INTERVAL
      GROUP BY mg.id, m.titulo
      ORDER BY mg.created_at DESC LIMIT 20
    `, [sid, months]);

    res.json({ ok: true, data: {
      evaluations: evals,
      observations,
      stats: stats[0] || {},
      groups,
    }});
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /peer-eval/teacher-observation — teacher rates a student's cooperation
router.post('/teacher-observation', auth, roles('teacher', 'admin'), async (req, res) => {
  try {
    const { student_id, group_id, mission_id, rating, note } = req.body;
    if (!student_id || !rating || rating < 1 || rating > 5)
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS' } });
    await db.query(
      `INSERT INTO teacher_coop_observations (id, teacher_id, student_id, group_id, mission_id, rating, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuidv4(), req.user.id, student_id, group_id || null, mission_id || null, rating, note || null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /peer-eval/triangulation — compare peer ratings vs teacher observations (teacher/admin)
router.get('/triangulation', auth, roles('teacher', 'admin'), async (req, res) => {
  try {
    // Students where peer avg differs significantly from teacher avg
    const { rows } = await db.query(`
      SELECT u.id, u.nombre, u.skin, u.border, u.avatar_bg,
             ROUND(AVG(pe.rating)::numeric, 2) AS peer_avg,
             ROUND(AVG(tco.rating)::numeric, 2) AS teacher_avg,
             COUNT(DISTINCT pe.id)::int AS peer_count,
             COUNT(DISTINCT tco.id)::int AS teacher_count,
             ABS(AVG(pe.rating) - AVG(tco.rating)) AS discrepancy
      FROM users u
      LEFT JOIN peer_evaluations pe ON pe.evaluatee_id = u.id AND pe.submitted_at > NOW() - INTERVAL '6 months'
      LEFT JOIN teacher_coop_observations tco ON tco.student_id = u.id AND tco.created_at > NOW() - INTERVAL '6 months'
      WHERE u.rol = 'student' AND u.activo = TRUE
        AND (pe.id IS NOT NULL OR tco.id IS NOT NULL)
      GROUP BY u.id
      HAVING COUNT(DISTINCT pe.id) >= 2 AND COUNT(DISTINCT tco.id) >= 1
      ORDER BY ABS(AVG(pe.rating) - AVG(tco.rating)) DESC NULLS LAST
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════════
// COOPERATION RANKING CONFIG & PAYOUTS
// ══════════════════════════════════════════════════════════════════

// GET /peer-eval/ranking/config — get cooperation ranking config
router.get('/ranking/config', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM coop_ranking_config ORDER BY posicion');
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /peer-eval/ranking/config — create/update position config
router.post('/ranking/config', auth, roles('admin'), async (req, res) => {
  try {
    const { posicion, premio, activo } = req.body;
    if (!posicion || premio == null)
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS' } });
    const { rows } = await db.query(`
      INSERT INTO coop_ranking_config (id, posicion, premio, activo) VALUES ($1, $2, $3, $4)
      ON CONFLICT (posicion) DO UPDATE SET premio=$3, activo=$4
      RETURNING *
    `, [uuidv4(), posicion, premio, activo !== false]);
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /peer-eval/ranking/live — current cooperation ranking with prizes
router.get('/ranking/live', auth, roles('teacher', 'admin'), async (req, res) => {
  try {
    const cfg = await getPeerEvalConfig();
    const months = cfg.history_months || 6;

    // Get current ISO week label
    const now = new Date();
    const oneJan = new Date(now.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((now - oneJan) / 86400000 + oneJan.getDay() + 1) / 7);
    const periodoLabel = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;

    // Check if already paid
    const { rows: paid } = await db.query(
      'SELECT id FROM coop_ranking_payouts WHERE periodo_label=$1 LIMIT 1', [periodoLabel]
    );

    // Build ranking from peer evaluations
    const { rows: ranking } = await db.query(`
      SELECT u.id, u.nombre, u.skin, u.border, u.avatar_bg, u.foto_url,
             ROUND(AVG(pe.rating)::numeric, 2) AS avg_rating,
             COUNT(pe.id)::int AS total_evals
      FROM peer_evaluations pe
      JOIN users u ON u.id = pe.evaluatee_id
      WHERE pe.submitted_at > NOW() - ($1::text || ' months')::INTERVAL
        AND u.activo = TRUE
      GROUP BY u.id
      HAVING COUNT(pe.id) >= 2
      ORDER BY AVG(pe.rating) DESC, COUNT(pe.id) DESC
      LIMIT 20
    `, [months]);

    // Get prize config
    const { rows: prizes } = await db.query(
      'SELECT posicion, premio FROM coop_ranking_config WHERE activo=TRUE ORDER BY posicion'
    );
    const prizeMap = {};
    prizes.forEach(p => { prizeMap[p.posicion] = p.premio; });

    const enriched = ranking.map((r, i) => ({
      ...r,
      posicion: i + 1,
      premio: prizeMap[i + 1] || 0,
    }));

    res.json({ ok: true, data: enriched, periodo_label: periodoLabel, already_paid: paid.length > 0 });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /peer-eval/ranking/close — close week and pay cooperation rewards
router.post('/ranking/close', auth, roles('admin'), async (req, res) => {
  const client = await db.getClient();
  try {
    const cfg = await getPeerEvalConfig();
    const months = cfg.history_months || 6;

    const now = new Date();
    const oneJan = new Date(now.getFullYear(), 0, 1);
    const weekNum = Math.ceil(((now - oneJan) / 86400000 + oneJan.getDay() + 1) / 7);
    const periodoLabel = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;

    // Check not already paid
    const { rows: paid } = await client.query(
      'SELECT id FROM coop_ranking_payouts WHERE periodo_label=$1 LIMIT 1', [periodoLabel]
    );
    if (paid.length)
      return res.status(422).json({ ok: false, error: { code: 'ALREADY_PAID', message: `Semana ${periodoLabel} ya fue pagada` } });

    // Build ranking
    const { rows: ranking } = await client.query(`
      SELECT u.id, u.nombre,
             ROUND(AVG(pe.rating)::numeric, 2) AS avg_rating,
             COUNT(pe.id)::int AS total_evals
      FROM peer_evaluations pe
      JOIN users u ON u.id = pe.evaluatee_id
      WHERE pe.submitted_at > NOW() - ($1::text || ' months')::INTERVAL
        AND u.activo = TRUE
      GROUP BY u.id
      HAVING COUNT(pe.id) >= 2
      ORDER BY AVG(pe.rating) DESC, COUNT(pe.id) DESC
    `, [months]);

    // Get prize config
    const { rows: prizes } = await client.query(
      'SELECT posicion, premio FROM coop_ranking_config WHERE activo=TRUE ORDER BY posicion'
    );
    const prizeMap = {};
    prizes.forEach(p => { prizeMap[p.posicion] = p.premio; });

    await client.query('BEGIN');
    let count = 0;
    for (let i = 0; i < ranking.length; i++) {
      const pos = i + 1;
      const premio = prizeMap[pos];
      if (!premio || premio <= 0) continue;

      const student = ranking[i];
      try {
        const txId = await ledger.reward({
          teacherId: req.user.id,
          studentId: student.id,
          amount: premio,
          description: `Ranking cooperacion semana ${periodoLabel} — puesto #${pos}`,
          meta: { referenceType: 'coop_ranking', periodo: periodoLabel, posicion: pos },
        });
        await client.query(
          'INSERT INTO coop_ranking_payouts (id, periodo_label, user_id, posicion, premio, transaction_id) VALUES ($1,$2,$3,$4,$5,$6)',
          [uuidv4(), periodoLabel, student.id, pos, premio, txId]
        );
        notify(student.id, {
          type: 'coop_ranking_reward',
          amount: premio,
          posicion: pos,
          message: `🤝 Ranking de cooperacion: puesto #${pos} — +🪙${premio}`,
        });
        count++;
      } catch (e) { /* skip if budget exceeded */ }
    }
    await client.query('COMMIT');
    res.json({ ok: true, data: { count, periodo: periodoLabel } });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// GET /peer-eval/ranking/payouts — payout history
router.get('/ranking/payouts', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT crp.*, u.nombre
      FROM coop_ranking_payouts crp
      JOIN users u ON u.id = crp.user_id
      ORDER BY crp.created_at DESC LIMIT 100
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /peer-eval/config — get peer eval config
router.get('/config', auth, roles('teacher', 'admin'), async (req, res) => {
  try { res.json({ ok: true, data: await getPeerEvalConfig() }); }
  catch (err) { res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// PATCH /peer-eval/config — update config
router.patch('/config', auth, roles('admin'), async (req, res) => {
  try {
    const current = await getPeerEvalConfig();
    const updated = { ...current, ...req.body };
    await db.query(
      'UPDATE peer_eval_config SET config=$1, updated_at=NOW() WHERE id=(SELECT id FROM peer_eval_config LIMIT 1)',
      [JSON.stringify(updated)]
    );
    res.json({ ok: true, data: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;
