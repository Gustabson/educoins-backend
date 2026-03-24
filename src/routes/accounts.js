// src/routes/accounts.js
const express = require('express');
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');
const { getBalance } = require('../services/balance');

const router = express.Router();

// ── GET /api/v1/accounts/me ───────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, label, account_type FROM accounts WHERE user_id = $1 AND is_active = true',
      [req.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: { code: 'ACCOUNT_NOT_FOUND', message: 'Cuenta no encontrada' } });
    }
    const account = rows[0];
    const balance = await getBalance(account.id);
    res.json({ ok: true, data: { ...account, balance } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /api/v1/accounts/me/transactions ─────────────────────
router.get('/me/transactions', auth, async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const accResult = await db.query(
      'SELECT id FROM accounts WHERE user_id = $1 AND is_active = true',
      [req.user.id]
    );
    if (accResult.rows.length === 0) {
      return res.json({ ok: true, data: [] });
    }
    const accountId = accResult.rows[0].id;

    const { rows } = await db.query(
      `SELECT
         le.amount,
         le.created_at,
         t.type,
         t.description,
         t.id AS transaction_id
       FROM ledger_entries le
       JOIN transactions t ON le.transaction_id = t.id
       WHERE le.account_id = $1
       ORDER BY le.created_at DESC
       LIMIT $2 OFFSET $3`,
      [accountId, limit, offset]
    );

    res.json({ ok: true, data: rows, page, limit });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /api/v1/accounts/:id  (admin) ────────────────────────
router.get('/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, user_id, account_type, label FROM accounts WHERE id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Cuenta no encontrada' } });
    const balance = await getBalance(rows[0].id);
    res.json({ ok: true, data: { ...rows[0], balance } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;
