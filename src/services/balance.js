// src/services/balance.js
// La función más importante del sistema.
// El balance NUNCA se lee de un campo almacenado.
// SIEMPRE se calcula sumando las entradas del ledger.

const db = require('../config/db');

/**
 * Calcula el balance actual de una cuenta sumando sus ledger_entries.
 * @param {string} accountId - UUID de la cuenta
 * @param {object} [client] - cliente de BD (opcional, para usar dentro de una transacción atómica)
 * @returns {number} balance actual en monedas (entero)
 */
async function getBalance(accountId, client) {
  const query = `
    SELECT COALESCE(SUM(amount), 0)::integer AS balance
    FROM ledger_entries
    WHERE account_id = $1
  `;
  const executor = client || db;
  const { rows } = await executor.query(query, [accountId]);
  return rows[0].balance;
}

/**
 * Verifica que una cuenta tenga saldo suficiente.
 * Lanza un error con código INSUFFICIENT_BALANCE si no alcanza.
 * @param {string} accountId
 * @param {number} amount - monto requerido
 * @param {object} [client]
 */
async function assertSufficientBalance(accountId, amount, client) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    const err = new Error('El monto debe ser un entero positivo');
    err.code = 'INVALID_AMOUNT';
    throw err;
  }
  const balance = await getBalance(accountId, client);
  if (balance < amount) {
    const err = new Error('Saldo insuficiente');
    err.code = 'INSUFFICIENT_BALANCE';
    err.balance = balance;
    err.required = amount;
    throw err;
  }
  return balance;
}

/**
 * Serializes operations that can debit the same account. Balance is derived
 * from ledger entries, so checking it without first locking the account row
 * allows concurrent requests to spend the same funds.
 */
async function lockAccountsForUpdate(accountIds, client) {
  if (!client) throw new Error('Se requiere una transacción para bloquear cuentas');
  const ids = [...new Set(accountIds.filter(Boolean))].sort();
  if (ids.length === 0) return;
  const { rows } = await client.query(
    `SELECT id FROM accounts
     WHERE id = ANY($1::uuid[]) AND is_active = TRUE
     ORDER BY id
     FOR UPDATE`,
    [ids]
  );
  if (rows.length !== ids.length) {
    const err = new Error('Una de las cuentas no existe o está inactiva');
    err.code = 'ACCOUNT_NOT_FOUND';
    throw err;
  }
}

/**
 * Obtiene el account_id de un usuario dado su user_id.
 * @param {string} userId
 * @param {object} [client]
 */
async function getAccountByUserId(userId, client) {
  const executor = client || db;
  const { rows } = await executor.query(
    'SELECT id FROM accounts WHERE user_id = $1 AND is_active = true',
    [userId]
  );
  if (rows.length === 0) {
    const err = new Error('Cuenta no encontrada');
    err.code = 'ACCOUNT_NOT_FOUND';
    throw err;
  }
  return rows[0].id;
}

/**
 * Obtiene el account_id de la Tesorería del sistema.
 * @param {object} [client]
 */
async function getTreasuryAccountId(client) {
  const executor = client || db;
  const { rows } = await executor.query(
    "SELECT id FROM accounts WHERE account_type = 'treasury' AND is_active = true LIMIT 1"
  );
  if (rows.length === 0) {
    const err = new Error('Tesorería no encontrada. El admin debe inicializar el sistema.');
    err.code = 'TREASURY_NOT_FOUND';
    throw err;
  }
  return rows[0].id;
}

/** Obtiene la cuenta sistémica reservada exclusivamente para garantías P2P. */
async function getEscrowAccountId(client) {
  const executor = client || db;
  const { rows } = await executor.query(
    "SELECT id FROM accounts WHERE account_type = 'escrow' AND is_active = true LIMIT 1"
  );
  if (rows.length === 0) {
    const err = new Error('Cuenta de garantía P2P no encontrada');
    err.code = 'ESCROW_NOT_FOUND';
    throw err;
  }
  return rows[0].id;
}

module.exports = {
  getBalance,
  assertSufficientBalance,
  lockAccountsForUpdate,
  getAccountByUserId,
  getTreasuryAccountId,
  getEscrowAccountId,
};
