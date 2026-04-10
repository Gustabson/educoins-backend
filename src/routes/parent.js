// src/routes/parent.js — Portal de padres
const express    = require('express');
const router     = express.Router();
const db         = require('../config/db');
const auth       = require('../middleware/auth');
const roles      = require('../middleware/roles');
const ledger     = require('../services/ledger');
const { getBalance, getAccountByUserId, assertSufficientBalance } = require('../services/balance');

router.use(auth, roles('parent'));

// ── Startup migration ─────────────────────────────────────────
db.query(`
  CREATE TABLE IF NOT EXISTS parent_link_requests (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id  UUID REFERENCES users(id) ON DELETE CASCADE,
    student_id UUID REFERENCES users(id) ON DELETE CASCADE,
    student_name TEXT,
    estado     TEXT DEFAULT 'pendiente' CHECK(estado IN('pendiente','aprobado','rechazado')),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.warn('[parent] parent_link_requests table:', e.message));

// ── GET /parent/children ──────────────────────────────────────
// Hijos vinculados con su balance actual
router.get('/children', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.id, u.nombre, u.apodo, u.skin, u.border, u.avatar_bg, u.foto_url,
             a.id AS account_id
      FROM parent_student_links psl
      JOIN users u ON u.id = psl.student_id
      LEFT JOIN accounts a ON a.user_id = u.id AND a.is_active = true
      WHERE psl.parent_id = $1
      ORDER BY u.nombre
    `, [req.user.id]);

    const enriched = await Promise.all(rows.map(async child => {
      let balance = 0;
      if (child.account_id) balance = await getBalance(child.account_id);
      return { ...child, balance };
    }));

    res.json({ ok: true, data: enriched });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /parent/transfer-to-child ────────────────────────────
