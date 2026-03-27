// src/routes/notifications.js
// GET   /api/v1/notifications        -> mis notificaciones (últimas 30)
// PATCH /api/v1/notifications/read   -> marcar todas como leídas
// PATCH /api/v1/notifications/:id/read -> marcar una como leída
// POST  /api/v1/notifications/push/subscribe -> guardar suscripción push
// DELETE /api/v1/notifications/push/unsubscribe -> eliminar suscripción

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');

// ── GET /notifications ────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT id, tipo, titulo, cuerpo, leida, data, created_at
      FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 30
    `, [req.user.id]);

    const { rows: unread } = await db.query(
      'SELECT COUNT(*)::int AS total FROM notifications WHERE user_id=$1 AND leida=FALSE',
      [req.user.id]
    );

    res.json({ ok: true, data: { notifications: rows, unread: unread[0].total } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── PATCH /notifications/read ─────────────────────────────────
router.patch('/read', auth, async (req, res) => {
  try {
    await db.query('UPDATE notifications SET leida=TRUE WHERE user_id=$1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── PATCH /notifications/:id/read ────────────────────────────
router.patch('/:id/read', auth, async (req, res) => {
  try {
    await db.query(
      'UPDATE notifications SET leida=TRUE WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /notifications/push/subscribe ───────────────────────
router.post('/push/subscribe', auth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth)
      return res.status(400).json({ ok: false, error: { code: 'INVALID_SUB' } });

    await db.query(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh=$3, auth=$4
    `, [req.user.id, endpoint, keys.p256dh, keys.auth]);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /notifications/send ──────────────────────────────────
// Enviar notificacion a otro usuario (ej: toque entre amigos)
router.post('/send', auth, async (req, res) => {
  try {
    const { to_user_id, type, message } = req.body;
    if (!to_user_id || !type) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_BODY', message: 'Faltan campos requeridos' } });
    }
    if (to_user_id === req.user.id) {
      return res.status(400).json({ ok: false, error: { code: 'SELF_NOTIF', message: 'No podes mandarte una notificacion a vos mismo' } });
    }

    const { rows: target } = await db.query(
      'SELECT id FROM users WHERE id = $1 AND activo = TRUE',
      [to_user_id]
    );
    if (target.length === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Usuario no encontrado' } });
    }

    const titulo = type === 'toque' ? '👋 Te mandaron un toque' : (message || type);
    const cuerpo = message || '';

    await db.query(`
      INSERT INTO notifications (user_id, tipo, titulo, cuerpo, data)
      VALUES ($1, $2, $3, $4, $5)
    `, [to_user_id, type, titulo, cuerpo, JSON.stringify({ from_user_id: req.user.id })]);

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('POST /notifications/send error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── DELETE /notifications/push/unsubscribe ────────────────────
router.delete('/push/unsubscribe', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM push_subscriptions WHERE user_id=$1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;
