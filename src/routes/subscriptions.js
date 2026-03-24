// src/routes/subscriptions.js
// POST /api/v1/subscriptions/subscribe    -> suscribirse a un item
// GET  /api/v1/subscriptions/me           -> mis suscripciones activas
// DELETE /api/v1/subscriptions/:id        -> cancelar suscripción
// POST /api/v1/subscriptions/charge-all   -> cobrar todas las suscripciones vencidas (admin/cron)

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');
const { getAccountByUserId, assertSufficientBalance, getTreasuryAccountId } = require('../services/balance');
const { v4: uuidv4 } = require('uuid');
const { getIO } = require('../socket');

// ── POST /subscriptions/subscribe ────────────────────────────
router.post('/subscribe', auth, async (req, res) => {
  const client = await db.getClient();
  try {
    const { item_id, periodo } = req.body;
    if (!item_id || !periodo)
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS' } });

    const { rows: item } = await db.query(
      'SELECT * FROM shop_items_custom WHERE id=$1 AND activo=TRUE AND es_suscripcion=TRUE', [item_id]
    );
    if (!item.length)
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Item no encontrado o no es suscripción' } });

    const precio = periodo === 'weekly'  ? item[0].precio_semanal
                 : periodo === 'monthly' ? item[0].precio_mensual
                 : periodo === 'annual'  ? item[0].precio_anual
                 : item[0].precio_mensual;

    if (precio === null || precio === undefined)
      return res.status(400).json({ ok: false, error: { code: 'NO_PRICE', message: 'Precio no configurado para este período' } });

    // Verificar saldo
    const accId = await getAccountByUserId(req.user.id, client);
    if (precio > 0) await assertSufficientBalance(accId, precio, client);

    await client.query('BEGIN');

    // Cobrar primer pago si tiene precio
    if (precio > 0) {
      const treasuryId = await getTreasuryAccountId(client);
      const txId = uuidv4();
      await client.query(`INSERT INTO transactions (id,type,description,initiated_by,metadata) VALUES ($1,'purchase',$2,$3,$4)`,
        [txId, `Suscripción ${item[0].nombre} (${periodo})`, req.user.id,
         JSON.stringify({ suscripcion: true, item_id, periodo, precio })]);
      await client.query('INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)',
        [uuidv4(), txId, accId, -precio]);
      await client.query('INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)',
        [uuidv4(), txId, treasuryId, precio]);
    }

    // Calcular próximo cobro
    const nextCharge = new Date();
    if (periodo === 'weekly')  nextCharge.setDate(nextCharge.getDate() + 7);
    else if (periodo === 'monthly') nextCharge.setMonth(nextCharge.getMonth() + 1);
    else if (periodo === 'annual')  nextCharge.setFullYear(nextCharge.getFullYear() + 1);

    // Crear o reactivar suscripción
    const { rows: sub } = await client.query(`
      INSERT INTO subscriptions (user_id, item_id, periodo, precio, next_charge, last_charge)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (user_id, item_id) DO UPDATE SET
        activo=TRUE, periodo=$3, precio=$4, next_charge=$5, last_charge=NOW()
      RETURNING *
    `, [req.user.id, item_id, periodo, precio, nextCharge]);

    // Agregar el item a user_custom_items si no lo tiene
    await client.query(`
      INSERT INTO user_custom_items (user_id, item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING
    `, [req.user.id, item_id]);

    await client.query('COMMIT');

    res.status(201).json({ ok: true, data: {
      subscription: sub[0],
      mensaje: `Suscripción activada: ${item[0].nombre}`,
      proximo_cobro: nextCharge,
    }});
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: { code: err.code||'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

// ── GET /subscriptions/me ─────────────────────────────────────
router.get('/me', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT s.id, s.periodo, s.precio, s.next_charge, s.last_charge, s.activo,
             i.nombre AS item_nombre, i.tipo AS item_tipo, i.preview AS item_preview
      FROM subscriptions s
      JOIN shop_items_custom i ON i.id=s.item_id
      WHERE s.user_id=$1 AND s.activo=TRUE
      ORDER BY s.created_at DESC
    `, [req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── DELETE /subscriptions/:id ─────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    const { rowCount } = await db.query(
      'UPDATE subscriptions SET activo=FALSE WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND' } });
    res.json({ ok: true, data: { mensaje: 'Suscripción cancelada. El item permanece hasta el próximo período.' } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /subscriptions/charge-all ───────────────────────────
// Cobrar todas las suscripciones vencidas — llamar desde cron diario o admin
router.post('/charge-all', auth, roles('admin'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { rows: due } = await client.query(`
      SELECT s.*, u.nombre AS user_nombre, i.nombre AS item_nombre
      FROM subscriptions s
      JOIN users u ON u.id=s.user_id
      JOIN shop_items_custom i ON i.id=s.item_id
      WHERE s.activo=TRUE AND s.next_charge <= NOW() AND s.precio > 0
      LIMIT 100
    `);

    const io = getIO();
    const results = [];
    const treasuryId = await getTreasuryAccountId(client);

    for (const sub of due) {
      try {
        await client.query('BEGIN');
        const accId = await getAccountByUserId(sub.user_id, client);

        // Verificar saldo — si no tiene, cancelar la suscripción
        const { rows: balRows } = await client.query(
          'SELECT COALESCE(SUM(amount),0)::int AS bal FROM ledger_entries WHERE account_id=$1', [accId]
        );
        if (balRows[0].bal < sub.precio) {
          await client.query('UPDATE subscriptions SET activo=FALSE WHERE id=$1', [sub.id]);
          await client.query('COMMIT');
          results.push({ user: sub.user_nombre, item: sub.item_nombre, status: 'cancelled_no_funds' });
          // Notificar
          if (io) io.to(`user:${sub.user_id}`).emit('notification', {
            type: 'tax', amount: 0,
            motivo: `Suscripción cancelada: ${sub.item_nombre} — saldo insuficiente`,
          });
          continue;
        }

        const txId = uuidv4();
        await client.query(`INSERT INTO transactions (id,type,description,initiated_by,metadata) VALUES ($1,'purchase',$2,$3,$4)`,
          [txId, `Renovación ${sub.item_nombre} (${sub.periodo})`, sub.user_id,
           JSON.stringify({ suscripcion: true, renovacion: true, item_id: sub.item_id, periodo: sub.periodo })]);
        await client.query('INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)',
          [uuidv4(), txId, accId, -sub.precio]);
        await client.query('INSERT INTO ledger_entries (id,transaction_id,account_id,amount) VALUES ($1,$2,$3,$4)',
          [uuidv4(), txId, treasuryId, sub.precio]);

        // Calcular próximo cobro
        const next = new Date(sub.next_charge);
        if (sub.periodo === 'weekly')  next.setDate(next.getDate() + 7);
        else if (sub.periodo === 'monthly') next.setMonth(next.getMonth() + 1);
        else if (sub.periodo === 'annual')  next.setFullYear(next.getFullYear() + 1);

        await client.query(
          'UPDATE subscriptions SET next_charge=$1, last_charge=NOW() WHERE id=$2',
          [next, sub.id]
        );

        // Guardar notificación persistente
        await client.query(`INSERT INTO notifications (user_id,tipo,titulo,cuerpo,data) VALUES ($1,'suscripcion',$2,$3,$4)`,
          [sub.user_id,
           `Suscripción renovada: ${sub.item_nombre}`,
           `-🪙${sub.precio} · Próxima renovación: ${next.toLocaleDateString('es-AR')}`,
           JSON.stringify({ precio: sub.precio, item: sub.item_nombre, periodo: sub.periodo })]);

        await client.query('COMMIT');

        if (io) io.to(`user:${sub.user_id}`).emit('notification', {
          type: 'tax', amount: sub.precio,
          motivo: `Renovación automática: ${sub.item_nombre}`,
        });

        results.push({ user: sub.user_nombre, item: sub.item_nombre, precio: sub.precio, status: 'charged', next });
      } catch(e) {
        await client.query('ROLLBACK').catch(()=>{});
        results.push({ user: sub.user_nombre, item: sub.item_nombre, status: 'error', error: e.message });
      }
    }

    res.json({ ok: true, data: { procesados: due.length, results } });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally { client.release(); }
});

module.exports = router;
