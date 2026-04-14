// src/routes/missions.js — version completa con misiones avanzadas
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db     = require('../config/db');
const auth   = require('../middleware/auth');
const roles  = require('../middleware/roles');
const ledger = require('../services/ledger');
const { getIO } = require('../socket');
const router = express.Router();

// Auto-migrate new columns
db.query(`ALTER TABLE missions ADD COLUMN IF NOT EXISTS imagen_url TEXT`)
  .catch(e => console.warn('[missions] migration imagen_url:', e.message));
db.query(`ALTER TABLE missions ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT '⚡'`)
  .catch(e => console.warn('[missions] migration icon:', e.message));
db.query(`ALTER TABLE missions ADD COLUMN IF NOT EXISTS auto_approve BOOLEAN DEFAULT FALSE`)
  .catch(e => console.warn('[missions] migration auto_approve:', e.message));
db.query(`ALTER TABLE missions ADD COLUMN IF NOT EXISTS reward_type TEXT DEFAULT 'monedas'`)
  .catch(e => console.warn('[missions] migration reward_type:', e.message));
db.query(`ALTER TABLE missions ADD COLUMN IF NOT EXISTS reward_extra JSONB`)
  .catch(e => console.warn('[missions] migration reward_extra:', e.message));
db.query(`ALTER TABLE missions ADD COLUMN IF NOT EXISTS fecha_inicio TIMESTAMPTZ`)
  .catch(e => console.warn('[missions] migration fecha_inicio:', e.message));
// Drop old tipo constraint and recreate with new tipos
db.query(`ALTER TABLE missions DROP CONSTRAINT IF EXISTS missions_tipo_check`)
  .then(() => db.query(`ALTER TABLE missions ADD CONSTRAINT missions_tipo_check CHECK (tipo IN ('normal','limitada','grupal','encadenada','rol','rapida'))`))
  .catch(e => console.warn('[missions] tipo constraint update:', e.message));

function notify(userId, payload) {
  try { const io=getIO(); if(io) io.to(`user:${userId}`).emit('notification',payload); } catch(e){}
}
async function saveNotif(client, userId, tipo, titulo, cuerpo, data={}) {
  try {
    await client.query(
      'INSERT INTO notifications (user_id,tipo,titulo,cuerpo,data) VALUES ($1,$2,$3,$4,$5)',
      [userId, tipo, titulo, cuerpo, JSON.stringify(data)]
    );
  } catch(e) {}
}

