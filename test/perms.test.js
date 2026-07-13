const test = require('node:test');
const assert = require('node:assert/strict');

const perms = require('../src/middleware/perms');

function run(user, required = 'psicologia') {
  let nextCalled = false;
  let response = null;
  const req = { user };
  const res = {
    status(status) {
      return {
        json(body) {
          response = { status, body };
        },
      };
    },
  };
  perms(required)(req, res, () => { nextCalled = true; });
  return { nextCalled, response };
}

test('psicología exige permiso explícito a docentes', () => {
  const result = run({ rol: 'teacher', permisos: [] });
  assert.equal(result.nextCalled, false);
  assert.equal(result.response.status, 403);
  assert.equal(result.response.body.error.code, 'FORBIDDEN');
});

test('permite el acceso con permiso granular o rol administrador', () => {
  assert.equal(run({ rol: 'teacher', permisos: ['psicologia'] }).nextCalled, true);
  assert.equal(run({ rol: 'admin', permisos: [] }).nextCalled, true);
});
