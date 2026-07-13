const db = require('../config/db');
const { createDoubleEntry } = require('./ledger');
const {
  getAccountByUserId,
  getBalance,
  getTreasuryAccountId,
  lockAccountsForUpdate,
} = require('./balance');

/** Processes due daily school taxes exactly once, even with multiple instances. */
async function processDueTaxes(limit = 200) {
  const client = await db.getClient();
  const notifications = [];
  try {
    const { rows: due } = await client.query(
      `SELECT id FROM tax_schedules
        WHERE active=TRUE AND remaining_charges > 0 AND next_charge <= NOW()
        ORDER BY next_charge LIMIT $1`,
      [limit]
    );

    for (const candidate of due) {
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `SELECT * FROM tax_schedules
            WHERE id=$1 AND active=TRUE AND remaining_charges > 0 AND next_charge <= NOW()
            FOR UPDATE`,
          [candidate.id]
        );
        if (!rows.length) {
          await client.query('ROLLBACK');
          continue;
        }

        const schedule = rows[0];
        const userAccount = await getAccountByUserId(schedule.user_id, client);
        const treasuryAccount = await getTreasuryAccountId(client);
        await lockAccountsForUpdate([userAccount, treasuryAccount], client);
        const balance = await getBalance(userAccount, client);
        const charged = Math.min(Number(schedule.amount), Math.max(0, Number(balance)));

        if (charged > 0) {
          await createDoubleEntry(client, {
            type: 'tax',
            description: `Impuesto diario: ${schedule.reason}`,
            initiatedBy: schedule.created_by,
            entries: [
              { accountId: userAccount, amount: -charged },
              { accountId: treasuryAccount, amount: charged },
            ],
            meta: { taxScheduleId: schedule.id, automatic: true },
          });
        }

        const remaining = Number(schedule.remaining_charges) - 1;
        await client.query(
          `UPDATE tax_schedules
              SET remaining_charges=$1,
                  active=($1 > 0),
                  next_charge=next_charge+INTERVAL '1 day',
                  updated_at=NOW()
            WHERE id=$2`,
          [remaining, schedule.id]
        );
        await client.query(
          `INSERT INTO notifications (user_id,tipo,titulo,cuerpo,data)
           VALUES ($1,'tax',$2,$3,$4)`,
          [schedule.user_id,
           charged > 0 ? `Impuesto diario: -🪙${charged}` : 'Impuesto diario sin cobro',
           charged > 0 ? `Motivo: ${schedule.reason}` : `No había saldo disponible. Motivo: ${schedule.reason}`,
           JSON.stringify({ amount: charged, motivo: schedule.reason, automatic: true, remaining })]
        );
        await client.query('COMMIT');
        notifications.push({ userId: schedule.user_id, amount: charged, motivo: schedule.reason });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`Error procesando impuesto ${candidate.id}:`, error.message);
      }
    }

    if (notifications.length) {
      const { getIO } = require('../socket');
      const io = getIO();
      for (const item of notifications) {
        io?.to(`user:${item.userId}`).emit('notification', {
          type: 'tax', amount: item.amount, motivo: item.motivo, automatic: true,
        });
      }
    }
    return notifications.length;
  } finally {
    client.release();
  }
}

module.exports = { processDueTaxes };
