module.exports = function integerParams(router, ...names) {
  names.forEach((name) => {
    router.param(name, (req, res, next, value) => {
      if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
        return res.status(400).json({
          ok: false,
          error: { code: 'INVALID_ID', message: 'Identificador inválido' },
        });
      }
      return next();
    });
  });
};
