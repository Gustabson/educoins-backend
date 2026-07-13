module.exports = function sanitizeErrors(req, res, next) {
  const sendJson = res.json.bind(res);

  res.json = (body) => {
    if (res.statusCode >= 500 && body?.error) {
      return sendJson({
        ...body,
        error: {
          ...body.error,
          message: 'Error interno del servidor',
          request_id: req.id,
        },
      });
    }
    return sendJson(body);
  };

  next();
};
