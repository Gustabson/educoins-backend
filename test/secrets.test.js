const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeJwtSecret } = require('../src/config/secrets');

test('derives a stable 256-bit JWT key from a legacy production secret', () => {
  const first = normalizeJwtSecret('legacy-secret', 'production');
  const second = normalizeJwtSecret('legacy-secret', 'production');
  assert.equal(first.derived, true);
  assert.equal(first.value.length, 64);
  assert.equal(first.value, second.value);
  assert.notEqual(first.value, 'legacy-secret');
});

test('keeps sufficiently long and non-production secrets unchanged', () => {
  const longSecret = 'a'.repeat(32);
  assert.deepEqual(normalizeJwtSecret(longSecret, 'production'), { value: longSecret, derived: false });
  assert.deepEqual(normalizeJwtSecret('local', 'development'), { value: 'local', derived: false });
});
