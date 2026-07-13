const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/educoins_test';
process.env.JWT_SECRET ||= 'test-secret-with-at-least-32-characters';
const { createDoubleEntry } = require('../src/services/ledger');

test('el ledger exige por lo menos dos entradas y suma cero', async () => {
  const client = { query: () => assert.fail('no debe escribir') };
  await assert.rejects(createDoubleEntry(client, {
    type:'transfer', description:'prueba', entries:[{ accountId:'a', amount:10 }],
  }), { code:'INVALID_ENTRIES' });
  await assert.rejects(createDoubleEntry(client, {
    type:'transfer', description:'prueba',
    entries:[{ accountId:'a', amount:-10 }, { accountId:'b', amount:9 }],
  }), { code:'UNBALANCED_TRANSACTION' });
});

test('el ledger rechaza cero, decimales y valores inseguros', async () => {
  const client = { query: () => assert.fail('no debe escribir') };
  for (const invalid of [0, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(createDoubleEntry(client, {
      type:'transfer', description:'prueba',
      entries:[{ accountId:'a', amount:invalid }, { accountId:'b', amount:-invalid }],
    }), { code:'INVALID_LEDGER_ENTRY' });
  }
});
