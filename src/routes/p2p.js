// src/routes/p2p.js — Exchange P2P de EduCoins
const router = require('express').Router();
const db     = require('../config/db');
const auth   = require('../middleware/auth');
const roles  = require('../middleware/roles');
const { v4: uuidv4 } = require('uuid');

const ORDER_TIMEOUT_MIN = 30; // minutos para pagar

// ── Helpers ────────────────────────────────────────────────────
async function getConfig() {
  const { rows } = await db.query('SELECT * FROM p2p_config LIMIT 1');
  return rows[0] || { activo:false, min_amount:10, max_amount:10000, fee_percent:0 };
}

async function getUserAccount(userId, client) {
  const q = client || db;
  const { rows } = await q.query(
    `SELECT a.id FROM accounts a WHERE a.user_id=$1 AND a.is_active=true LIMIT 1`, [userId]);
  return rows[0]?.id;
}

async function getBalance(userId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(le.amount),0)::integer AS bal
     FROM ledger_entries le
     JOIN accounts a ON a.id=le.account_id
     WHERE a.user_id=$1`, [userId]);
  return rows[0]?.bal || 0;
}

async function getTreasury(client) {
  const q = client || db;
  const { rows } = await q.query(
    `SELECT id FROM accounts WHERE account_type='treasury' LIMIT 1`);
  return rows[0]?.id;
}

// ── GET /p2p/config ────────────────────────────────────────────
router.get('/config', auth, async (req, res) => {
  try {
    const cfg = await getConfig();
    res.json({ ok:true, data: cfg });
  } catch(e) { res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} }); }
});

// ── PATCH /p2p/config (admin) ──────────────────────────────────
router.patch('/config', auth, roles('admin'), async (req, res) => {
  try {
    const { activo, min_amount, max_amount, order_timeout, fee_percent } = req.body;
    await db.query(
      `UPDATE p2p_config SET
        activo=COALESCE($1,activo), min_amount=COALESCE($2,min_amount),
        max_amount=COALESCE($3,max_amount), order_timeout=COALESCE($4,order_timeout),
        fee_percent=COALESCE($5,fee_percent), updated_at=NOW()`,
      [activo??null, min_amount||null, max_amount||null, order_timeout||null, fee_percent??null]
    );
    res.json({ ok:true, data: await getConfig() });
  } catch(e) { res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} }); }
});

// ── GET /p2p/offers — listar ofertas activas ──────────────────
router.get('/offers', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT o.*,
        u.nombre AS seller_nombre, u.apodo AS seller_apodo,
        u.skin AS seller_skin, u.border AS seller_border, u.avatar_bg AS seller_avatar_bg,
        COALESCE(r.avg_score,5)::numeric(3,1) AS seller_rating,
        COALESCE(r.total,0)::int AS seller_trades
      FROM p2p_offers o
      JOIN users u ON u.id=o.seller_id
      LEFT JOIN (
        SELECT rated_id, AVG(score) AS avg_score, COUNT(*) AS total
        FROM p2p_ratings GROUP BY rated_id
      ) r ON r.rated_id=o.seller_id
      WHERE o.status='active' AND o.seller_id != $1
      ORDER BY o.created_at DESC
    `, [req.user.id]);
    res.json({ ok:true, data: rows });
  } catch(e) { res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} }); }
});

