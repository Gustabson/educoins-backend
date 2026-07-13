// src/middleware/perms.js
// Middleware basado en permisos granulares (campo permisos TEXT[] en users).
//
// Uso:
//   router.get('/ruta', auth, perms('psicologia'), handler)
//   router.get('/ruta', auth, perms('economia', 'administracion'), handler) // OR
//
// Quién pasa siempre:
//   - rol='admin' (superadmin)
//   - permisos que incluyen '*' (wildcard)
//
// Los datos de psicología requieren permiso explícito; ser docente no concede
// acceso global a información sensible de alumnos.

function perms(...required) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        ok: false,
        error: { code: 'NO_TOKEN', message: 'Autenticación requerida' }
      });
    }

    const u = req.user;

    // Superadmin siempre pasa
    if (u.rol === 'admin') return next();

    const userPerms = u.permisos || [];

    // Wildcard: acceso total
    if (userPerms.includes('*')) return next();

    // Chequear si tiene al menos uno de los permisos requeridos
    if (required.some(p => userPerms.includes(p))) return next();

    return res.status(403).json({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'No tenés permisos para esta acción' }
    });
  };
}

module.exports = perms;
