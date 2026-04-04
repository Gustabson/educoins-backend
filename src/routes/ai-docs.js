// src/routes/ai-docs.js
// CRUD de documentos para el sistema de IA (reglamento + info institucional).
// Solo superadmin puede gestionar documentos.

const express = require('express');
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');
const router  = express.Router();

// ── Startup migration + contenido de prueba ───────────────────
db.query(`
  CREATE TABLE IF NOT EXISTS ai_documents (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo        TEXT NOT NULL CHECK (tipo IN ('reglamento','institucional')),
    titulo      TEXT NOT NULL,
    contenido   TEXT NOT NULL DEFAULT '',
    activo      BOOLEAN DEFAULT TRUE,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  )
`).then(() => db.query('SELECT COUNT(*) FROM ai_documents'))
  .then(({ rows }) => {
    if (parseInt(rows[0].count) > 0) return;
    return db.query(`
      INSERT INTO ai_documents (tipo, titulo, contenido) VALUES ($1,$2,$3),($4,$5,$6)
    `, [
      'reglamento',
      'Reglamento Interno de Convivencia (PRUEBA)',
      `REGLAMENTO INTERNO DE CONVIVENCIA — CONTENIDO DE PRUEBA

Artículo 1 — Asistencia y Puntualidad
Se admiten hasta 3 llegadas tarde por mes sin sanción.
A partir de la 4ª llegada tarde, se notifica a los padres/tutores.
Con 6 o más tardanzas mensuales se aplica una amonestación formal y una penalización de 50 EduCoins.

Artículo 2 — Conducta y Convivencia
Se espera trato respetuoso entre todos los miembros de la comunidad.
Los insultos o agresiones verbales constituyen falta grave.
Primera falta: advertencia y 100 EduCoins de penalización.
Reincidencia: sanción formal y 250 EduCoins.

Artículo 3 — Uso de Dispositivos Electrónicos
El uso de celulares está permitido solo durante los recreos.
Durante clases, el uso requiere autorización expresa del docente.
Primera infracción: advertencia. Segunda infracción: 50 EduCoins.

Artículo 4 — EduCoins y Sistema Económico
Las EduCoins se ganan completando misiones asignadas por docentes.
Las penalizaciones van de 50 a 500 EduCoins según la gravedad.
El saldo no puede ser negativo.

Artículo 5 — Deshonestidad Académica
Copiar en evaluaciones o plagiar trabajos es falta grave.
Penalización: 200 EduCoins y nota en el legajo.
La reincidencia deriva en sanción disciplinaria formal.

Artículo 6 — Bullying y Acoso
El acoso escolar en cualquier forma (físico, verbal, digital) es falta gravísima.
Sanción inmediata, 500 EduCoins y notificación a los padres.
En casos extremos se activa el protocolo de intervención institucional.`,

      'institucional',
      'Información Institucional (PRUEBA)',
      `INFORMACIÓN INSTITUCIONAL — CONTENIDO DE PRUEBA

¿Qué es nuestra escuela?
Somos una institución educativa comprometida con la formación integral,
combinando educación de calidad con el sistema gamificado EduCoins.

¿Qué son los EduCoins?
La moneda virtual de la escuela. Se ganan completando misiones académicas,
siendo puntual y demostrando buena conducta. Se usan en la tienda virtual.

¿Cómo funciona el sistema de misiones?
Los docentes publican misiones que los alumnos aceptan y completan.
Cada misión tiene un valor en EduCoins y descripción clara del entregable.

¿Cuál es nuestra filosofía?
Creemos que la motivación y el reconocimiento son clave para el aprendizaje.
EduCoins transforma la experiencia escolar: el esfuerzo tiene recompensa real.

¿Cómo contactar a la administración?
Mediante la sección Reportes de la app, o en persona de lunes a viernes de 8 a 17 hs.

¿Qué hago si tengo un problema urgente?
Dirigite inmediatamente al personal de la escuela.
La app también tiene la sección Bienestar para reportar cómo te sentís.`
    ]);
  })
  .catch(e => console.warn('[ai-docs] migration:', e.message));

// ── GET / — listar documentos (sin contenido) ─────────────────
router.get('/', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, tipo, titulo, activo, updated_at FROM ai_documents ORDER BY tipo, updated_at DESC'
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /:id — obtener documento completo ─────────────────────
router.get('/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM ai_documents WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Documento no encontrado' } });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST / — crear documento ──────────────────────────────────
router.post('/', auth, roles('admin'), async (req, res) => {
  try {
    const { tipo, titulo, contenido = '' } = req.body;
    if (!tipo || !titulo?.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING', message: 'Tipo y título son requeridos' } });
    }
    const { rows } = await db.query(
      'INSERT INTO ai_documents (tipo, titulo, contenido, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
      [tipo, titulo.trim(), contenido, req.user.id]
    );
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── PATCH /:id — actualizar documento ────────────────────────
router.patch('/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { titulo, contenido, activo } = req.body;
    const { rows } = await db.query(`
      UPDATE ai_documents SET
        titulo     = COALESCE($1, titulo),
        contenido  = COALESCE($2, contenido),
        activo     = COALESCE($3, activo),
        updated_at = NOW()
      WHERE id = $4 RETURNING *
    `, [titulo || null, contenido ?? null, activo ?? null, req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Documento no encontrado' } });
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── DELETE /:id — eliminar documento ─────────────────────────
router.delete('/:id', auth, roles('admin'), async (req, res) => {
  try {
    await db.query('DELETE FROM ai_documents WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;