// ── GET /p2p/my-offers ─────────────────────────────────────────
router.get('/my-offers', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM p2p_offers WHERE seller_id=$1 ORDER BY created_at DESC`,
      [req.user.id]);
    res.json({ ok:true, data: rows });
  } catch(e) { res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} }); }
});

// ── POST /p2p/offers — crear oferta ───────────────────────────
router.post('/offers', auth, roles('student','teacher'), async (req, res) => {
  const { amount, price_ars, min_order, max_order, payment_methods, instructions } = req.body;
  if (!amount||!price_ars) return res.status(400).json({ ok:false, error:{code:'MISSING_FIELDS'} });

  const cfg = await getConfig();
  if (!cfg.activo) return res.status(403).json({ ok:false, error:{code:'P2P_DISABLED', message:'El exchange está desactivado'} });
  if (amount < cfg.min_amount) return res.status(400).json({ ok:false, error:{code:'AMOUNT_TOO_LOW', message:`Mínimo ${cfg.min_amount} EduCoins`} });
  if (amount > cfg.max_amount) return res.status(400).json({ ok:false, error:{code:'AMOUNT_TOO_HIGH', message:`Máximo ${cfg.max_amount} EduCoins`} });

  const bal = await getBalance(req.user.id);
  if (bal < amount) return res.status(400).json({ ok:false, error:{code:'INSUFFICIENT_BALANCE', message:`Saldo insuficiente (tenés ${bal} EduCoins)`} });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Bloquear monedas en escrow (transfer a cuenta escrow del sistema)
    const sellerAcc = await getUserAccount(req.user.id, client);
    const treasury  = await getTreasury(client);
    const txId = uuidv4();
    await client.query(
      `INSERT INTO transactions (id,type,description,initiated_by) VALUES ($1,'escrow','P2P escrow - oferta publicada',$2)`,
      [txId, req.user.id]);
    await client.query(
      `INSERT INTO ledger_entries (transaction_id,account_id,amount) VALUES ($1,$2,$3),($1,$4,$5)`,
      [txId, sellerAcc, -amount, treasury, amount]);

    const { rows } = await client.query(
      `INSERT INTO p2p_offers (seller_id,amount,price_ars,min_order,max_order,payment_methods,instructions,escrow_tx_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, amount, price_ars, min_order||1, max_order||amount,
       payment_methods||['transferencia','efectivo'], instructions||null, txId]);

    await client.query('COMMIT');
    res.status(201).json({ ok:true, data: rows[0] });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} });
  } finally { client.release(); }
});

// ── PATCH /p2p/offers/:id/pause ───────────────────────────────
router.patch('/offers/:id/pause', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE p2p_offers SET status=CASE WHEN status='active' THEN 'paused' ELSE 'active' END, updated_at=NOW()
       WHERE id=$1 AND seller_id=$2 RETURNING *`,
      [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ ok:false, error:{code:'NOT_FOUND'} });
    res.json({ ok:true, data: rows[0] });
  } catch(e) { res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} }); }
});

// ── DELETE /p2p/offers/:id — cancelar oferta + devolver escrow ─
router.delete('/offers/:id', auth, async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows: offer } = await client.query(
      `SELECT * FROM p2p_offers WHERE id=$1 AND seller_id=$2`, [req.params.id, req.user.id]);
    if (!offer.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok:false }); }
    if (offer[0].status !== 'active' && offer[0].status !== 'paused')
      { await client.query('ROLLBACK'); return res.status(400).json({ ok:false, error:{code:'CANNOT_CANCEL'} }); }

    // Devolver escrow al vendedor
    const sellerAcc = await getUserAccount(req.user.id, client);
    const treasury  = await getTreasury(client);
    const txId = uuidv4();
    await client.query(
      `INSERT INTO transactions (id,type,description,initiated_by) VALUES ($1,'escrow_return','P2P escrow devuelto - oferta cancelada',$2)`,
      [txId, req.user.id]);
    await client.query(
      `INSERT INTO ledger_entries (transaction_id,account_id,amount) VALUES ($1,$2,$3),($1,$4,$5)`,
      [txId, treasury, -offer[0].amount, sellerAcc, offer[0].amount]);

    await client.query(`UPDATE p2p_offers SET status='cancelled', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok:true });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} });
  } finally { client.release(); }
});