// GET /missions
router.get('/', auth, async (req, res) => {
  try {
    const tipo = req.query.tipo || null;
    const { rows } = await db.query(`
      SELECT m.*, u.nombre AS creador_nombre, u.rol AS creador_rol,
        ms.estado AS mi_estado, ms.id AS submission_id, ms.feedback AS mi_feedback,
        (SELECT COUNT(*) FROM mission_submissions ms2 WHERE ms2.mission_id=m.id AND ms2.estado='aprobada')::int AS total_completadas
      FROM missions m
      JOIN users u ON u.id=m.created_by
      LEFT JOIN mission_submissions ms ON ms.mission_id=m.id AND ms.student_id=$1
      WHERE m.activa=TRUE
        AND ($2::text IS NULL OR m.tipo=$2)
        AND (m.classroom_id IS NULL OR EXISTS(
          SELECT 1 FROM classroom_members cm WHERE cm.classroom_id=m.classroom_id AND cm.user_id=$1
        ))
        AND (m.prerequisite_id IS NULL OR EXISTS(
          SELECT 1 FROM mission_submissions pms WHERE pms.mission_id=m.prerequisite_id AND pms.student_id=$1 AND pms.estado='aprobada'
        ))
        AND (m.fecha_fin IS NULL OR m.fecha_fin > NOW() OR ms.estado='aprobada')
        AND (m.fecha_inicio IS NULL OR m.fecha_inicio <= NOW())
      ORDER BY CASE m.tipo WHEN 'limitada' THEN 0 WHEN 'grupal' THEN 1 ELSE 2 END, m.created_at DESC
    `, [req.user.id, tipo]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /missions/teacher
router.get('/teacher', auth, roles('teacher','admin'), async (req, res) => {
  try {
    const isAdmin = req.user.rol === 'admin';
    const { rows } = await db.query(`
      SELECT m.*, u.nombre AS creador_nombre, u.rol AS creador_rol,
        (SELECT COUNT(*) FROM mission_submissions ms WHERE ms.mission_id=m.id AND ms.estado='pendiente')::int AS pendientes,
        (SELECT COUNT(*) FROM mission_submissions ms WHERE ms.mission_id=m.id AND ms.estado='aprobada')::int  AS aprobadas,
        (SELECT COUNT(*) FROM mission_submissions ms WHERE ms.mission_id=m.id AND ms.estado='rechazada')::int AS rechazadas
      FROM missions m
      JOIN users u ON u.id = m.created_by
      WHERE ($1 OR m.created_by=$2)
      ORDER BY m.created_at DESC
    `, [isAdmin, req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /missions/classroom-students
router.get('/classroom-students', auth, roles('teacher','admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.nombre, u.email, u.skin, u.border, u.avatar_bg, u.foto_url, u.total_earned,
        COALESCE((SELECT SUM(le.amount) FROM ledger_entries le
           JOIN accounts a ON a.id=le.account_id
           WHERE a.user_id=u.id AND a.account_type IN ('student','teacher')),0)::integer AS balance,
        (SELECT COUNT(*) FROM mission_submissions ms WHERE ms.student_id=u.id AND ms.estado='aprobada')::int AS misiones_completadas,
        (SELECT COUNT(*) FROM daily_checkins dc WHERE dc.user_id=u.id)::int AS checkins_total,
        (SELECT racha FROM daily_checkins dc WHERE dc.user_id=u.id ORDER BY fecha DESC LIMIT 1) AS racha_actual
      FROM classroom_members cm
      JOIN users u ON u.id=cm.user_id
      WHERE cm.rol='student'
        AND (
          $1 IN (SELECT id FROM users WHERE id=$1 AND rol='admin')
          OR cm.classroom_id IN (SELECT classroom_id FROM classroom_members WHERE user_id=$1 AND rol='teacher')
        )
      ORDER BY u.nombre
    `, [req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /missions
router.post('/', auth, roles('teacher','admin'), async (req, res) => {
  try {
    const { titulo, descripcion, recompensa, dificultad,
            tipo='normal', fecha_fin=null, max_submissions=null,
            classroom_id=null, prerequisite_id=null, xp_bonus=0,
            imagen_url=null, icon='⚡', auto_approve=false,
            reward_type='monedas', reward_extra=null,
            fecha_inicio=null } = req.body;
    if (!titulo || !recompensa || !dificultad)
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS' } });
    const { rows } = await db.query(`
      INSERT INTO missions (id,titulo,descripcion,recompensa,dificultad,created_by,
        tipo,fecha_fin,max_submissions,classroom_id,prerequisite_id,xp_bonus,
        imagen_url,icon,auto_approve,reward_type,reward_extra,fecha_inicio)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *
    `, [uuidv4(),titulo,descripcion,recompensa,dificultad,req.user.id,
        tipo,fecha_fin,max_submissions,classroom_id,prerequisite_id,xp_bonus||0,
        imagen_url,icon||'⚡',auto_approve||false,reward_type||'monedas',
        reward_extra ? JSON.stringify(reward_extra) : null,
        fecha_inicio||null]);
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// PATCH /missions/:id
router.patch('/:id', auth, roles('teacher','admin'), async (req, res) => {
  try {
    const { titulo, descripcion, recompensa, activa, fecha_fin, fecha_inicio, icon, imagen_url, auto_approve, max_submissions } = req.body;
    const isAdmin = req.user.rol==='admin';
    const { rows } = await db.query(`
      UPDATE missions SET
        titulo=COALESCE($1,titulo), descripcion=COALESCE($2,descripcion),
        recompensa=COALESCE($3,recompensa), activa=COALESCE($4,activa), fecha_fin=COALESCE($5,fecha_fin),
        fecha_inicio=COALESCE($9,fecha_inicio), icon=COALESCE($10,icon),
        imagen_url=COALESCE($11,imagen_url), auto_approve=COALESCE($12,auto_approve),
        max_submissions=COALESCE($13,max_submissions)
      WHERE id=$6 AND (created_by=$7 OR $8) RETURNING *
    `, [titulo,descripcion,recompensa,activa,fecha_fin,req.params.id,req.user.id,isAdmin,
        fecha_inicio,icon,imagen_url,auto_approve,max_submissions]);
    if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// DELETE /missions/:id
router.delete('/:id', auth, roles('teacher','admin'), async (req, res) => {
  try {
    const isAdmin = req.user.rol === 'admin';
    const { rows } = await db.query(
      'DELETE FROM missions WHERE id=$1 AND (created_by=$2 OR $3) RETURNING id',
      [req.params.id, req.user.id, isAdmin]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    res.json({ ok: true, data: { id: rows[0].id } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /missions/:id/submit
router.post('/:id/submit', auth, roles('student'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { comentario } = req.body;
    const { rows: mRows } = await client.query('SELECT * FROM missions WHERE id=$1 AND activa=TRUE',[req.params.id]);
    if (!mRows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    const mission = mRows[0];
    if (mission.fecha_fin && new Date(mission.fecha_fin) < new Date())
      return res.status(400).json({ ok: false, error: { code: 'EXPIRED', message: 'Esta mision ya vencio' } });
    const { rows: ex } = await client.query(
      "SELECT id FROM mission_submissions WHERE mission_id=$1 AND student_id=$2 AND estado!='rechazada'",
      [req.params.id, req.user.id]
    );
    if (ex.length) return res.status(422).json({ ok: false, error: { code: 'DUPLICATE_SUBMISSION' } });
    if (mission.max_submissions) {
      const { rows: cRows } = await client.query(
        "SELECT COUNT(*) FROM mission_submissions WHERE mission_id=$1 AND estado='aprobada'",[req.params.id]);
      if (parseInt(cRows[0].count) >= mission.max_submissions)
        return res.status(400).json({ ok: false, error: { code: 'FULL', message: 'Cupo lleno' } });
    }

    if (mission.auto_approve) {
      // Auto-approve: reward immediately
      await client.query('BEGIN');
      const txId = await ledger.reward({
        teacherId: mission.created_by, studentId: req.user.id,
        amount: mission.recompensa,
        description: `Mision completada: ${mission.titulo}`,
        meta: { referenceId: mission.id, referenceType: 'mission' },
      });
      const { rows } = await client.query(
        "INSERT INTO mission_submissions (id,mission_id,student_id,estado,feedback,reviewed_at,reviewed_by,transaction_id) VALUES ($1,$2,$3,'aprobada','¡Completada!',$4,$5,$6) RETURNING *",
        [uuidv4(), req.params.id, req.user.id, new Date(), mission.created_by, txId]
      );
      await client.query('COMMIT');
      notify(req.user.id, { type:'reward', amount:mission.recompensa, description:`Mision completada: ${mission.titulo}` });
      return res.status(201).json({ ok: true, data: rows[0] });
    }

    // Normal submission
    const { rows } = await client.query(
      "INSERT INTO mission_submissions (id,mission_id,student_id,estado,feedback) VALUES ($1,$2,$3,'pendiente',$4) RETURNING *",
      [uuidv4(), req.params.id, req.user.id, comentario||null]
    );
    notify(mission.created_by, { type:'new_submission', alumno:req.user.nombre, mision:mission.titulo });
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// GET /missions/submissions
router.get('/submissions', auth, roles('teacher','admin'), async (req, res) => {
  try {
    const estado=req.query.estado||'pendiente';
    const isAdmin=req.user.rol==='admin';
    const { rows } = await db.query(`
      SELECT ms.*, m.titulo, m.recompensa, m.tipo, m.dificultad,
             u.nombre AS alumno_nombre, u.skin, u.border, u.avatar_bg, u.foto_url
      FROM mission_submissions ms
      JOIN missions m ON ms.mission_id=m.id JOIN users u ON ms.student_id=u.id
      WHERE ms.estado=$1 AND ($2 OR m.created_by=$3) ORDER BY ms.submitted_at DESC
    `, [estado, isAdmin, req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /missions/submissions/:id/approve
router.post('/submissions/:id/approve', auth, roles('teacher','admin'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { feedback } = req.body;
    const { rows: sRows } = await client.query(`
      SELECT ms.*, m.recompensa, m.titulo, m.xp_bonus, m.created_by
      FROM mission_submissions ms JOIN missions m ON ms.mission_id=m.id WHERE ms.id=$1
    `, [req.params.id]);
    if (!sRows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    const sub = sRows[0];
    if (req.user.rol==='teacher' && sub.created_by!==req.user.id)
      return res.status(403).json({ ok: false, error: { code: 'UNAUTHORIZED' } });
    if (sub.estado!=='pendiente')
      return res.status(422).json({ ok: false, error: { code: 'INVALID_STATE' } });
    await client.query('BEGIN');
    const txId = await ledger.reward({
      teacherId: req.user.id, studentId: sub.student_id,
      amount: sub.recompensa, description: `Mision completada: ${sub.titulo}`,
      meta: { referenceId: sub.mission_id, referenceType: 'mission' },
    });
    await client.query(
      "UPDATE mission_submissions SET estado='aprobada',reviewed_at=NOW(),reviewed_by=$1,transaction_id=$2,feedback=$3 WHERE id=$4",
      [req.user.id, txId, feedback||null, req.params.id]
    );
    await saveNotif(client, sub.student_id, 'mission_approved',
      `Mision aprobada: ${sub.titulo}`, feedback||`Recibiste ${sub.recompensa} monedas`,
      { recompensa: sub.recompensa, feedback }
    );
    await client.query('COMMIT');
    notify(sub.student_id, { type:'mission_approved', mision:sub.titulo, amount:sub.recompensa, feedback });
    res.json({ ok: true, data: { message: 'Aprobada', transaction_id: txId } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.code==='BUDGET_EXCEEDED'?422:500).json({ ok: false, error: { code: err.code||'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// POST /missions/submissions/:id/reject
router.post('/submissions/:id/reject', auth, roles('teacher','admin'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { reason, feedback } = req.body;
    const fb = feedback||reason;
    if (!fb) return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS' } });
    const { rows: sRows } = await client.query(
      'SELECT ms.student_id, m.titulo FROM mission_submissions ms JOIN missions m ON ms.mission_id=m.id WHERE ms.id=$1',
      [req.params.id]
    );
    await client.query('BEGIN');
    await client.query(
      "UPDATE mission_submissions SET estado='rechazada',reviewed_at=NOW(),reviewed_by=$1,feedback=$2 WHERE id=$3",
      [req.user.id, fb, req.params.id]
    );
    if (sRows.length) {
      await saveNotif(client, sRows[0].student_id, 'mission_rejected',
        `Mision necesita mejoras: ${sRows[0].titulo}`, fb, { feedback: fb });
    }
    await client.query('COMMIT');
    if (sRows.length) notify(sRows[0].student_id, { type:'mission_rejected', mision:sRows[0].titulo, feedback:fb });
    res.json({ ok: true, data: { message: 'Rechazada' } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// POST /missions/reward-direct
router.post('/reward-direct', auth, roles('teacher','admin'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { student_id, amount, descripcion } = req.body;
    if (!student_id || !amount || amount<=0)
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS' } });
    await client.query('BEGIN');
    const txId = await ledger.reward({
      teacherId: req.user.id, studentId: student_id,
      amount: parseInt(amount),
      description: descripcion || `Premio directo de ${req.user.nombre}`,
    });
    await client.query('COMMIT');
    notify(student_id, { type:'reward', amount:parseInt(amount), description:descripcion||`Premio de ${req.user.nombre}`, from:req.user.nombre });
    res.json({ ok: true, data: { transaction_id: txId } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(err.code==='BUDGET_EXCEEDED'?422:500).json({ ok: false, error: { code: err.code||'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// POST /missions/:id/reward-all — approve all pending submissions at once
router.post('/:id/reward-all', auth, roles('teacher','admin'), async (req, res) => {
  const client = await db.getClient();
  try {
    const isAdmin = req.user.rol === 'admin';
    const { rows: mRows } = await client.query('SELECT * FROM missions WHERE id=$1', [req.params.id]);
    if (!mRows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    const mission = mRows[0];
    if (!isAdmin && mission.created_by !== req.user.id)
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } });

    const { rows: pending } = await client.query(
      "SELECT ms.*, u.nombre AS alumno_nombre FROM mission_submissions ms JOIN users u ON u.id=ms.student_id WHERE ms.mission_id=$1 AND ms.estado='pendiente'",
      [req.params.id]
    );
    if (!pending.length) return res.json({ ok: true, data: { count: 0 } });

    await client.query('BEGIN');
    let count = 0;
    for (const sub of pending) {
      try {
        const txId = await ledger.reward({
          teacherId: req.user.id, studentId: sub.student_id,
          amount: mission.recompensa,
          description: `Mision completada: ${mission.titulo}`,
          meta: { referenceId: mission.id, referenceType: 'mission' },
        });
        await client.query(
          "UPDATE mission_submissions SET estado='aprobada',reviewed_at=NOW(),reviewed_by=$1,transaction_id=$2 WHERE id=$3",
          [req.user.id, txId, sub.id]
        );
        notify(sub.student_id, { type:'reward', amount:mission.recompensa, description:`Mision aprobada: ${mission.titulo}` });
        count++;
      } catch(e) { /* skip if budget exceeded */ }
    }
    await client.query('COMMIT');
    res.json({ ok: true, data: { count } });
  } catch(err) {
    await client.query('ROLLBACK').catch(()=>{});
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

module.exports = router;