// Transferir monedas del padre a un hijo vinculado
router.post('/transfer-to-child', async (req, res) => {
  try {
    const { student_id, amount, description } = req.body;
    if (!student_id || !amount)
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'student_id y amount requeridos' } });
    if (!Number.isInteger(amount) || amount <= 0)
      return res.status(400).json({ ok: false, error: { code: 'INVALID_AMOUNT', message: 'El monto debe ser un entero positivo' } });

    // Verificar que el alumno esté vinculado a este padre
    const { rows: link } = await db.query(
      'SELECT id FROM parent_student_links WHERE parent_id=$1 AND student_id=$2',
      [req.user.id, student_id]
    );
    if (!link.length)
      return res.status(403).json({ ok: false, error: { code: 'NOT_LINKED', message: 'Ese alumno no está vinculado a tu cuenta' } });

    const { rows: student } = await db.query('SELECT nombre FROM users WHERE id=$1', [student_id]);
    const desc = description?.trim() || `Envío de papá/mamá a ${student[0]?.nombre}`;

    await ledger.transfer({ fromUserId: req.user.id, toUserId: student_id, amount, description: desc });

    const accountId = await getAccountByUserId(req.user.id);
    const newBalance = await getBalance(accountId);

    res.json({ ok: true, data: { message: `Enviaste ${amount} monedas a ${student[0]?.nombre}`, new_balance: newBalance } });
  } catch (err) {
    const status = err.code === 'INSUFFICIENT_BALANCE' ? 422 : 500;
    res.status(status).json({ ok: false, error: { code: err.code || 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /parent/link-search?q=name ───────────────────────────
// Busca alumnos por nombre (para solicitar vinculación)
router.get('/link-search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2)
      return res.status(400).json({ ok: false, error: { code: 'QUERY_TOO_SHORT', message: 'Escribí al menos 2 caracteres' } });

    const { rows } = await db.query(`
      SELECT id, nombre, apodo, skin, avatar_bg
      FROM users
      WHERE rol = 'student' AND activo = true AND nombre ILIKE $1
      ORDER BY nombre
      LIMIT 10
    `, [`%${q}%`]);

    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /parent/link-request/confirm ────────────────────────
// Confirma solicitud de vinculación con un alumno específico
router.post('/link-request/confirm', async (req, res) => {
  try {
    const { student_id } = req.body;
    if (!student_id)
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'student_id requerido' } });

    // Verificar que el alumno existe
    const { rows: students } = await db.query(
      "SELECT id, nombre FROM users WHERE id=$1 AND rol='student'", [student_id]
    );
    if (!students.length)
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Alumno no encontrado' } });

    // Verificar que no esté ya vinculado
    const { rows: existing } = await db.query(
      'SELECT id FROM parent_student_links WHERE parent_id=$1 AND student_id=$2',
      [req.user.id, student_id]
    );
    if (existing.length)
      return res.status(409).json({ ok: false, error: { code: 'ALREADY_LINKED', message: 'Ya estás vinculado a ese alumno' } });

    // Verificar que no haya solicitud pendiente
    const { rows: pending } = await db.query(
      "SELECT id FROM parent_link_requests WHERE parent_id=$1 AND student_id=$2 AND estado='pendiente'",
      [req.user.id, student_id]
    );
    if (pending.length)
      return res.status(409).json({ ok: false, error: { code: 'ALREADY_PENDING', message: 'Ya tenés una solicitud pendiente para ese alumno' } });

    const { rows: req_row } = await db.query(
      `INSERT INTO parent_link_requests (parent_id, student_id, student_name)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.user.id, student_id, students[0].nombre]
    );

    // Notificar a admins via socket si posible
    try {
      const { getIO } = require('../socket');
      const io = getIO();
      if (io) io.emit('admin_notification', { type: 'link_request', parent_id: req.user.id });
    } catch(e) {}

    res.status(201).json({ ok: true, data: req_row[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /parent/link-requests ─────────────────────────────────
// Devuelve las solicitudes de vinculación del padre
router.get('/link-requests', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT r.id, r.estado, r.created_at, r.student_name,
             u.id AS student_id, u.nombre AS student_nombre, u.apodo, u.avatar_bg, u.skin
      FROM parent_link_requests r
      LEFT JOIN users u ON u.id = r.student_id
      WHERE r.parent_id = $1
      ORDER BY r.created_at DESC
    `, [req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── DELETE /parent/link-requests/:id ─────────────────────────
// Cancela una solicitud pendiente propia
router.delete('/link-requests/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT id, estado FROM parent_link_requests WHERE id=$1 AND parent_id=$2",
      [req.params.id, req.user.id]
    );
    if (!rows.length)
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    if (rows[0].estado !== 'pendiente')
      return res.status(400).json({ ok: false, error: { code: 'NOT_PENDING', message: 'Solo podés cancelar solicitudes pendientes' } });

    await db.query('DELETE FROM parent_link_requests WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /parent/children-verdicts ────────────────────────────
// Veredictos de todos los hijos vinculados.
// Marks all as read (fire-and-forget) so the badge clears on the NEXT home load,
// while still returning the pre-read data so "NUEVO" labels show on first visit.
router.get('/children-verdicts', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT v.*, u.nombre AS alumno_nombre, u.apodo AS alumno_apodo, u.avatar_bg,
             f.nombre AS from_nombre
      FROM verdicts v
      JOIN users u ON u.id = v.to_user_id
      LEFT JOIN users f ON f.id = v.from_user_id
      WHERE v.to_user_id IN (
        SELECT student_id FROM parent_student_links WHERE parent_id=$1
      )
      ORDER BY v.created_at DESC
    `, [req.user.id]);
    res.json({ ok: true, data: rows });
    // Fire-and-forget: mark all unread verdicts as read so badge clears next time PHome loads.
    // Runs AFTER res.json() so the response already contains the original unread status.
    db.query(`
      UPDATE verdicts SET read_at = NOW()
      WHERE to_user_id IN (
        SELECT student_id FROM parent_student_links WHERE parent_id=$1
      ) AND read_at IS NULL
    `, [req.user.id]).catch(() => {});
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── PATCH /parent/children-verdicts/read — mark all children verdicts as read ──
router.patch('/children-verdicts/read', async (req, res) => {
  try {
    await db.query(`
      UPDATE verdicts SET read_at = NOW()
      WHERE to_user_id IN (
        SELECT student_id FROM parent_student_links WHERE parent_id=$1
      ) AND read_at IS NULL
    `, [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /parent/burn ─────────────────────────────────────────
// Quema monedas propias del padre
router.post('/burn', async (req, res) => {
  try {
    const { amount, motivo } = req.body;
    const amt = parseInt(amount);
    if (!amt || amt <= 0)
      return res.status(400).json({ ok: false, error: { code: 'INVALID_AMOUNT', message: 'El monto debe ser un entero positivo' } });

    // Verificar balance suficiente
    const accountId = await getAccountByUserId(req.user.id);
    const bal = await getBalance(accountId);
    if (bal < amt)
      return res.status(422).json({ ok: false, error: { code: 'INSUFFICIENT_BALANCE', message: `Saldo insuficiente. Tenés ${bal} monedas.` } });

    // Quemar: debit parent account, credit treasury (net-zero via transfer to treasury then burn)
    // Pattern: transfer from parent to treasury
    const { getTreasuryAccountId } = require('../services/balance');
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const { v4: uuidv4 } = require('uuid');
      const treasuryId = await getTreasuryAccountId(client);
      const desc = motivo?.trim() ? `Burn padre: ${motivo}` : 'Burn de monedas (padre)';

      // Insert transaction
      const txId = uuidv4();
      await client.query(
        `INSERT INTO transactions (id, type, description, initiated_by, metadata)
         VALUES ($1, 'burn', $2, $3, $4)`,
        [txId, desc, req.user.id, JSON.stringify({ amount: amt, motivo })]
      );
      // Debit parent
      await client.query(
        `INSERT INTO ledger_entries (id, transaction_id, account_id, amount) VALUES ($1,$2,$3,$4)`,
        [uuidv4(), txId, accountId, -amt]
      );
      // Credit treasury (monedas regresan al pool)
      await client.query(
        `INSERT INTO ledger_entries (id, transaction_id, account_id, amount) VALUES ($1,$2,$3,$4)`,
        [uuidv4(), txId, treasuryId, +amt]
      );
      await client.query('COMMIT');

      const newBalance = await getBalance(accountId);
      res.json({ ok: true, data: { message: `Quemaste ${amt} monedas`, new_balance: newBalance } });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    const status = err.code === 'INSUFFICIENT_BALANCE' ? 422 : 500;
    res.status(status).json({ ok: false, error: { code: err.code || 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;