// ── POST /p2p/offers/:id/order — crear orden (comprador acepta) ─
router.post('/offers/:id/order', auth, async (req, res) => {
  // Castear a entero — llega como string desde el body JSON
  const amount = parseInt(req.body.amount, 10);
  if (!amount || amount < 1) return res.status(400).json({ ok:false, error:{code:'MISSING_AMOUNT'} });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Buscar la oferta sin filtrar por status — validar después
    // Esto evita que una oferta "completed" por compra exacta bloquee reintentos
    const { rows: offer } = await client.query(
      `SELECT * FROM p2p_offers WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!offer.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok:false, error:{code:'OFFER_NOT_FOUND'} });
    }
    const o = offer[0];

    // Validar que la oferta sigue disponible
    if (!['active','paused'].includes(o.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok:false, error:{code:'OFFER_NOT_AVAILABLE',
        message:'Esta oferta ya no está disponible'} });
    }
    if (o.status === 'paused') {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok:false, error:{code:'OFFER_PAUSED',
        message:'Esta oferta está pausada'} });
    }

    const offerAmount = parseInt(o.amount, 10);
    if (offerAmount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok:false, error:{code:'OFFER_EMPTY',
        message:'No hay EduCoins disponibles en esta oferta'} });
    }

    const minOrder = parseInt(o.min_order, 10) || 1;
    const maxOrder = Math.min(
      o.max_order ? parseInt(o.max_order, 10) : offerAmount,
      offerAmount  // nunca más que lo disponible
    );

    if (o.seller_id === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok:false, error:{code:'CANT_BUY_OWN'} });
    }
    if (amount < minOrder || amount > maxOrder) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok:false, error:{code:'INVALID_AMOUNT',
        message:`Cantidad entre ${minOrder} y ${maxOrder} EduCoins`} });
    }

    const deadline = new Date(Date.now() + ORDER_TIMEOUT_MIN * 60000);
    const { rows } = await client.query(
      `INSERT INTO p2p_orders (offer_id,buyer_id,seller_id,amount,price_ars,total_ars,payment_deadline)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [o.id, req.user.id, o.seller_id,
       amount,
       parseFloat(o.price_ars),
       parseFloat((amount * parseFloat(o.price_ars)).toFixed(2)),
       deadline]);

    // Reducir disponible — si llega a 0 pasa a 'completed'
    const newAmount = offerAmount - amount;
    await client.query(
      `UPDATE p2p_offers
       SET amount=$1, updated_at=NOW(),
           status=CASE WHEN $1 <= 0 THEN 'completed' ELSE status END
       WHERE id=$2`,
      [newAmount, o.id]);

    await client.query('COMMIT');

    // Notificar al vendedor: nueva orden
    try {
      const { getIO } = require('../socket');
      const io = getIO();
      if (io) {
        io.to(`user:${o.seller_id}`).emit('p2p_update', {
          type: 'new_order', orderId: rows[0].id,
          amount, buyer: req.user.nombre
        });
      }
    } catch(e) {}

    res.status(201).json({ ok:true, data: rows[0] });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} });
  } finally { client.release(); }
});

