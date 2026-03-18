// src/routes/admin.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db     = require('../config/db');
const auth   = require('../middleware/auth');
const roles  = require('../middleware/roles');
const ledger = require('../services/ledger');
const { getBalance } = require('../services/balance');
const router = express.Router();

// Todos los endpoints de admin requieren autenticación y rol admin
router.use(auth, roles('admin'));

// ── GET /api/v1/admin/users ───────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, nombre, email, rol, activo, total_earned, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /api/v1/admin/users ──────────────────────────────────
router.post('/users', async (req, res) => {
  const client = await db.getClient();
  try {
    const { nombre, email, password, rol } = req.body;
    if (!nombre || !email || !password || !rol) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'Todos los campos son requeridos' } });
    }

    await client.query('BEGIN');

    const password_hash = await bcrypt.hash(password, 12);
    const userId = uuidv4();

    const { rows } = await client.query(
      `INSERT INTO users (id, nombre, email, password_hash, rol)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, nombre, email, rol`,
      [userId, nombre, email.toLowerCase().trim(), password_hash, rol]
    );

    // Crear cuenta automáticamente para el usuario
    if (rol === 'student' || rol === 'teacher') {
      await client.query(
        `INSERT INTO accounts (id, user_id, account_type, label)
         VALUES ($1,$2,$3,$4)`,
        [uuidv4(), userId, rol === 'student' ? 'student' : 'teacher', `Cuenta de ${nombre}`]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') { // unique violation
      return res.status(422).json({ ok: false, error: { code: 'EMAIL_TAKEN', message: 'Ya existe un usuario con ese email' } });
    }
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally {
    client.release();
  }
});

