// src/services/ledger.js
// El motor financiero del sistema.
// Toda operación que mueva monedas pasa por aquí.
// NUNCA se llama directamente desde las rutas — siempre desde los servicios.

const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const {
  assertSufficientBalance,
  lockAccountsForUpdate,
  getTreasuryAccountId,
  getAccountByUserId,
} = require('./balance');
const audit = require('./audit');

// Importar io de socket para notificaciones en tiempo real
function notifyUser(userId, payload) {
  try {
    const { getIO } = require('../socket');
    const io = getIO();
    if (io) io.to(`user:${userId}`).emit('notification', payload);
  } catch(e) {}
}

/**
 * Crea una transacción de doble entrada en la base de datos.
 * Es la función base — todas las demás la usan internamente.
 *
 * @param {object} client     - cliente de BD (siempre dentro de BEGIN/COMMIT)
 * @param {string} type       - tipo de transacción
 * @param {string} description
 * @param {string} initiatedBy - ID del usuario que inicia
 * @param {Array}  entries    - [{accountId, amount}] deben sumar 0
 * @param {object} [meta]     - datos extra opcionales
 */
async function createDoubleEntry(client, { type, description, initiatedBy, entries, meta = {} }) {
  if (!Array.isArray(entries) || entries.length < 2) {
    const err = new Error('Una transacción de doble entrada requiere al menos dos movimientos');
    err.code = 'INVALID_ENTRIES';
    throw err;
  }
  if (entries.some(e => !e.accountId || !Number.isSafeInteger(e.amount) || e.amount === 0)) {
    const err = new Error('Las entradas del ledger deben usar montos enteros distintos de cero');
    err.code = 'INVALID_LEDGER_ENTRY';
    throw err;
  }
  // Validar que las entradas sumen exactamente 0
  const sum = entries.reduce((acc, e) => acc + e.amount, 0);
  if (sum !== 0) {
    const err = new Error(`Las entradas del ledger deben sumar 0, sumaron ${sum}`);
    err.code = 'UNBALANCED_TRANSACTION';
    throw err;
  }

  // Crear la transacción
  const txId = uuidv4();
  await client.query(
    `INSERT INTO transactions (id, type, description, initiated_by, reference_id, reference_type, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [txId, type, description, initiatedBy, meta.referenceId || null, meta.referenceType || null, JSON.stringify(meta)]
  );

  // Crear las dos (o más) entradas del ledger
  for (const entry of entries) {
    await client.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, amount)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), txId, entry.accountId, entry.amount]
    );
  }

  return txId;
}

// ─────────────────────────────────────────────────────────────
// OPERACIÓN 1: MINT
// Admin crea monedas y las acredita a la Tesorería
// ─────────────────────────────────────────────────────────────
async function mint({ adminId, amount, description }) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    const err = new Error('El monto debe ser un entero positivo');
    err.code = 'INVALID_AMOUNT';
    throw err;
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const treasuryId = await getTreasuryAccountId(client);

    // El mint es la única excepción al doble-entrada puro:
    // acreditamos a la Tesorería sin debitar a nadie (creación de dinero)
    const txId = uuidv4();
    await client.query(
      `INSERT INTO transactions (id, type, description, initiated_by, metadata)
       VALUES ($1, 'mint', $2, $3, $4)`,
      [txId, description, adminId, JSON.stringify({ amount })]
    );
    await client.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, amount)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), txId, treasuryId, amount]
    );

    await audit.log({ actorId: adminId, action: 'mint', targetType: 'treasury', targetId: treasuryId, details: { amount, description } }, client);
    await client.query('COMMIT');
    return txId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────
// OPERACIÓN 2: REWARD
// Teacher aprueba misión → Tesorería → Alumno
// ─────────────────────────────────────────────────────────────
async function reward({ teacherId, studentId, amount, description, meta = {}, client: externalClient = null }) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    const err = new Error('El monto debe ser un entero positivo');
    err.code = 'INVALID_AMOUNT';
    throw err;
  }
  const client = externalClient || await db.getClient();
  const ownsTransaction = !externalClient;
  try {
    if (ownsTransaction) await client.query('BEGIN');

    const treasuryId    = await getTreasuryAccountId(client);
    const studentAccId  = await getAccountByUserId(studentId, client);
    await lockAccountsForUpdate([treasuryId, studentAccId], client);

    // Verificar que la Tesorería tenga saldo
    await assertSufficientBalance(treasuryId, amount, client);

    // Verificar presupuesto mensual del teacher
    const budgetResult = await client.query(
      `SELECT monthly_limit, current_spent FROM teacher_budgets
       WHERE teacher_id = $1 AND month = DATE_TRUNC('month', NOW())
       FOR UPDATE`,
      [teacherId]
    );
    if (budgetResult.rows.length > 0) {
      const { monthly_limit, current_spent } = budgetResult.rows[0];
      if (current_spent + amount > monthly_limit) {
        const err = new Error(`Superás tu presupuesto mensual. Disponible: ${monthly_limit - current_spent} monedas`);
        err.code = 'BUDGET_EXCEEDED';
        throw err;
      }
      // Actualizar gasto del teacher
      await client.query(
        `UPDATE teacher_budgets SET current_spent = current_spent + $1
         WHERE teacher_id = $2 AND month = DATE_TRUNC('month', NOW())`,
        [amount, teacherId]
      );
    }

    const txId = await createDoubleEntry(client, {
      type: 'reward',
      description,
      initiatedBy: teacherId,
      entries: [
        { accountId: treasuryId,   amount: -amount },
        { accountId: studentAccId, amount: +amount },
      ],
      meta,
    });

    await audit.log({ actorId: teacherId, action: 'reward', targetType: 'user', targetId: studentId, details: { amount, description } }, client);
    if (ownsTransaction) {
      await client.query('COMMIT');
      // Cuando forma parte de una transacción mayor, la ruta notifica tras su COMMIT.
      notifyUser(studentId, { type: 'reward', amount, description, from: 'Docente' });
    }
    return txId;
  } catch (err) {
    if (ownsTransaction) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (ownsTransaction) client.release();
  }
}

// ─────────────────────────────────────────────────────────────
// OPERACIÓN 3: TRANSFER
// Alumno → Alumno
// ─────────────────────────────────────────────────────────────
async function transfer({ fromUserId, toUserId, amount, description }) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    const err = new Error('El monto debe ser un entero positivo');
    err.code = 'INVALID_AMOUNT';
    throw err;
  }
  if (fromUserId === toUserId) {
    const err = new Error('No podés transferirte monedas a vos mismo');
    err.code = 'SELF_TRANSFER';
    throw err;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const fromAccId = await getAccountByUserId(fromUserId, client);
    const toAccId   = await getAccountByUserId(toUserId, client);

    await lockAccountsForUpdate([fromAccId, toAccId], client);
    await assertSufficientBalance(fromAccId, amount, client);

    const txId = await createDoubleEntry(client, {
      type: 'transfer',
      description: description || 'Transferencia entre alumnos',
      initiatedBy: fromUserId,
      entries: [
        { accountId: fromAccId, amount: -amount },
        { accountId: toAccId,   amount: +amount },
      ],
    });

    await audit.log({ actorId: fromUserId, action: 'transfer', targetType: 'user', targetId: toUserId, details: { amount } }, client);
    await client.query('COMMIT');
    // Notificar al receptor
    notifyUser(toUserId, { type: 'transfer', amount, from_user_id: fromUserId });
    return txId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────
// OPERACIÓN 4: PURCHASE
// Alumno compra ítem → Alumno → Store
// ─────────────────────────────────────────────────────────────
async function purchase({ studentId, itemId }) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Leer precio y stock desde la BD (nunca confiar en el cliente)
    const itemResult = await client.query(
      `SELECT si.id, si.nombre, si.precio, si.stock, si.activo, si.published_by,
              publisher.rol AS publisher_role
       FROM store_items si
       LEFT JOIN users publisher ON publisher.id = si.published_by
       WHERE si.id = $1
       FOR UPDATE OF si`,
      [itemId]
    );
    if (itemResult.rows.length === 0 || !itemResult.rows[0].activo) {
      const err = new Error('Ítem no encontrado o inactivo');
      err.code = 'ITEM_NOT_FOUND';
      throw err;
    }

    const item = itemResult.rows[0];

    if (item.published_by === studentId) {
      const err = new Error('No podés comprar tu propio anuncio');
      err.code = 'SELF_PURCHASE';
      throw err;
    }

    if (item.stock === 0) {
      const err = new Error('Este ítem está agotado');
      err.code = 'OUT_OF_STOCK';
      throw err;
    }

    // Las ventas entre alumnos acreditan al vendedor. Los artículos
    // institucionales financian la Tesorería.
    const studentAccId = await getAccountByUserId(studentId, client);
    const destinationAccId = item.publisher_role === 'student'
      ? await getAccountByUserId(item.published_by, client)
      : await getTreasuryAccountId(client);

    await lockAccountsForUpdate([studentAccId, destinationAccId], client);
    await assertSufficientBalance(studentAccId, item.precio, client);

    const txId = await createDoubleEntry(client, {
      type: 'purchase',
      description: `Compra: ${item.nombre}`,
      initiatedBy: studentId,
      entries: [
        { accountId: studentAccId, amount: -item.precio },
        { accountId: destinationAccId, amount: +item.precio },
      ],
      meta: {
        referenceId: itemId,
        referenceType: 'store_item',
        sellerId: item.publisher_role === 'student' ? item.published_by : null,
      },
    });

    // Decrementar stock si no es ilimitado
    if (item.stock > 0) {
      await client.query(
        'UPDATE store_items SET stock = stock - 1 WHERE id = $1',
        [itemId]
      );
    }

    await audit.log({ actorId: studentId, action: 'purchase', targetType: 'store_item', targetId: itemId, details: { precio: item.precio, nombre: item.nombre } }, client);
    await client.query('COMMIT');
    if (item.publisher_role === 'student') {
      notifyUser(item.published_by, {
        type: 'store_sale',
        amount: item.precio,
        item_id: item.id,
        item_nombre: item.nombre,
      });
    }
    return txId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────
// OPERACIÓN 5: ADJUSTMENT
// Admin corrige un error con motivo obligatorio
// ─────────────────────────────────────────────────────────────
async function adjustment({ adminId, fromAccountId, toAccountId, amount, reason }) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    const err = new Error('El monto debe ser un entero positivo');
    err.code = 'INVALID_AMOUNT';
    throw err;
  }
  if (fromAccountId === toAccountId) {
    const err = new Error('Las cuentas de origen y destino deben ser diferentes');
    err.code = 'SAME_ACCOUNT';
    throw err;
  }
  if (!reason || reason.trim().length < 5) {
    const err = new Error('El motivo del ajuste es obligatorio (mínimo 5 caracteres)');
    err.code = 'REASON_REQUIRED';
    throw err;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await lockAccountsForUpdate([fromAccountId, toAccountId], client);
    await assertSufficientBalance(fromAccountId, amount, client);

    const txId = await createDoubleEntry(client, {
      type: 'adjustment',
      description: `Ajuste manual: ${reason}`,
      initiatedBy: adminId,
      entries: [
        { accountId: fromAccountId, amount: -amount },
        { accountId: toAccountId,   amount: +amount },
      ],
      meta: { reason },
    });

    await audit.log({ actorId: adminId, action: 'adjustment', targetType: 'transaction', targetId: txId, details: { fromAccountId, toAccountId, amount, reason } }, client);
    await client.query('COMMIT');
    return txId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────
// OPERACIÓN 6: BURN
// Admin destruye monedas de la Tesorería
// ─────────────────────────────────────────────────────────────
async function burn({ adminId, amount, reason }) {
  if (!reason || reason.trim().length < 5) {
    const err = new Error('El motivo del burn es obligatorio (mínimo 5 caracteres)');
    err.code = 'REASON_REQUIRED';
    throw err;
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    const err = new Error('El monto debe ser un entero positivo');
    err.code = 'INVALID_AMOUNT';
    throw err;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const treasuryId = await getTreasuryAccountId(client);

    // Verificar que la Tesorería tenga saldo suficiente para quemar
    await lockAccountsForUpdate([treasuryId], client);
    await assertSufficientBalance(treasuryId, amount, client);

    // Entrada única negativa — destruye monedas de la Tesorería
    const txId = uuidv4();
    await client.query(
      `INSERT INTO transactions (id, type, description, initiated_by, metadata)
       VALUES ($1, 'burn', $2, $3, $4)`,
      [txId, `Burn: ${reason}`, adminId, JSON.stringify({ amount, reason })]
    );
    await client.query(
      `INSERT INTO ledger_entries (id, transaction_id, account_id, amount)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), txId, treasuryId, -amount]
    );

    await audit.log({
      actorId: adminId,
      action: 'burn',
      targetType: 'treasury',
      targetId: treasuryId,
      details: { amount, reason }
    }, client);

    await client.query('COMMIT');
    return txId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createDoubleEntry, mint, burn, reward, transfer, purchase, adjustment };