// ── GET /p2p/orders — mis órdenes ────────────────────────────
router.get('/orders', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT o.*,
        s.nombre AS seller_nombre, s.apodo AS seller_apodo,
        b.nombre AS buyer_nombre,  b.apodo AS buyer_apodo,
        s.skin AS seller_skin, s.border AS seller_border,
        b.skin AS buyer_skin,  b.border AS buyer_border
      FROM p2p_orders o
      JOIN users s ON s.id=o.seller_id
      JOIN users b ON b.id=o.buyer_id
      WHERE o.buyer_id=$1 OR o.seller_id=$1
      ORDER BY o.created_at DESC LIMIT 50
    `, [req.user.id]);
    res.json({ ok:true, data: rows });
  } catch(e) { res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} }); }
});

// ── PATCH /p2p/orders/:id/payment-sent — comprador marcó pago ─
router.patch('/orders/:id/payment-sent', auth, async (req, res) => {
  try {
    const { comprobante_url } = req.body;
    const { rows } = await db.query(
      `UPDATE p2p_orders SET status='payment_sent', comprobante_url=$1, updated_at=NOW()
       WHERE id=$2 AND buyer_id=$3 AND status='pending_payment' RETURNING *`,
      [comprobante_url||null, req.params.id, req.user.id]);
    if (!rows.length) return res.status(400).json({ ok:false, error:{code:'INVALID_STATE'} });

    // Notificar al vendedor en tiempo real
    try {
      const { getIO } = require('../socket');
      const io = getIO();
      if (io) {
        io.to(`user:${rows[0].seller_id}`).emit('p2p_update', {
          type: 'payment_sent', orderId: rows[0].id
        });
      }
    } catch(e) {}

    res.json({ ok:true, data: rows[0] });
  } catch(e) { res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} }); }
});

// ── PATCH /p2p/orders/:id/release — vendedor libera monedas ───
router.patch('/orders/:id/release', auth, async (req, res) => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows: order } = await client.query(
      `SELECT * FROM p2p_orders WHERE id=$1 AND seller_id=$2 AND status='payment_sent' FOR UPDATE`,
      [req.params.id, req.user.id]);
    if (!order.length) { await client.query('ROLLBACK'); return res.status(400).json({ ok:false, error:{code:'INVALID_STATE'} }); }
    const o = order[0];

    // Transferir monedas del escrow al comprador
    const buyerAcc  = await getUserAccount(o.buyer_id, client);
    const treasury  = await getTreasury(client);
    const txId = uuidv4();
    await client.query(
      `INSERT INTO transactions (id,type,description,initiated_by) VALUES ($1,'p2p_release','P2P: monedas liberadas al comprador',$2)`,
      [txId, req.user.id]);
    await client.query(
      `INSERT INTO ledger_entries (transaction_id,account_id,amount) VALUES ($1,$2,$3),($1,$4,$5)`,
      [txId, treasury, -o.amount, buyerAcc, o.amount]);
    // Update buyer total_earned
    await client.query('UPDATE users SET total_earned=total_earned+$1 WHERE id=$2', [o.amount, o.buyer_id]);

    await client.query(
      `UPDATE p2p_orders SET status='completed', release_tx_id=$1, updated_at=NOW() WHERE id=$2`,
      [txId, o.id]);

    await client.query('COMMIT');

    // Notificar a comprador y vendedor en tiempo real
    try {
      const { getIO } = require('../socket');
      const io = getIO();
      if (io) {
        const payload = { type: 'order_completed', orderId: o.id, amount: o.amount };
        io.to(`user:${o.buyer_id}`).emit('p2p_update', payload);
        io.to(`user:${o.seller_id}`).emit('p2p_update', payload);
      }
    } catch(e) {}

    res.json({ ok:true, data: { txId, amount: o.amount } });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} });
  } finally { client.release(); }
});

// ── PATCH /p2p/orders/:id/dispute — abrir disputa ─────────────
router.patch('/orders/:id/dispute', auth, async (req, res) => {
  try {
    const { reason } = req.body;
    const { rows } = await db.query(
      `UPDATE p2p_orders SET status='disputed', dispute_reason=$1, updated_at=NOW()
       WHERE id=$2 AND (buyer_id=$3 OR seller_id=$3)
       AND status IN ('payment_sent','pending_payment') RETURNING *`,
      [reason||'Sin motivo especificado', req.params.id, req.user.id]);
    if (!rows.length) return res.status(400).json({ ok:false, error:{code:'INVALID_STATE'} });

    // Notificar a ambas partes y admins
    try {
      const { getIO } = require('../socket');
      const io = getIO();
      if (io) {
        const payload = { type: 'disputed', orderId: rows[0].id, reason };
        io.to(`user:${rows[0].buyer_id}`).emit('p2p_update', payload);
        io.to(`user:${rows[0].seller_id}`).emit('p2p_update', payload);
        io.emit('p2p_dispute', payload);
      }
    } catch(e) {}

    res.json({ ok:true, data: rows[0] });
  } catch(e) { res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} }); }
});

// ── PATCH /p2p/orders/:id/resolve — moderador resuelve disputa ─
router.patch('/orders/:id/resolve', auth, roles('admin','teacher'), async (req, res) => {
  const { winner } = req.body; // 'buyer' | 'seller'
  if (!['buyer','seller'].includes(winner))
    return res.status(400).json({ ok:false, error:{code:'INVALID_WINNER'} });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows: order } = await client.query(
      `SELECT * FROM p2p_orders WHERE id=$1 AND status='disputed' FOR UPDATE`, [req.params.id]);
    if (!order.length) { await client.query('ROLLBACK'); return res.status(404).json({ ok:false }); }
    const o = order[0];

    const treasury   = await getTreasury(client);
    const buyerAcc   = await getUserAccount(o.buyer_id, client);
    const sellerAcc  = await getUserAccount(o.seller_id, client);
    const txId = uuidv4();
    const recipientId   = winner === 'buyer' ? o.buyer_id : o.seller_id;
    const recipientAcc  = winner === 'buyer' ? buyerAcc : sellerAcc;

    await client.query(
      `INSERT INTO transactions (id,type,description,initiated_by) VALUES ($1,'p2p_resolve','P2P disputa resuelta por moderador',$2)`,
      [txId, req.user.id]);
    await client.query(
      `INSERT INTO ledger_entries (transaction_id,account_id,amount) VALUES ($1,$2,$3),($1,$4,$5)`,
      [txId, treasury, -o.amount, recipientAcc, o.amount]);
    if (winner === 'buyer')
      await client.query('UPDATE users SET total_earned=total_earned+$1 WHERE id=$2', [o.amount, o.buyer_id]);

    const newStatus = winner === 'buyer' ? 'completed' : 'refunded';
    await client.query(
      `UPDATE p2p_orders SET status=$1, dispute_resolved_by=$2, release_tx_id=$3, updated_at=NOW() WHERE id=$4`,
      [newStatus, req.user.id, txId, o.id]);

    await client.query('COMMIT');
    res.json({ ok:true, data: { winner, newStatus } });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} });
  } finally { client.release(); }
});

// ── POST /p2p/orders/:id/rate — calificar ─────────────────────
router.post('/orders/:id/rate', auth, async (req, res) => {
  try {
    const { score, comment } = req.body;
    const { rows: order } = await db.query(
      `SELECT * FROM p2p_orders WHERE id=$1 AND status='completed'
       AND (buyer_id=$2 OR seller_id=$2)`, [req.params.id, req.user.id]);
    if (!order.length) return res.status(400).json({ ok:false, error:{code:'INVALID'} });
    const o = order[0];
    const ratedId = o.buyer_id === req.user.id ? o.seller_id : o.buyer_id;
    await db.query(
      `INSERT INTO p2p_ratings (order_id,rater_id,rated_id,score,comment) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (order_id, rater_id) DO UPDATE SET score=$4,comment=$5`,
      [o.id, req.user.id, ratedId, score, comment||null]);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} }); }
});

// ── GET /p2p/admin/orders — admin ve todas las órdenes ─────────
router.get('/admin/orders', auth, roles('admin'), async (req, res) => {
  try {
    const { status } = req.query;
    const { rows } = await db.query(`
      SELECT o.*,
        s.nombre AS seller_nombre, b.nombre AS buyer_nombre
      FROM p2p_orders o
      JOIN users s ON s.id=o.seller_id
      JOIN users b ON b.id=o.buyer_id
      ${status ? `WHERE o.status=$1` : ''}
      ORDER BY o.created_at DESC LIMIT 100
    `, status ? [status] : []);
    res.json({ ok:true, data: rows });
  } catch(e) { res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} }); }
});

// ── GET /p2p/market — datos públicos del mercado (sin identidades) ─
// Retorna: último precio, variación 24h, volumen, trades recientes, historial de precios
router.get('/market', auth, async (req, res) => {
  try {
    // Trades completados recientes (sin nombres — solo para alumnos)
    const { rows: trades } = await db.query(`
      SELECT
        o.amount,
        o.price_ars,
        o.total_ars,
        o.updated_at AS executed_at
      FROM p2p_orders o
      WHERE o.status = 'completed'
      ORDER BY o.updated_at DESC
      LIMIT 50
    `);

    // Último precio negociado
    const lastTrade = trades[0] || null;
    const lastPrice = lastTrade ? parseFloat(lastTrade.price_ars) : null;

    // Precio hace 24 horas (primer trade completado antes de 24h)
    const { rows: prev24 } = await db.query(`
      SELECT price_ars FROM p2p_orders
      WHERE status='completed' AND updated_at <= NOW() - INTERVAL '24 hours'
      ORDER BY updated_at DESC LIMIT 1
    `);
    const price24h = prev24[0] ? parseFloat(prev24[0].price_ars) : lastPrice;
    const change24h = lastPrice && price24h
      ? (((lastPrice - price24h) / price24h) * 100).toFixed(2)
      : "0.00";

    // Volumen 24h (EduCoins negociadas)
    const { rows: vol } = await db.query(`
      SELECT
        COALESCE(SUM(amount), 0)::integer AS vol_edu,
        COALESCE(SUM(total_ars), 0)::numeric(12,2) AS vol_ars,
        COUNT(*)::integer AS trade_count
      FROM p2p_orders
      WHERE status='completed' AND updated_at >= NOW() - INTERVAL '24 hours'
    `);

    // Historial de precios: 1 punto por hora, últimas 24 horas
    const { rows: history } = await db.query(`
      SELECT
        DATE_TRUNC('hour', updated_at) AS hora,
        AVG(price_ars)::numeric(10,2) AS precio_promedio,
        SUM(amount)::integer AS volumen,
        COUNT(*)::integer AS trades
      FROM p2p_orders
      WHERE status='completed' AND updated_at >= NOW() - INTERVAL '24 hours'
      GROUP BY hora
      ORDER BY hora ASC
    `);

    // Mejor oferta activa (precio más bajo disponible para comprar)
    const { rows: bestOffer } = await db.query(`
      SELECT MIN(price_ars)::numeric(10,2) AS mejor_precio,
             COUNT(*)::integer AS ofertas_activas,
             SUM(amount)::integer AS edu_disponibles
      FROM p2p_offers
      WHERE status='active'
    `);

    res.json({
      ok: true,
      data: {
        last_price:      lastPrice,
        change_24h:      parseFloat(change24h),
        volume_24h_edu:  parseInt(vol[0]?.vol_edu || 0),
        volume_24h_ars:  parseFloat(vol[0]?.vol_ars || 0),
        trade_count_24h: parseInt(vol[0]?.trade_count || 0),
        best_offer_price: bestOffer[0]?.mejor_precio ? parseFloat(bestOffer[0].mejor_precio) : null,
        active_offers:   parseInt(bestOffer[0]?.ofertas_activas || 0),
        edu_disponibles: parseInt(bestOffer[0]?.edu_disponibles || 0),
        price_history:   history.map(h => ({
          hora:   h.hora,
          precio: parseFloat(h.precio_promedio),
          volumen: h.volumen,
          trades:  h.trades,
        })),
        recent_trades: trades.slice(0, 20).map(t => ({
          amount:      t.amount,
          price_ars:   parseFloat(t.price_ars),
          total_ars:   parseFloat(t.total_ars),
          executed_at: t.executed_at,
        })),
      }
    });
  } catch(e) { res.status(500).json({ ok:false, error:{code:'SERVER_ERROR',message:e.message} }); }
});

// ── GET /p2p/orders/:id/detail — detalle completo para admin/moderador ─
router.get('/orders/:id/detail', auth, roles('admin','teacher'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        o.*,
        -- Comprador
        b.nombre        AS buyer_nombre,
        b.apodo         AS buyer_apodo,
        b.email         AS buyer_email,
        ba.id           AS buyer_account_id,
        -- Vendedor
        s.nombre        AS seller_nombre,
        s.apodo         AS seller_apodo,
        s.email         AS seller_email,
        sa.id           AS seller_account_id,
        -- Transacción de liberación
        tx.id           AS release_tx_id,
        tx.type         AS release_tx_type,
        tx.created_at   AS release_tx_date,
        tx.initiated_by AS release_tx_by,
        -- Transacción de escrow original
        etx.id          AS escrow_tx_id,
        etx.created_at  AS escrow_tx_date,
        -- Oferta original
        of2.price_ars   AS original_price,
        of2.payment_methods,
        of2.instructions AS offer_instructions,
        -- Moderador que resolvió (si hubo disputa)
        mod.nombre      AS resolved_by_nombre
      FROM p2p_orders o
      JOIN users b  ON b.id = o.buyer_id
      JOIN users s  ON s.id = o.seller_id
      LEFT JOIN accounts ba  ON ba.user_id = o.buyer_id  AND ba.account_type = 'student'
      LEFT JOIN accounts sa  ON sa.user_id = o.seller_id AND sa.account_type = 'student'
      LEFT JOIN transactions tx  ON tx.id = o.release_tx_id
      LEFT JOIN p2p_offers of2   ON of2.id = o.offer_id
      LEFT JOIN transactions etx ON etx.id = of2.escrow_tx_id
      LEFT JOIN users mod ON mod.id = o.dispute_resolved_by
      WHERE o.id = $1
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ ok:false, error:{code:'NOT_FOUND'} });

    // Ledger entries de esta orden
    const { rows: entries } = await db.query(`
      SELECT le.*, a.account_type, u.nombre AS account_owner
      FROM ledger_entries le
      JOIN accounts a ON a.id = le.account_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE le.transaction_id = $1 OR le.transaction_id = $2
      ORDER BY le.created_at ASC
    `, [rows[0].release_tx_id, rows[0].escrow_tx_id].filter(Boolean));

    res.json({ ok:true, data: { order: rows[0], ledger_entries: entries } });
  } catch(e) {
    res.status(500).json({ ok:false, error:{code:'SERVER_ERROR', message:e.message} });
  }
});

module.exports = router;
