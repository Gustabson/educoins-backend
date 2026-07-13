const { validate: isUuid } = require('uuid');

const invalidId = {
  ok: false,
  error: {
    code: 'INVALID_ID',
    message: 'Identificador inválido',
  },
};

/**
 * Reject malformed UUID route parameters before they reach PostgreSQL.
 * This keeps client mistakes as 400 responses instead of leaking database
 * errors as 500 responses.
 */
module.exports = function uuidParams(router, ...names) {
  names.forEach((name) => {
    router.param(name, (req, res, next, value) => {
      if (!isUuid(value)) return res.status(400).json(invalidId);
      return next();
    });
  });
};
