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
      `SELECT al.*, u.nombre AS actor_nombre,
        CASE
          WHEN al.target_type='user' THEN (SELECT nombre FROM users WHERE id=al.target_id::uuid)
          ELSE NULL
        END AS target_nombre
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
router.get('/ranking', auth, roles('admin'), async (req, res) => {
  try {
    const classroomId = req.query.classroom_id || null;

    // Filtro de aula: si se especifica, solo usuarios de esa aula
    const aulaFilter = classroomId
      ? `AND u.id IN (SELECT user_id FROM classroom_members WHERE classroom_id='${classroomId}')`
      : '';

    // Top holders = mayor balance actual
    const { rows: topHolders } = await db.query(`
      SELECT u.id, u.nombre, u.apodo, u.skin, u.border, u.rol,
        COALESCE(SUM(le.amount),0)::integer AS balance
      FROM users u
      JOIN accounts a ON a.user_id=u.id AND a.account_type IN ('student','teacher')
      LEFT JOIN ledger_entries le ON le.account_id=a.id
      WHERE u.activo=TRUE AND u.rol='student' ${aulaFilter}
      GROUP BY u.id ORDER BY balance DESC LIMIT 10
    `);

    // Top por misiones ganadas
    const { rows: topMisiones } = await db.query(`
      SELECT u.id, u.nombre, u.apodo, u.skin, u.border,
        COALESCE(SUM(le.amount),0)::integer AS ganado_misiones,
        COUNT(DISTINCT ms.id)::int AS misiones_completadas
      FROM users u
      JOIN mission_submissions ms ON ms.student_id=u.id AND ms.estado='aprobada'
      JOIN transactions t ON t.id=ms.transaction_id AND t.type='reward'
      JOIN accounts a ON a.user_id=u.id
      JOIN ledger_entries le ON le.transaction_id=t.id AND le.account_id=a.id AND le.amount>0
      WHERE u.activo=TRUE ${aulaFilter}
      GROUP BY u.id ORDER BY ganado_misiones DESC LIMIT 10
    `);

    // Top check-in racha
    const { rows: topCheckin } = await db.query(`
      SELECT u.id, u.nombre, u.apodo, u.skin, u.border,
        MAX(dc.racha) AS racha_max,
        COUNT(dc.id)::int AS total_checkins
      FROM users u
      JOIN daily_checkins dc ON dc.user_id=u.id
      WHERE u.activo=TRUE ${aulaFilter}
      GROUP BY u.id
      ORDER BY racha_max DESC, total_checkins DESC LIMIT 10
    `);

    // Stats generales (de toda la escuela, no filtrada)
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
// Body: { recipients: 'all'|'students'|'teachers'|'classroom'|[user_id,...],
//         classroom_id?, amount, descripcion, tipo }
router.post('/bank-transfer', auth, roles('admin'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { recipients, classroom_id, amount, descripcion, tipo='premio' } = req.body;
    if (!recipients || !amount || amount <= 0)
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS' } });

    // Resolver lista de destinatarios
    let userIds = [];
    if (Array.isArray(recipients)) {
      userIds = recipients;
    } else if (recipients === 'all') {
      const { rows } = await client.query("SELECT id FROM users WHERE activo=TRUE AND rol!='admin'");
      userIds = rows.map(r => r.id);
    } else if (recipients === 'students') {
      const { rows } = await client.query("SELECT id FROM users WHERE activo=TRUE AND rol='student'");
      userIds = rows.map(r => r.id);
    } else if (recipients === 'teachers') {
      const { rows } = await client.query("SELECT id FROM users WHERE activo=TRUE AND rol='teacher'");
      userIds = rows.map(r => r.id);
    } else if (recipients === 'classroom' && classroom_id) {
      const { rows } = await client.query(
        "SELECT user_id AS id FROM classroom_members WHERE classroom_id=$1", [classroom_id]);
      userIds = rows.map(r => r.id);
    }

    if (!userIds.length)
      return res.status(400).json({ ok: false, error: { code: 'NO_RECIPIENTS' } });

    const ledger = require('../services/ledger');
    const io = require('../socket').getIO?.();
    const results = [];

    for (const uid of userIds) {
      try {
        const txId = await ledger.reward({
          teacherId: req.user.id, studentId: uid,
          amount: parseInt(amount),
          description: descripcion || `${tipo} bancario — Admin`,
        });
        // Guardar en audit_log con el transaction_id visible
        await db.query(`
          INSERT INTO audit_log (actor_id, action, target_type, target_id, details)
          VALUES ($1,'reward','user',$2,$3)
          ON CONFLICT DO NOTHING
        `, [req.user.id, uid, JSON.stringify({
          amount: parseInt(amount), tipo, descripcion,
          transaction_id: txId, banco: true,
        })]);
        results.push({ user_id: uid, tx_id: txId, ok: true });
        if (io) io.to(`user:${uid}`).emit('notification', {
          type: 'reward', amount: parseInt(amount),
          description: descripcion || `${tipo} del Banco Aubank`,
          from: 'Banco Aubank',
        });
      } catch(e) {
        results.push({ user_id: uid, ok: false, error: e.message });
      }
    }

    const ok_count = results.filter(r => r.ok).length;
    res.json({ ok: true, data: { total: userIds.length, ok: ok_count, failed: userIds.length - ok_count, results } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// ── POST /admin/bank-revert ───────────────────────────────────
// Revierte una transacción específica (crea una transacción inversa)
router.post('/bank-revert', auth, roles('admin'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { transaction_id, motivo } = req.body;
    if (!transaction_id || !motivo)
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS' } });

    // Buscar la transacción original
    const { rows: txRows } = await client.query(`
      SELECT t.*, le.account_id, le.amount AS entry_amount,
             a.user_id, a.account_type,
             u.nombre AS user_nombre
      FROM transactions t
      JOIN ledger_entries le ON le.transaction_id=t.id AND le.amount>0
      JOIN accounts a ON a.id=le.account_id
      LEFT JOIN users u ON u.id=a.user_id
      WHERE t.id=$1 AND t.type='reward'
    `, [transaction_id]);

    if (!txRows.length)
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Transaccion no encontrada o no reversible' } });

    const tx = txRows[0];
    const ledger = require('../services/ledger');

    // Revertir: tomar el monto del usuario y devolverlo al tesoro
    // Usamos un adjustment
    await client.query('BEGIN');
    const { getTreasuryAccountId, getAccountByUserId, assertSufficientBalance } = require('../services/balance');
    const { v4: uuidv4 } = require('uuid');

    const treasuryId = await getTreasuryAccountId(client);
    const userAccId  = await getAccountByUserId(tx.user_id, client);
    await assertSufficientBalance(userAccId, tx.entry_amount, client);

    const revertId = uuidv4();
    await client.query(`
      INSERT INTO transactions (id,type,description,initiated_by,reference_id,reference_type,metadata)
      VALUES ($1,'adjustment',$2,$3,$4,'revert',$5)
    `, [revertId, `Reversa: ${motivo}`, req.user.id, transaction_id,
        JSON.stringify({ original_tx: transaction_id, motivo, revert: true })]);

    await client.query(`INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)`,
      [uuidv4(), revertId, userAccId, -tx.entry_amount]);
    await client.query(`INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)`,
      [uuidv4(), revertId, treasuryId, tx.entry_amount]);

    await client.query('COMMIT');

    // Notificar al usuario
    const io = require('../socket').getIO?.();
    if (io) io.to(`user:${tx.user_id}`).emit('notification', {
      type: 'transfer', amount: -tx.entry_amount,
      description: `Reversa bancaria: ${motivo}`,
    });

    res.json({ ok: true, data: { revert_tx_id: revertId, amount: tx.entry_amount, user: tx.user_nombre } });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    res.status(500).json({ ok: false, error: { code: err.code||'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// ── POST /admin/tax ───────────────────────────────────────────
// Aplicar impuesto/penalidad a uno o muchos usuarios
// Body: { recipients, classroom_id?, amount, motivo, periodicidad }
router.post('/tax', auth, roles('admin'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { recipients, classroom_id, amount, motivo, periodicidad='unico' } = req.body;
    if (!recipients || !amount || amount <= 0 || !motivo)
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS' } });

    let userIds = [];
    if (Array.isArray(recipients)) {
      userIds = recipients;
    } else if (recipients === 'all') {
      const { rows } = await client.query("SELECT id FROM users WHERE activo=TRUE AND rol='student'");
      userIds = rows.map(r => r.id);
    } else if (recipients === 'classroom' && classroom_id) {
      const { rows } = await client.query(
        "SELECT cm.user_id AS id FROM classroom_members cm JOIN users u ON u.id=cm.user_id WHERE cm.classroom_id=$1 AND u.rol='student'",
        [classroom_id]);
      userIds = rows.map(r => r.id);
    }
    if (!userIds.length)
      return res.status(400).json({ ok: false, error: { code: 'NO_RECIPIENTS' } });

    const { getTreasuryAccountId, getAccountByUserId } = require('../services/balance');
    const { v4: uuidv4 } = require('uuid');
    const io = require('../socket').getIO?.();
    const results = [];
    const treasuryId = await getTreasuryAccountId(client);

    for (const uid of userIds) {
      try {
        await client.query('BEGIN');
        const userAccId = await getAccountByUserId(uid, client);
        // Calcular saldo actual
        const { rows: balRows } = await client.query(
          'SELECT COALESCE(SUM(amount),0)::int AS bal FROM ledger_entries WHERE account_id=$1', [userAccId]);
        const saldo = balRows[0].bal;
        const cobrar = Math.min(parseInt(amount), saldo); // no cobrar más de lo que tiene

        if (cobrar > 0) {
          const txId = uuidv4();
          await client.query(`INSERT INTO transactions (id,type,description,initiated_by,metadata) VALUES ($1,'adjustment',$2,$3,$4)`,
            [txId, `Impuesto (${periodicidad}): ${motivo}`, req.user.id,
             JSON.stringify({ tax: true, periodicidad, motivo, amount: cobrar })]);
          await client.query(`INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)`,
            [uuidv4(), txId, userAccId, -cobrar]);
          await client.query(`INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)`,
            [uuidv4(), txId, treasuryId, cobrar]);
          // Notificación persistente
          await client.query(`INSERT INTO notifications (user_id,tipo,titulo,cuerpo,data) VALUES ($1,'tax',$2,$3,$4)`,
            [uid, `Impuesto aplicado: -🪙${cobrar}`,
             `Motivo: ${motivo}${periodicidad!=='unico'?` (${periodicidad})`:''}`,
             JSON.stringify({ amount: cobrar, motivo, periodicidad })]);
        }

        await client.query('COMMIT');

        if (io) io.to(`user:${uid}`).emit('notification', {
          type: 'tax', amount: cobrar, motivo, periodicidad,
        });
        results.push({ user_id: uid, cobrado: cobrar, ok: true });
      } catch(e) {
        await client.query('ROLLBACK').catch(()=>{});
        results.push({ user_id: uid, ok: false, error: e.message });
      }
    }

    const ok_count = results.filter(r => r.ok).length;
    res.json({ ok: true, data: { total: userIds.length, ok: ok_count, results } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

module.exports = router;
