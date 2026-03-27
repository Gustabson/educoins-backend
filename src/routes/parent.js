// src/routes/parent.js — Portal de padres
const express    = require('express');
const router     = express.Router();
const db         = require('../config/db');
const auth       = require('../middleware/auth');
const roles      = require('../middleware/roles');
const ledger     = require('../services/ledger');
const { getBalance, getAccountByUserId } = require('../services/balance');

router.use(auth, roles('parent'));

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

module.exports = router;
