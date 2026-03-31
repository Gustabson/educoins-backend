// src/routes/polls.js — DAO weighted voting, inicio programado, snapshot automático
const express    = require('express');
const router     = express.Router();
const db         = require('../config/db');
const auth       = require('../middleware/auth');
const roles      = require('../middleware/roles');
const balanceSvc = require('../services/balance');

// ── Helper: tomar snapshot de la economía ─────────────────────
async function takeSnapshot(scope, classroom_id) {
  const { rows: c } = await db.query(`
    SELECT COALESCE(SUM(le.amount),0) AS total
    FROM ledger_entries le JOIN accounts a ON a.id=le.account_id
    WHERE a.account_type IN ('student','parent') AND a.is_active=TRUE
  `);
  let total_voters;
  if (scope === 'aula' && classroom_id) {
    const { rows } = await db.query(`
      SELECT COUNT(*)::int AS n FROM classroom_members cm
      JOIN users u ON u.id=cm.user_id WHERE cm.classroom_id=$1 AND u.rol='student'
    `, [classroom_id]);
    total_voters = parseInt(rows[0].n);
  } else {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM users WHERE rol IN ('student','parent') AND activo=TRUE`
    );
    total_voters = parseInt(rows[0].n);
  }
  return { total_coins: parseFloat(c[0].total), total_voters };
}

// ── Quórum ────────────────────────────────────────────────────
async function calculateQuorum(pollId, poll, options, qs) {
  if (!qs) return null;
  const { threshold, mode } = qs;
  const total_votos = options.reduce((s, o) => s + o.votos, 0);
  const total_peso  = options.reduce((s, o) => s + parseFloat(o.peso_total), 0);
  let eligible = 0;
  let current;

  if (mode === 'people') {
    current = total_votos;
    if (poll.scope === 'aula' && poll.classroom_id) {
      const { rows } = await db.query(`
        SELECT COUNT(*) AS n FROM classroom_members cm
        JOIN users u ON u.id=cm.user_id
        WHERE cm.classroom_id=$1 AND u.rol='student'
      `, [poll.classroom_id]);
      eligible = parseInt(rows[0].n);
    } else {
      const { rows } = await db.query(
        `SELECT COUNT(*) AS n FROM users WHERE rol IN ('student','parent') AND activo=TRUE`
      );
      eligible = parseInt(rows[0].n);
    }
  } else {
    // mode === 'coins'
    current = total_peso;
    if (poll.scope === 'aula' && poll.classroom_id) {
      const { rows } = await db.query(`
        SELECT COALESCE(SUM(le.amount), 0) AS total
        FROM ledger_entries le
        JOIN accounts a ON a.id=le.account_id
        JOIN classroom_members cm ON cm.user_id=a.user_id AND cm.classroom_id=$1
        WHERE a.account_type='student'
      `, [poll.classroom_id]);
      eligible = parseFloat(rows[0].total);
    } else {
      const { rows } = await db.query(`
        SELECT COALESCE(SUM(le.amount), 0) AS total
        FROM ledger_entries le
        JOIN accounts a ON a.id=le.account_id
        WHERE a.account_type IN ('student','parent') AND a.is_active=TRUE
      `);
      eligible = parseFloat(rows[0].total);
    }
  }

  const required = eligible * (parseFloat(threshold) / 100);
  const met = required > 0 && current >= required;
  const pct = eligible > 0 ? Math.min(Math.round(current / eligible * 100), 100) : 0;
  return { threshold: parseFloat(threshold), mode, eligible, current, required, met, pct };
}

async function enrichPoll(pollId, userId, quorumMap, userRole) {
  const { rows: poll } = await db.query(`
    SELECT p.id, p.titulo, p.activa, p.fin, p.created_at,
           p.scope, p.classroom_id, p.weighted,
           p.status, p.contexto, p.review_note,
           p.poll_number,
           p.snapshot_total_coins, p.snapshot_total_voters,
           p.inicio, p.approved_at,
           p.created_by AS creador_id,
           u.nombre AS creador_nombre, u.rol AS creador_rol
    FROM polls p JOIN users u ON u.id = p.created_by
    WHERE p.id = $1
  `, [pollId]);
  if (poll.length === 0) return null;

  const { rows: options } = await db.query(`
    SELECT po.id, po.texto, po.orden,
           COUNT(pv.id)::int AS votos,
           COALESCE(SUM(pv.peso), 0)::numeric AS peso_total
    FROM poll_options po LEFT JOIN poll_votes pv ON pv.option_id = po.id
    WHERE po.poll_id = $1 GROUP BY po.id ORDER BY po.orden
  `, [pollId]);

  const { rows: myVote } = await db.query(
    'SELECT option_id, peso FROM poll_votes WHERE poll_id=$1 AND user_id=$2', [pollId, userId]);

  const { rows: reacts } = await db.query(
    'SELECT tipo, COUNT(*)::int AS total FROM poll_reactions WHERE poll_id=$1 GROUP BY tipo', [pollId]);
  const { rows: myReact } = await db.query(
    'SELECT tipo FROM poll_reactions WHERE poll_id=$1 AND user_id=$2', [pollId, userId]);

  const { rows: cCount } = await db.query(
    'SELECT COUNT(*)::int AS total FROM poll_comments WHERE poll_id=$1 AND parent_id IS NULL', [pollId]);

  const reactions = { like: 0, dislike: 0 };
  reacts.forEach(r => { reactions[r.tipo] = r.total; });

  const total_peso = options.reduce((s, o) => s + parseFloat(o.peso_total), 0);

  // Si es weighted y el usuario no ha votado, calcular su poder actual
  let mi_poder = null;
  if (poll[0].weighted && !myVote[0]) {
    if (userRole === 'admin') {
      // Admin representa el 3% de las monedas en circulación al snapshot
      mi_poder = parseFloat(poll[0].snapshot_total_coins || 0) * 0.03;
    } else {
      try {
        const accountId = await balanceSvc.getAccountByUserId(userId);
        mi_poder = await balanceSvc.getBalance(accountId);
      } catch(e) { mi_poder = 0; }
    }
  }

  const total_votos = options.reduce((s, o) => s + o.votos, 0);
  const qs = quorumMap?.[poll[0].scope];
  const quorum = qs ? await calculateQuorum(pollId, poll[0], options, qs) : null;

  return {
    ...poll[0],
    opciones:          options,
    total_votos,
    total_peso,
    quorum,
    mi_voto:           myVote[0]?.option_id || null,
    mi_peso:           myVote[0]?.peso ? parseFloat(myVote[0].peso) : null,
    mi_poder,
    reactions,
    mi_reaccion:       myReact[0]?.tipo || null,
    total_comentarios: cCount[0].total,
  };
}

// GET /polls
router.get('/', auth, async (req, res) => {
  try {
    const scope  = req.query.scope  || null;
    const cid    = req.query.classroom_id || null;
    const status = req.query.status || 'active'; // 'active' | 'approved'
    const q      = req.query.q?.trim() || null;

    // Auto-cerrar polls expiradas
    await db.query(
      `UPDATE polls SET activa=FALSE WHERE activa=TRUE AND fin IS NOT NULL AND fin < NOW()`
    );

    // Auto-abrir polls programadas cuyo inicio ya llegó (y tomar snapshot)
    const { rows: toOpen } = await db.query(`
      SELECT id, scope, classroom_id FROM polls
      WHERE activa=FALSE AND status='active'
      AND inicio IS NOT NULL AND inicio <= NOW()
      AND (fin IS NULL OR fin > NOW())
      AND snapshot_total_coins = 0
    `);
    for (const p of toOpen) {
      const snap = await takeSnapshot(p.scope, p.classroom_id);
      await db.query(
        `UPDATE polls SET activa=TRUE, snapshot_total_coins=$1, snapshot_total_voters=$2 WHERE id=$3`,
        [snap.total_coins, snap.total_voters, p.id]
      );
      const ioInst = req.app.get('io');
      if (ioInst) ioInst.emit('poll_update', { poll_id: p.id, action: 'created' });
    }

    let queryText, queryParams;
    if (status === 'approved') {
      // Sección "Aprobadas": polls con status='approved'
      queryText = `
        SELECT p.id FROM polls p
        WHERE p.status='approved'
        AND ($1::text IS NULL OR p.scope=$1)
        AND ($2::uuid IS NULL OR p.classroom_id=$2)
        AND ($3::text IS NULL OR p.titulo ILIKE '%' || $3 || '%' OR p.poll_number::text = LTRIM($3, '#'))
        ORDER BY p.approved_at DESC NULLS LAST, p.created_at DESC
      `;
      queryParams = [scope, cid, q];
    } else if (status === 'closed') {
      // Cerradas esperando aprobación (activa=FALSE, status='active')
      queryText = `
        SELECT p.id FROM polls p
        WHERE p.activa=FALSE AND p.status='active'
        AND ($1::text IS NULL OR p.scope=$1)
        AND ($2::uuid IS NULL OR p.classroom_id=$2)
        AND ($3::text IS NULL OR p.titulo ILIKE '%' || $3 || '%' OR p.poll_number::text = LTRIM($3, '#'))
        ORDER BY p.fin DESC NULLS LAST, p.created_at DESC
      `;
      queryParams = [scope, cid, q];
    } else {
      // Sección "Activas": polls activas + upcoming (inicio futuro, aún no arrancaron)
      queryText = `
        SELECT p.id FROM polls p
        JOIN users u_order ON u_order.id = p.created_by
        WHERE p.status='active'
        AND (
          p.activa=TRUE
          OR (p.activa=FALSE AND p.inicio IS NOT NULL AND p.inicio > NOW() AND (p.fin IS NULL OR p.fin > NOW()))
        )
        AND ($1::text IS NULL OR p.scope=$1)
        AND ($2::uuid IS NULL OR p.classroom_id=$2)
        AND ($3::text IS NULL OR p.titulo ILIKE '%' || $3 || '%' OR p.poll_number::text = LTRIM($3, '#'))
        ORDER BY
          CASE WHEN p.activa=FALSE THEN 0 ELSE 1 END,
          CASE WHEN u_order.rol='admin'   THEN 0
               WHEN u_order.rol='teacher' THEN 1
               ELSE 2 END,
          p.created_at DESC
      `;
      queryParams = [scope, cid, q];
    }

    const { rows } = await db.query(queryText, queryParams);
    const { rows: qsRows } = await db.query('SELECT * FROM quorum_settings');
    const quorumMap = Object.fromEntries(qsRows.map(r => [r.scope, r]));
    const enriched = await Promise.all(rows.map(p => enrichPoll(p.id, req.user.id, quorumMap, req.user.rol)));
    res.json({ ok: true, data: enriched.filter(Boolean) });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /polls/snapshot — datos actuales de la economía (preview al crear propuesta)
router.get('/snapshot', auth, async (req, res) => {
  try {
    const scope = req.query.scope || 'global';
    const cid   = req.query.classroom_id || null;
    const isStaff = ['admin','teacher'].includes(req.user.rol);
    // Verificar acceso al aula si no es staff
    if (scope === 'aula' && cid && !isStaff) {
      const { rows } = await db.query(
        'SELECT 1 FROM classroom_members WHERE classroom_id=$1 AND user_id=$2',
        [cid, req.user.id]
      );
      if (!rows.length) return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    const snap = await takeSnapshot(scope, cid);
    res.json({ ok: true, data: snap });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /polls/pending — admin: lista propuestas esperando revisión
router.get('/pending', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT p.id, p.titulo, p.contexto, p.created_at, p.scope, p.weighted, p.fin,
             p.created_by AS creador_id, u.nombre AS creador_nombre, u.rol AS creador_rol,
             (SELECT json_agg(json_build_object('texto',po.texto,'orden',po.orden) ORDER BY po.orden)
              FROM poll_options po WHERE po.poll_id=p.id) AS opciones
      FROM polls p JOIN users u ON u.id=p.created_by
      WHERE p.status='pending'
      ORDER BY p.created_at ASC
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /polls/:id — una sola poll con quórum actualizado
router.get('/:id', auth, async (req, res) => {
  try {
    const { rows: qsRows } = await db.query('SELECT * FROM quorum_settings');
    const quorumMap = Object.fromEntries(qsRows.map(r => [r.scope, r]));
    const data = await enrichPoll(req.params.id, req.user.id, quorumMap, req.user.rol);
    if (!data) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /polls/:id/voters — lista de votantes con su peso
router.get('/:id/voters', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.nombre, u.apodo, u.skin, u.rol, u.avatar_bg,
             pv.peso::numeric AS peso,
             po.id AS option_id, po.texto AS opcion_texto
      FROM poll_votes pv
      JOIN users u ON u.id=pv.user_id
      JOIN poll_options po ON po.id=pv.option_id
      WHERE pv.poll_id=$1
      ORDER BY pv.peso DESC, u.nombre
    `, [req.params.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /polls — siempre DAO weighted; inicio/fin calculados en servidor
router.post('/', auth, async (req, res) => {
  const client = await db.getClient();
  try {
    const {
      titulo, opciones,
      delay_valor=0, delay_unidad='dias',
      dur_valor=24,  dur_unidad='horas',
      scope='global', classroom_id=null, contexto=''
    } = req.body;
    const isStaff  = ['admin','teacher'].includes(req.user.rol);
    const weighted = true;

    if (!titulo?.trim() || titulo.trim().length < 5)
      return res.status(400).json({ ok: false, error: { code: 'INVALID_TITULO', message: 'El título debe tener al menos 5 caracteres' } });
    if (!Array.isArray(opciones) || opciones.length < 2 || opciones.length > 8)
      return res.status(400).json({ ok: false, error: { code: 'INVALID_OPTIONS' } });
    if (!isStaff && (!contexto?.trim() || contexto.trim().length < 20))
      return res.status(400).json({ ok: false, error: { code: 'INVALID_CONTEXTO', message: 'La descripción del problema debe tener al menos 20 caracteres' } });

    // Validar delay para globales (mínimo 1 día, calculado en el servidor)
    const delayVal = Math.max(0, parseInt(delay_valor) || 0);
    if (scope === 'global') {
      const delayHoras = delay_unidad === 'dias' ? delayVal * 24
                       : delay_unidad === 'horas' ? delayVal : delayVal / 60;
      if (delayHoras < 24)
        return res.status(400).json({ ok: false, error: { code: 'TOO_EARLY', message: 'Las votaciones globales deben comenzar al menos 1 día después de crearse' } });
    }

    // Calcular inicio y fin en el servidor (inmune a manipulación del reloj del cliente)
    const DUR_MAX = { minutos: 1440, horas: 480, dias: 20 };
    const durVal  = Math.min(Math.max(1, parseInt(dur_valor) || 1), DUR_MAX[dur_unidad] || 480);
    const now     = new Date();
    const inicioD = new Date(now);
    if (delayVal > 0) {
      if (delay_unidad === 'minutos') inicioD.setMinutes(inicioD.getMinutes() + delayVal);
      else if (delay_unidad === 'horas') inicioD.setHours(inicioD.getHours() + delayVal);
      else inicioD.setDate(inicioD.getDate() + delayVal);
    }
    const finD = new Date(inicioD);
    if (dur_unidad === 'minutos') finD.setMinutes(finD.getMinutes() + durVal);
    else if (dur_unidad === 'horas') finD.setHours(finD.getHours() + durVal);
    else finD.setDate(finD.getDate() + durVal);
    const inmediato  = delayVal === 0;
    const inicioDate = inmediato ? null : inicioD;

    const finalScope = scope || 'global';
    let   finalCid   = null;
    if (finalScope === 'aula') {
      if (!classroom_id)
        return res.status(400).json({ ok: false, error: { code: 'MISSING_CLASSROOM', message: 'Indicá el aula' } });
      if (!isStaff) {
        const { rows: mem } = await db.query(
          'SELECT 1 FROM classroom_members WHERE classroom_id=$1 AND user_id=$2',
          [classroom_id, req.user.id]
        );
        if (!mem.length)
          return res.status(403).json({ ok: false, error: { code: 'NOT_IN_CLASSROOM', message: 'No sos miembro de ese aula' } });
      }
      finalCid = classroom_id;
    }

    const activa = inmediato;
    let snapCoinsVal = 0, snapVoters = 0;
    if (inmediato) {
      const snap = await takeSnapshot(finalScope, finalCid);
      snapCoinsVal = snap.total_coins;
      snapVoters   = snap.total_voters;
    }

    await client.query('BEGIN');
    const { rows: poll } = await client.query(`
      INSERT INTO polls (titulo, activa, inicio, fin, created_by, scope, classroom_id, weighted, contexto, status, snapshot_total_coins, snapshot_total_voters)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id
    `, [titulo.trim(), activa, inicioDate, finD, req.user.id, finalScope, finalCid, weighted, contexto?.trim()||null, 'active', snapCoinsVal, snapVoters]);

    for (let i = 0; i < opciones.length; i++)
      await client.query('INSERT INTO poll_options (poll_id,texto,orden) VALUES ($1,$2,$3)',
        [poll[0].id, opciones[i].trim(), i]);

    await client.query('COMMIT');
    const io = req.app.get('io');
    if (io) io.emit('poll_update', { poll_id: poll[0].id, action: inmediato ? 'created' : 'scheduled' });
    const data = await enrichPoll(poll[0].id, req.user.id, null, req.user.rol);
    res.status(201).json({ ok: true, data });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// POST /polls/:id/vote
router.post('/:id/vote', auth, async (req, res) => {
  try {
    const { option_id } = req.body;
    if (!option_id) return res.status(400).json({ ok: false, error: { code: 'INVALID_OPTION' } });

    const { rows: poll } = await db.query(
      'SELECT activa, fin, weighted, inicio, scope, classroom_id, snapshot_total_coins FROM polls WHERE id=$1',
      [req.params.id]
    );
    if (!poll.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    if (!poll[0].activa) return res.status(400).json({ ok: false, error: { code: 'POLL_CLOSED' } });
    if (poll[0].inicio && new Date(poll[0].inicio) > new Date())
      return res.status(400).json({ ok: false, error: { code: 'NOT_STARTED', message: 'Esta votación aún no comenzó' } });
    if (poll[0].fin && new Date(poll[0].fin) < new Date())
      return res.status(400).json({ ok: false, error: { code: 'POLL_EXPIRED', message: 'Esta votación ya venció' } });

    // Lazy snapshot: si aún no se tomó (poll inmediata sin snapshot), tomarlo ahora
    if (poll[0].weighted && parseFloat(poll[0].snapshot_total_coins) === 0) {
      const snap = await takeSnapshot(poll[0].scope, poll[0].classroom_id);
      await db.query('UPDATE polls SET snapshot_total_coins=$1, snapshot_total_voters=$2 WHERE id=$3',
        [snap.total_coins, snap.total_voters, req.params.id]);
      poll[0].snapshot_total_coins = snap.total_coins;
    }

    const { rows: opt } = await db.query(
      'SELECT id FROM poll_options WHERE id=$1 AND poll_id=$2', [option_id, req.params.id]);
    if (!opt.length) return res.status(400).json({ ok: false, error: { code: 'INVALID_OPTION' } });

    // Calcular peso del voto (balance actual si es DAO weighted)
    let peso = 1;
    if (poll[0].weighted) {
      if (req.user.rol === 'admin') {
        // Admin representa el 3% de las monedas del snapshot
        const { rows: snapRow } = await db.query('SELECT snapshot_total_coins FROM polls WHERE id=$1', [req.params.id]);
        peso = parseFloat(snapRow[0]?.snapshot_total_coins || 0) * 0.03;
        if (peso < 1) peso = 1; // Mínimo 1 aunque no haya snapshot
      } else {
        try {
          const accountId = await balanceSvc.getAccountByUserId(req.user.id);
          peso = await balanceSvc.getBalance(accountId);
        } catch(e) {
          return res.status(400).json({ ok: false, error: { code: 'NO_ACCOUNT', message: 'No tenés cuenta activa' } });
        }
        if (peso < 1) {
          return res.status(400).json({ ok: false, error: { code: 'NO_COINS', message: 'Necesitás al menos 1 moneda para votar en esta propuesta DAO' } });
        }
      }
    }

    try {
      await db.query('INSERT INTO poll_votes (poll_id,option_id,user_id,peso) VALUES ($1,$2,$3,$4)',
        [req.params.id, option_id, req.user.id, peso]);
    } catch(e) {
      if (e.code==='23505') return res.status(409).json({ ok: false, error: { code: 'ALREADY_VOTED' } });
      throw e;
    }
    // Socket: notificar a todos para actualizar en tiempo real
    const io = req.app.get('io');
    if (io) io.emit('poll_update', { poll_id: req.params.id, action: 'vote' });

    const { rows: qsRows } = await db.query('SELECT * FROM quorum_settings');
    const quorumMap = Object.fromEntries(qsRows.map(r => [r.scope, r]));
    const data = await enrichPoll(req.params.id, req.user.id, quorumMap, req.user.rol);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// PATCH /polls/:id/review — admin aprueba o rechaza propuestas pendientes
router.patch('/:id/review', auth, roles('admin'), async (req, res) => {
  try {
    const { action, note } = req.body;
    if (!['approve','reject'].includes(action))
      return res.status(400).json({ ok: false, error: { code: 'INVALID_ACTION' } });
    const activa = action === 'approve';
    const status = action === 'approve' ? 'active' : 'rejected';
    await db.query(
      `UPDATE polls SET activa=$1, status=$2, review_note=$3, review_by=$4 WHERE id=$5`,
      [activa, status, note?.trim()||null, req.user.id, req.params.id]
    );
    if (action === 'approve') {
      const io = req.app.get('io');
      if (io) io.emit('poll_update', { poll_id: req.params.id, action: 'created' });
    }
    const { rows: qsRows } = await db.query('SELECT * FROM quorum_settings');
    const quorumMap = Object.fromEntries(qsRows.map(r => [r.scope, r]));
    const data = await enrichPoll(req.params.id, req.user.id, quorumMap, req.user.rol);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// PATCH /polls/:id/approve — admin aprueba oficialmente una votación cerrada
router.patch('/:id/approve', auth, roles('admin'), async (req, res) => {
  try {
    const { rows: poll } = await db.query('SELECT id, status, activa, fin FROM polls WHERE id=$1', [req.params.id]);
    if (!poll.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    if (poll[0].status === 'approved')
      return res.status(409).json({ ok: false, error: { code: 'ALREADY_APPROVED' } });
    if (poll[0].activa || !poll[0].fin || new Date(poll[0].fin) > new Date())
      return res.status(400).json({ ok: false, error: { code: 'POLL_NOT_CLOSED', message: 'Solo se pueden aprobar votaciones que ya terminaron' } });
    const { rows: vc } = await db.query(
      'SELECT COUNT(*)::int AS total FROM poll_votes WHERE poll_id=$1', [req.params.id]);
    if (vc[0].total === 0)
      return res.status(400).json({ ok: false, error: { code: 'NO_VOTES', message: 'No se puede aprobar una votación sin ningún voto registrado' } });
    await db.query(
      `UPDATE polls SET status='approved', approved_at=NOW(), approved_by=$1 WHERE id=$2`,
      [req.user.id, req.params.id]
    );
    const io = req.app.get('io');
    if (io) io.emit('poll_update', { poll_id: req.params.id, action: 'approved' });
    const { rows: qsRows } = await db.query('SELECT * FROM quorum_settings');
    const quorumMap = Object.fromEntries(qsRows.map(r => [r.scope, r]));
    const data = await enrichPoll(req.params.id, req.user.id, quorumMap, req.user.rol);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// DELETE /polls/:id — admin borra cualquiera; dueño puede retirar sus propuestas pending/rejected
router.delete('/:id', auth, async (req, res) => {
  try {
    const { rows: poll } = await db.query('SELECT created_by, status FROM polls WHERE id=$1', [req.params.id]);
    if (!poll.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    const isOwner = poll[0].created_by === req.user.id;
    const isAdmin = req.user.rol === 'admin';
    if (!isAdmin && !(isOwner && ['pending','rejected'].includes(poll[0].status)))
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } });
    await db.query('DELETE FROM polls WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// PATCH /polls/:id — admin puede cerrar cualquiera; teacher solo las propias
router.patch('/:id', auth, async (req, res) => {
  try {
    if (req.user.rol !== 'admin' && req.user.rol !== 'teacher') {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    const { activa } = req.body;
    if (typeof activa !== 'boolean') return res.status(400).json({ ok: false, error: { code: 'INVALID_BODY' } });
    if (req.user.rol === 'teacher') {
      const { rows } = await db.query('SELECT created_by FROM polls WHERE id=$1', [req.params.id]);
      if (!rows.length || rows[0].created_by !== req.user.id)
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Solo podés cerrar tus propias votaciones' } });
    }
    await db.query('UPDATE polls SET activa=$1 WHERE id=$2', [activa, req.params.id]);
    const data = await enrichPoll(req.params.id, req.user.id, null, req.user.rol);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /polls/:id/react
router.post('/:id/react', auth, async (req, res) => {
  try {
    const { tipo } = req.body;
    if (!['like','dislike'].includes(tipo))
      return res.status(400).json({ ok: false, error: { code: 'INVALID_TIPO' } });

    const { rows: ex } = await db.query(
      'SELECT id, tipo FROM poll_reactions WHERE poll_id=$1 AND user_id=$2', [req.params.id, req.user.id]);

    if (ex.length && ex[0].tipo===tipo)
      await db.query('DELETE FROM poll_reactions WHERE id=$1', [ex[0].id]);
    else if (ex.length)
      await db.query('UPDATE poll_reactions SET tipo=$1 WHERE id=$2', [tipo, ex[0].id]);
    else
      await db.query('INSERT INTO poll_reactions (poll_id,user_id,tipo) VALUES ($1,$2,$3)',
        [req.params.id, req.user.id, tipo]);

    const io = req.app.get('io');
    if (io) io.emit('poll_update', { poll_id: req.params.id, action: 'reaction' });
    const data = await enrichPoll(req.params.id, req.user.id, null, req.user.rol);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /polls/:id/comments
router.get('/:id/comments', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT pc.id, pc.texto, pc.created_at, pc.parent_id,
        u.id AS user_id, u.nombre, u.rol, u.skin, u.border, u.avatar_bg, u.foto_url,
        (SELECT COUNT(*)::int FROM poll_comment_reactions WHERE comment_id=pc.id AND tipo='like')    AS likes,
        (SELECT COUNT(*)::int FROM poll_comment_reactions WHERE comment_id=pc.id AND tipo='dislike') AS dislikes,
        (SELECT tipo FROM poll_comment_reactions WHERE comment_id=pc.id AND user_id=$2)              AS mi_reaccion,
        (SELECT COUNT(*)::int FROM poll_comments WHERE parent_id=pc.id)                             AS respuestas
      FROM poll_comments pc JOIN users u ON u.id=pc.user_id
      WHERE pc.poll_id=$1 AND pc.parent_id IS NULL
      ORDER BY pc.created_at ASC
    `, [req.params.id, req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /polls/:id/comments/:cid/replies
router.get('/:id/comments/:cid/replies', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT pc.id, pc.texto, pc.created_at, pc.parent_id,
        u.id AS user_id, u.nombre, u.rol, u.skin, u.border, u.avatar_bg, u.foto_url,
        (SELECT COUNT(*)::int FROM poll_comment_reactions WHERE comment_id=pc.id AND tipo='like')    AS likes,
        (SELECT COUNT(*)::int FROM poll_comment_reactions WHERE comment_id=pc.id AND tipo='dislike') AS dislikes,
        (SELECT tipo FROM poll_comment_reactions WHERE comment_id=pc.id AND user_id=$2)              AS mi_reaccion
      FROM poll_comments pc JOIN users u ON u.id=pc.user_id
      WHERE pc.parent_id=$1 ORDER BY pc.created_at ASC
    `, [req.params.cid, req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /polls/:id/comments
router.post('/:id/comments', auth, async (req, res) => {
  try {
    const { texto, parent_id=null } = req.body;
    if (!texto?.trim()) return res.status(400).json({ ok: false, error: { code: 'EMPTY' } });
    const { rows } = await db.query(`
      INSERT INTO poll_comments (poll_id,user_id,parent_id,texto) VALUES ($1,$2,$3,$4) RETURNING id,texto,created_at,parent_id
    `, [req.params.id, req.user.id, parent_id, texto.trim()]);
    const io = req.app.get('io');
    if (io) io.emit('poll_update', { poll_id: req.params.id, action: 'comment' });
    res.status(201).json({ ok: true, data: { ...rows[0], user_id:req.user.id, nombre:req.user.nombre, rol:req.user.rol, likes:0, dislikes:0, mi_reaccion:null, respuestas:0 } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /polls/:id/comments/:cid/react
router.post('/:id/comments/:cid/react', auth, async (req, res) => {
  try {
    const { tipo } = req.body;
    if (!['like','dislike'].includes(tipo))
      return res.status(400).json({ ok: false, error: { code: 'INVALID_TIPO' } });

    const { rows: ex } = await db.query(
      'SELECT id,tipo FROM poll_comment_reactions WHERE comment_id=$1 AND user_id=$2',
      [req.params.cid, req.user.id]);

    if (ex.length && ex[0].tipo===tipo)
      await db.query('DELETE FROM poll_comment_reactions WHERE id=$1', [ex[0].id]);
    else if (ex.length)
      await db.query('UPDATE poll_comment_reactions SET tipo=$1 WHERE id=$2', [tipo, ex[0].id]);
    else
      await db.query('INSERT INTO poll_comment_reactions (comment_id,user_id,tipo) VALUES ($1,$2,$3)',
        [req.params.cid, req.user.id, tipo]);

    const { rows: counts } = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM poll_comment_reactions WHERE comment_id=$1 AND tipo='like')    AS likes,
        (SELECT COUNT(*)::int FROM poll_comment_reactions WHERE comment_id=$1 AND tipo='dislike') AS dislikes,
        (SELECT tipo FROM poll_comment_reactions WHERE comment_id=$1 AND user_id=$2)              AS mi_reaccion
    `, [req.params.cid, req.user.id]);

    const io = req.app.get('io');
    if (io) io.emit('poll_update', { poll_id: req.params.id, action: 'comment_react', comment_id: req.params.cid });
    res.json({ ok: true, data: { comment_id: req.params.cid, ...counts[0] } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// DELETE /polls/:id/comments/:cid
router.delete('/:id/comments/:cid', auth, async (req, res) => {
  try {
    const { rows: c } = await db.query('SELECT user_id FROM poll_comments WHERE id=$1', [req.params.cid]);
    if (!c.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    if (c[0].user_id !== req.user.id && req.user.rol !== 'admin')
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } });
    await db.query('DELETE FROM poll_comments WHERE id=$1', [req.params.cid]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});


module.exports = router;
