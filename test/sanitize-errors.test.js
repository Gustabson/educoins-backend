const test = require('node:test');
const assert = require('node:assert/strict');
const sanitizeErrors = require('../src/middleware/sanitize-errors');

function invoke(statusCode, body) {
  let sent;
  const req = { id: 'request-123' };
  const res = {
    statusCode,
    json(payload) {
      sent = payload;
      return payload;
    },
  };
  sanitizeErrors(req, res, () => {});
  res.json(body);
  return sent;
}

test('sanitizes internal error details and returns a support request id', () => {
  const result = invoke(500, {
    ok: false,
    error: { code: 'SERVER_ERROR', message: 'column secret does not exist' },
  });

  assert.equal(result.error.message, 'Error interno del servidor');
  assert.equal(result.error.request_id, 'request-123');
  assert.doesNotMatch(JSON.stringify(result), /column secret/);
});

test('keeps expected client error details intact', () => {
  const body = { ok: false, error: { code: 'INVALID_ID', message: 'Identificador inválido' } };
  assert.deepEqual(invoke(400, body), body);
});
