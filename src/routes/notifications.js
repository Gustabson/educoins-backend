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

// ── GET /notifications/badge-counts ──────────────────────────
// Returns unread/pending counts per section for the nav badges.
// Works for all roles; some counts are role-specific.
router.get('/badge-counts', auth, async (req, res) => {
  try {
    const uid = req.user.id;
    const rol = req.user.rol;

    // Run all counts in parallel
    const [diwyRes, verdictRes, sugRes, postRes, exchRes, contactoRes] = await Promise.all([
      // Diwy: unread diwy_reply notifications
      db.query(
        `SELECT COUNT(*)::int AS cnt FROM notifications WHERE user_id=$1 AND tipo='diwy_reply' AND leida=false`,
        [uid]
      ),
      // Veredictos: parents see unread verdicts for their children; others see own
      rol === 'parent'
        ? db.query(`
            SELECT COUNT(*)::int AS cnt FROM verdicts v
            JOIN parent_student_links psl ON psl.student_id = v.to_user_id
            WHERE psl.parent_id = $1 AND v.read_at IS NULL
          `, [uid])
        : db.query(
            `SELECT COUNT(*)::int AS cnt FROM verdicts WHERE to_user_id=$1 AND read_at IS NULL`,
            [uid]
          ),
      // Sugerencias: unread notifications of suggestion tipos
      db.query(
        `SELECT COUNT(*)::int AS cnt FROM notifications
         WHERE user_id=$1 AND tipo IN ('sugerencia','mejora_educativa','mejora_convivencia') AND leida=false`,
        [uid]
      ),
      // Noticias: posts published in the last 7 days (no per-user read tracking)
      db.query(`SELECT COUNT(*)::int AS cnt FROM posts WHERE created_at > NOW() - INTERVAL '7 days'`),
      // Exchange: orders that need this user's action
      db.query(
        `SELECT COUNT(*)::int AS cnt FROM p2p_orders
         WHERE (buyer_id=$1  AND status='pending_payment')
            OR (seller_id=$1 AND status='payment_sent')`,
        [uid]
      ),
      // Contacto: unread messages from teacher or admin (parent only)
      rol === 'parent'
        ? db.query(`
            SELECT (
              (SELECT COUNT(*)::int FROM parent_teacher_messages
               WHERE parent_id=$1 AND sender_role='teacher' AND read_at IS NULL)
              +
              (SELECT COUNT(*)::int FROM parent_admin_contacts
               WHERE parent_id=$1 AND sender_role='admin' AND read_at IS NULL)
            ) AS cnt
          `, [uid])
        : Promise.resolve({ rows: [{ cnt: 0 }] }),
    ]);

    res.json({ ok: true, data: {
      diwy:       diwyRes.rows[0].cnt,
      veredictos: verdictRes.rows[0].cnt,
      sugerencias:sugRes.rows[0].cnt,
      noticias:   postRes.rows[0].cnt,
      exchange:   exchRes.rows[0].cnt,
      contacto:   contactoRes.rows[0].cnt,
    }});
  } catch (e) {
    console.error('[badge-counts]', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

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

    // Emitir en tiempo real al destinatario
    const { getIO } = require('../socket');
    const io = getIO();
    if (io) {
      io.to(`user:${to_user_id}`).emit('notification', {
        type,
        titulo,
        cuerpo,
        from: req.user.nombre,
        from_user_id: req.user.id,
      });
    }

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
