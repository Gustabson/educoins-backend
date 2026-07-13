const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/educoins_test';
process.env.JWT_SECRET ||= 'test-secret-with-at-least-32-characters';
const {
  assertSufficientBalance,
  lockAccountsForUpdate,
} = require('../src/services/balance');

test('rechaza montos no enteros o no positivos antes de consultar la base', async () => {
  const client = { query: () => assert.fail('no debe consultar') };
  for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '10']) {
    await assert.rejects(assertSufficientBalance('cuenta', amount, client), { code:'INVALID_AMOUNT' });
  }
});

test('bloquea cuentas sin duplicados y en orden estable', async () => {
  let ids;
  const client = {
    async query(_sql, params) {
      ids = params[0];
      return { rows: ids.map(id => ({ id })) };
    },
  };
  await lockAccountsForUpdate([
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ], client);
  assert.deepEqual(ids, [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ]);
});

test('detecta una cuenta ausente o inactiva al bloquear', async () => {
  const client = { query: async () => ({ rows:[] }) };
  await assert.rejects(
    lockAccountsForUpdate(['11111111-1111-4111-8111-111111111111'], client),
    { code:'ACCOUNT_NOT_FOUND' }
  );
});
