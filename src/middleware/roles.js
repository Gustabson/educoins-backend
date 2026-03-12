// src/middleware/roles.js
// Se usa después de auth() para restringir endpoints por rol.
//
// Uso en una ruta:
//   router.post('/mint', auth, roles('admin'), handler)
//   router.post('/submit', auth, roles('student'), handler)
//   router.get('/submissions', auth, roles('teacher', 'admin'), handler)

function roles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        ok: false,
        error: { code: 'NO_TOKEN', message: 'Autenticación requerida' }
      });
    }

    if (!allowedRoles.includes(req.user.rol)) {
      return res.status(403).json({
        ok: false,
        error: {
          code: 'UNAUTHORIZED',
          message: `Esta acción requiere rol: ${allowedRoles.join(' o ')}`
        }
      });
    }

    next();
  };
}

module.exports = roles;
