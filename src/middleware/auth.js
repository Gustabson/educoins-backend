// src/middleware/auth.js
// Se ejecuta antes de cada endpoint protegido.
// Verifica que el token JWT sea válido y extrae los datos del usuario.

const jwt = require('jsonwebtoken');
const { validate: isUuid } = require('uuid');
const { JWT_SECRET } = require('../config/env');
const db = require('../config/db');

async function auth(req, res, next) {
  try {
    if (req.user) return next();
    // 1. Buscar el token en el header Authorization
    const authHeader = req.headers['authorization'];
    const match = typeof authHeader === 'string' && authHeader.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) {
      return res.status(401).json({
        ok: false,
        error: { code: 'NO_TOKEN', message: 'Autenticación requerida' }
      });
    }

    const token = match[1];

    // 2. Verificar firma y expiración del token
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch (e) {
      return res.status(401).json({
        ok: false,
        error: { code: 'INVALID_TOKEN', message: 'Token inválido o expirado' }
      });
    }

    // 3. Verificar que el usuario siga activo en la BD
    // (el admin puede desactivar una cuenta y el token existente queda inválido)
    if (!isUuid(payload.sub)) {
      return res.status(401).json({
        ok: false,
        error: { code: 'INVALID_TOKEN', message: 'Token inválido o expirado' }
      });
    }

    const { rows } = await db.query(
      `SELECT u.id, u.rol, u.nombre, u.activo, u.permisos, account.id AS account_id
       FROM users u
       LEFT JOIN LATERAL (
         SELECT a.id FROM accounts a
         WHERE a.user_id = u.id AND a.is_active = TRUE
         ORDER BY a.created_at ASC
         LIMIT 1
       ) account ON TRUE
       WHERE u.id = $1`,
      [payload.sub]
    );

    if (rows.length === 0 || !rows[0].activo) {
      return res.status(401).json({
        ok: false,
        error: { code: 'ACCOUNT_INACTIVE', message: 'Cuenta inactiva o no encontrada' }
      });
    }

    // 4. Adjuntar datos del usuario al request para usarlos en el endpoint
    req.user = {
      id:         rows[0].id,
      rol:        rows[0].rol,
      nombre:     rows[0].nombre,
      account_id: rows[0].account_id || null,
      permisos:   rows[0].permisos || [],
    };

    next();
  } catch (err) {
    console.error('Error en middleware auth:', err);
    res.status(500).json({
      ok: false,
      error: { code: 'SERVER_ERROR', message: 'Error interno del servidor' }
    });
  }
}

module.exports = auth;
