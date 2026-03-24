// src/routes/transactions.js
const express = require('express');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');
const ledger  = require('../services/ledger');

const router = express.Router();

// ── POST /api/v1/transactions/transfer ───────────────────────
router.post('/transfer', auth, roles('student'), async (req, res) => {
  try {
    const { to_user_id, amount, description } = req.body;

    if (!to_user_id || !amount) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'Destinatario y monto son requeridos' } });
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_AMOUNT', message: 'El monto debe ser un número entero positivo' } });
    }

    const txId = await ledger.transfer({
      fromUserId:  req.user.id,
      toUserId:    to_user_id,
      amount,
      description: description || 'Transferencia',
    });

    res.json({ ok: true, data: { transaction_id: txId, message: 'Transferencia realizada con éxito' } });
  } catch (err) {
    const status = err.code === 'INSUFFICIENT_BALANCE' ? 422 : 400;
    res.status(status).json({ ok: false, error: { code: err.code || 'ERROR', message: err.message } });
  }
});

// ── POST /api/v1/transactions/purchase ───────────────────────
router.post('/purchase', auth, roles('student'), async (req, res) => {
  try {
    const { item_id } = req.body;
    if (!item_id) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'item_id es requerido' } });
    }

    const txId = await ledger.purchase({ studentId: req.user.id, itemId: item_id });
    res.json({ ok: true, data: { transaction_id: txId, message: 'Compra realizada con éxito' } });
  } catch (err) {
    const status = ['INSUFFICIENT_BALANCE', 'OUT_OF_STOCK'].includes(err.code) ? 422 : 400;
    res.status(status).json({ ok: false, error: { code: err.code || 'ERROR', message: err.message } });
  }
});

// ── POST /api/v1/transactions/adjustment  (admin) ────────────
router.post('/adjustment', auth, roles('admin'), async (req, res) => {
  try {
    const { from_account_id, to_account_id, amount, reason } = req.body;
    if (!from_account_id || !to_account_id || !amount || !reason) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'Todos los campos son requeridos' } });
    }

    const txId = await ledger.adjustment({
      adminId:       req.user.id,
      fromAccountId: from_account_id,
      toAccountId:   to_account_id,
      amount,
      reason,
    });

    res.json({ ok: true, data: { transaction_id: txId, message: 'Ajuste realizado con éxito' } });
  } catch (err) {
    res.status(400).json({ ok: false, error: { code: err.code || 'ERROR', message: err.message } });
  }
});

module.exports = router;
