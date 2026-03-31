// src/middleware/auth.js
// Se ejecuta antes de cada endpoint protegido.
// Verifica que el token JWT sea válido y extrae los datos del usuario.

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const db = require('../config/db');

async function auth(req, res, next) {
  try {
    // 1. Buscar el token en el header Authorization
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        ok: false,
        error: { code: 'NO_TOKEN', message: 'Autenticación requerida' }
      });
    }

    const token = authHeader.split(' ')[1];

    // 2. Verificar firma y expiración del token
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({
        ok: false,
        error: { code: 'INVALID_TOKEN', message: 'Token inválido o expirado' }
      });
    }

    // 3. Verificar que el usuario siga activo en la BD
    // (el admin puede desactivar una cuenta y el token existente queda inválido)
    const { rows } = await db.query(
      'SELECT id, rol, nombre, activo, permisos FROM users WHERE id = $1',
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
      account_id: payload.account_id,
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
