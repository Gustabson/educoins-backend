const db = require('../config/db');
const { createDoubleEntry } = require('./ledger');
const {
  assertSufficientBalance,
  getAccountByUserId,
  lockAccountsForUpdate,
} = require('./balance');

async function getLegacyEscrowAccount(escrowTxId, client) {
  const { rows } = await client.query(
    `SELECT le.account_id
       FROM ledger_entries le
       JOIN accounts a ON a.id=le.account_id
      WHERE le.transaction_id=$1 AND le.amount > 0
        AND a.account_type IN ('escrow','treasury')
      ORDER BY CASE WHEN a.account_type='escrow' THEN 0 ELSE 1 END
      LIMIT 1`,
    [escrowTxId]
  );
  return rows[0]?.account_id;
}

/** Releases inventory reserved by unpaid P2P orders. */
async function expirePendingOrders(limit = 100) {
  const client = await db.getClient();
  let expired = 0;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT po.id, po.offer_id, po.seller_id, po.amount,
              pf.status AS offer_status, pf.escrow_tx_id
         FROM p2p_orders po
         JOIN p2p_offers pf ON pf.id=po.offer_id
        WHERE po.status='pending_payment' AND po.payment_deadline <= NOW()
        ORDER BY po.payment_deadline
        FOR UPDATE OF po SKIP LOCKED
        LIMIT $1`,
      [limit]
    );

    for (const order of rows) {
      const amount = Number(order.amount);
      if (order.offer_status === 'cancelled') {
        const escrowAccount = await getLegacyEscrowAccount(order.escrow_tx_id, client);
        const sellerAccount = await getAccountByUserId(order.seller_id, client);
        if (!escrowAccount) throw new Error(`Garantía faltante para la orden ${order.id}`);
        await lockAccountsForUpdate([escrowAccount, sellerAccount], client);
        await assertSufficientBalance(escrowAccount, amount, client);
        await createDoubleEntry(client, {
          type: 'escrow_return',
          description: 'P2P: devolución automática por orden vencida',
          initiatedBy: null,
          entries: [
            { accountId: escrowAccount, amount: -amount },
            { accountId: sellerAccount, amount },
          ],
          meta: { orderId: order.id, automatic: true },
        });
      } else {
        await client.query(
          `UPDATE p2p_offers
              SET amount=amount+$1,
                  status=CASE WHEN status='completed' THEN 'active' ELSE status END,
                  updated_at=NOW()
            WHERE id=$2`,
          [amount, order.offer_id]
        );
      }
      await client.query(
        `UPDATE p2p_orders SET status='expired', updated_at=NOW() WHERE id=$1`,
        [order.id]
      );
      expired += 1;
    }

    await client.query('COMMIT');
    return expired;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { expirePendingOrders };