// ── PATCH /api/v1/admin/users/:id/deactivate ─────────────────
router.patch('/users/:id/deactivate', async (req, res) => {
  try {
    await db.query('UPDATE users SET activo=false WHERE id=$1', [req.params.id]);
    res.json({ ok: true, data: { message: 'Usuario desactivado' } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /api/v1/admin/mint ───────────────────────────────────
router.post('/mint', async (req, res) => {
  try {
    const { amount, description } = req.body;
    if (!amount || !description) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'Monto y descripción requeridos' } });
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_AMOUNT', message: 'El monto debe ser un entero positivo' } });
    }
    const txId = await ledger.mint({ adminId: req.user.id, amount, description });
    res.json({ ok: true, data: { transaction_id: txId, message: `${amount} monedas acreditadas a la Tesorería` } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /api/v1/admin/burn ───────────────────────────────────
router.post('/burn', async (req, res) => {
  try {
    const { amount, reason } = req.body;
    if (!amount || !reason) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'Monto y motivo son requeridos' } });
    }
    const txId = await ledger.burn({ adminId: req.user.id, amount, reason });
    res.json({ ok: true, data: { transaction_id: txId, message: `${amount} monedas eliminadas de la Tesorería` } });
  } catch (err) {
    const status = err.code === 'INSUFFICIENT_BALANCE' ? 422 : 400;
    res.status(status).json({ ok: false, error: { code: err.code || 'ERROR', message: err.message } });
  }
});

// ── GET /api/v1/admin/treasury ────────────────────────────────
router.get('/treasury', async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT id FROM accounts WHERE account_type='treasury' AND is_active=true LIMIT 1"
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Tesorería no inicializada' } });
    const balance = await getBalance(rows[0].id);
    res.json({ ok: true, data: { account_id: rows[0].id, balance } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /api/v1/admin/teacher-budget ────────────────────────
router.post('/teacher-budget', async (req, res) => {
  try {
    const { teacher_id, monthly_limit, month } = req.body;
    if (!teacher_id || !monthly_limit) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'teacher_id y monthly_limit requeridos' } });
    }
    const monthDate = month || new Date().toISOString().slice(0, 7) + '-01';
    const { rows } = await db.query(
      `INSERT INTO teacher_budgets (id, teacher_id, monthly_limit, month, assigned_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (teacher_id, month) DO UPDATE SET monthly_limit=$3, assigned_by=$5
       RETURNING *`,
      [uuidv4(), teacher_id, monthly_limit, monthDate, req.user.id]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /api/v1/admin/audit-log ───────────────────────────────
router.get('/audit-log', async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const { rows } = await db.query(
      `SELECT al.*, u.nombre AS actor_nombre
       FROM audit_log al
       LEFT JOIN users u ON al.actor_id = u.id
       ORDER BY al.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ ok: true, data: rows, page, limit });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /admin/classrooms ─────────────────────────────────────
router.get('/classrooms', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.nombre, c.descripcion, c.activa, c.created_at,
        COUNT(cm.user_id)::int AS total_miembros
      FROM classrooms c
      LEFT JOIN classroom_members cm ON cm.classroom_id = c.id
      GROUP BY c.id ORDER BY c.created_at DESC
    `);
    // Cargar miembros de cada aula
    for (const aula of rows) {
      const { rows: miembros } = await db.query(`
        SELECT u.id AS user_id, u.nombre, u.rol AS user_rol, cm.rol
        FROM classroom_members cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.classroom_id = $1
      `, [aula.id]);
      aula.miembros = miembros;
    }
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /admin/classrooms ────────────────────────────────────
router.post('/classrooms', auth, roles('admin'), async (req, res) => {
  const { nombre, descripcion } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD', message: 'Nombre requerido' } });
  try {
    const { rows } = await db.query(
      `INSERT INTO classrooms (nombre, descripcion, created_by)
       VALUES ($1, $2, $3) RETURNING *`,
      [nombre.trim(), descripcion?.trim() || null, req.user.id]
    );
    // Crear conversación de aula automáticamente
    const { rows: conv } = await db.query(
      `INSERT INTO conversations (type, classroom_id) VALUES ('classroom', $1) RETURNING id`,
      [rows[0].id]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /admin/classrooms/:id/members ───────────────────────
router.post('/classrooms/:id/members', auth, roles('admin'), async (req, res) => {
  const { user_id, rol } = req.body;
  if (!user_id) return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELD', message: 'user_id requerido' } });
  try {
    await db.query(
      `INSERT INTO classroom_members (classroom_id, user_id, rol)
       VALUES ($1, $2, $3) ON CONFLICT (classroom_id, user_id) DO UPDATE SET rol = $3`,
      [req.params.id, user_id, rol || 'student']
    );
    // Agregar a la conversación del aula
    const { rows: conv } = await db.query(
      `SELECT id FROM conversations WHERE classroom_id = $1 LIMIT 1`, [req.params.id]
    );
    if (conv.length > 0) {
      await db.query(
        `INSERT INTO conversation_members (conversation_id, user_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [conv[0].id, user_id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /admin/ranking ────────────────────────────────────────
// Top holders (balance actual) y top ganadores por misiones
router.get('/ranking', auth, roles('admin'), async (req, res) => {
  try {
    // Top holders = mayor balance actual (lo que tienen ahora)
    const { rows: topHolders } = await db.query(`
      SELECT u.id, u.nombre, u.skin, u.border, u.rol,
        COALESCE(SUM(le.amount),0)::integer AS balance
      FROM users u
      JOIN accounts a ON a.user_id=u.id AND a.account_type IN ('student','teacher')
      LEFT JOIN ledger_entries le ON le.account_id=a.id
      WHERE u.activo=TRUE AND u.rol='student'
      GROUP BY u.id ORDER BY balance DESC LIMIT 10
    `);

    // Top por misiones = suma de rewards recibidos por misiones aprobadas
    const { rows: topMisiones } = await db.query(`
      SELECT u.id, u.nombre, u.skin, u.border,
        COALESCE(SUM(le.amount),0)::integer AS ganado_misiones,
        COUNT(DISTINCT ms.id)::int AS misiones_completadas
      FROM users u
      JOIN mission_submissions ms ON ms.student_id=u.id AND ms.estado='aprobada'
      JOIN transactions t ON t.id=ms.transaction_id AND t.type='reward'
      JOIN accounts a ON a.user_id=u.id
      JOIN ledger_entries le ON le.transaction_id=t.id AND le.account_id=a.id AND le.amount>0
      WHERE u.activo=TRUE
      GROUP BY u.id ORDER BY ganado_misiones DESC LIMIT 10
    `);

    // Top check-in racha
    const { rows: topCheckin } = await db.query(`
      SELECT u.id, u.nombre, u.skin, u.border,
        dc.racha AS racha_max,
        COUNT(dc.id)::int AS total_checkins
      FROM users u
      JOIN daily_checkins dc ON dc.user_id=u.id
      WHERE u.activo=TRUE
      GROUP BY u.id, dc.racha
      ORDER BY racha_max DESC, total_checkins DESC LIMIT 10
    `);

    // Stats generales
    const { rows: stats } = await db.query(`
      SELECT
        COUNT(DISTINCT CASE WHEN u.rol='student' AND u.activo THEN u.id END)::int AS total_alumnos,
        COUNT(DISTINCT CASE WHEN ms.estado='aprobada' THEN ms.id END)::int AS total_misiones_completadas,
        COUNT(DISTINCT dc.id)::int AS total_checkins,
        COALESCE(SUM(CASE WHEN le.amount>0 AND t.type='reward' THEN le.amount ELSE 0 END),0)::integer AS total_distribuido
      FROM users u
      LEFT JOIN mission_submissions ms ON ms.student_id=u.id
      LEFT JOIN daily_checkins dc ON dc.user_id=u.id
      LEFT JOIN accounts a ON a.user_id=u.id
      LEFT JOIN ledger_entries le ON le.account_id=a.id
      LEFT JOIN transactions t ON t.id=le.transaction_id
    `);

    res.json({ ok: true, data: { topHolders, topMisiones, topCheckin, stats: stats[0] } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /admin/bank-transfer ─────────────────────────────────
// Banco: el admin transfiere directamente desde la tesorería a un usuario
// Body: { to_user_id, amount, descripcion, tipo: 'premio'|'prestamo'|'ajuste'|'salario' }
router.post('/bank-transfer', auth, roles('admin'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { to_user_id, amount, descripcion, tipo='premio' } = req.body;
    if (!to_user_id || !amount || amount<=0)
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS' } });

    const ledger = require('../services/ledger');
    // Usamos reward con el admin como teacher (tiene permisos)
    const txId = await ledger.reward({
      teacherId:   req.user.id,
      studentId:   to_user_id,
      amount:      parseInt(amount),
      description: descripcion || `Transferencia bancaria (${tipo}) — Admin`,
    });

    // Notificar
    try {
      const { getIO } = require('../socket');
      const io = getIO();
      if (io) io.to(`user:${to_user_id}`).emit('notification', {
        type: 'reward', amount: parseInt(amount),
        description: descripcion || `Transferencia del banco (${tipo})`,
        from: 'Banco Aubank',
      });
    } catch(e) {}

    res.json({ ok: true, data: { transaction_id: txId } });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    res.status(err.code==='BUDGET_EXCEEDED'?422:500).json({
      ok: false, error: { code: err.code||'SERVER_ERROR', message: err.message }
    });
  } finally { client.release(); }
});

module.exports = router;
