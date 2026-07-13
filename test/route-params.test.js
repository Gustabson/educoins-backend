const test = require('node:test');
const assert = require('node:assert/strict');
const integerParams = require('../src/middleware/integer-params');
const uuidParams = require('../src/middleware/uuid-params');

function capture(register, name = 'id') {
  let callback;
  register({ param(_name, handler) { callback = handler; } }, name);
  return callback;
}

function response() {
  const state = {};
  return {
    state,
    status(code) { state.status = code; return this; },
    json(body) { state.body = body; return body; },
  };
}

test('UUID params reject malformed database identifiers', () => {
  const handler = capture(uuidParams);
  const res = response();
  let nextCalled = false;
  handler({}, res, () => { nextCalled = true; }, 'not-a-uuid');
  assert.equal(res.state.status, 400);
  assert.equal(res.state.body.error.code, 'INVALID_ID');
  assert.equal(nextCalled, false);
});

test('UUID params accept valid identifiers', () => {
  const handler = capture(uuidParams);
  let nextCalled = false;
  handler({}, response(), () => { nextCalled = true; }, '10000000-0000-4000-8000-000000000001');
  assert.equal(nextCalled, true);
});

test('integer params only accept positive safe integers', () => {
  const handler = capture(integerParams);
  for (const value of ['0', '-1', '1.5', 'abc', '9007199254740992']) {
    const res = response();
    handler({}, res, () => assert.fail(`accepted ${value}`), value);
    assert.equal(res.state.status, 400);
  }
  let nextCalled = false;
  handler({}, response(), () => { nextCalled = true; }, '42');
  assert.equal(nextCalled, true);
});
