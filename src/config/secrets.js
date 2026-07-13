const crypto = require('crypto');

function normalizeJwtSecret(secret, nodeEnv) {
  if (nodeEnv !== 'production' || secret.length >= 32) {
    return { value: secret, derived: false };
  }

  // Compatibilidad para instalaciones antiguas: no se expone ni se usa
  // directamente una clave corta. La derivación es estable entre reinicios,
  // pero la variable debe rotarse por un secreto aleatorio de 32+ caracteres.
  return {
    value: crypto.createHash('sha256').update(`educoins-jwt-v1:${secret}`).digest('hex'),
    derived: true,
  };
}

module.exports = { normalizeJwtSecret };
