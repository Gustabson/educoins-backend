// src/routes/diwy.js
// Diwy — Asistente Preceptor IA
// Genera reportes de seguimiento para padres usando OpenAI.

const express = require('express');
const OpenAI  = require('openai');
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');
const router  = express.Router();

// ── Lazy OpenAI init ─────────────────────────────────────────
let _openai = null;
function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY no está configurada en las variables de entorno del servidor');
    err.code = 'NO_API_KEY';
    throw err;
  }
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}
const MODEL = 'gpt-4.1-mini';

// ── Startup migrations ───────────────────────────────────────
db.query(`
  CREATE TABLE IF NOT EXISTS diwy_observations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id  UUID REFERENCES users(id) ON DELETE CASCADE,
    teacher_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    semana      DATE NOT NULL,
    texto       TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.warn('[diwy] diwy_observations table:', e.message));

db.query(`
  CREATE TABLE IF NOT EXISTS diwy_reports (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id       UUID REFERENCES users(id) ON DELETE CASCADE,
    generated_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    periodo_label    TEXT,
    data_snapshot    JSONB,
    reporte_ia       TEXT,
    reporte_final    TEXT,
    estado           TEXT CHECK (estado IN ('draft','pendiente_revision','aprobado')) DEFAULT 'draft',
    approved_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.warn('[diwy] diwy_reports table:', e.message));

db.query(`
  CREATE TABLE IF NOT EXISTS diwy_parent_requests (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id   UUID REFERENCES users(id) ON DELETE CASCADE,
    parent_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    requested_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.warn('[diwy] diwy_parent_requests table:', e.message));

// ── Helper: Monday of the current week ───────────────────────
function getMondayISO() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().split('T')[0];
}

// ── GET /students — admin/teacher ────────────────────────────
router.get('/students', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        u.id, u.nombre, u.balance,
        lr.id            AS last_report_id,
        lr.estado        AS last_report_estado,
        lr.created_at    AS last_report_at,
        lr.periodo_label
      FROM users u
      LEFT JOIN LATERAL (
        SELECT id, estado, created_at, periodo_label
        FROM diwy_reports
        WHERE student_id = u.id
        ORDER BY created_at DESC
        LIMIT 1
      ) lr ON TRUE
      WHERE u.rol = 'student' AND u.activo = TRUE
      ORDER BY u.nombre ASC
    `);
    res.json({ ok: true, data: rows });
  } catch (e) {
    // 42P01 = tabla no existe aún (primera vez en Railway antes de migration)
    if (e.code === '42P01') {
      try {
        // Intentar crear la tabla y devolver alumnos sin datos de reporte
        await db.query(`
          CREATE TABLE IF NOT EXISTS diwy_reports (
            id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            student_id       UUID REFERENCES users(id) ON DELETE CASCADE,
            generated_by     UUID REFERENCES users(id) ON DELETE SET NULL,
            periodo_label    TEXT,
            data_snapshot    JSONB,
            reporte_ia       TEXT,
            reporte_final    TEXT,
            estado           TEXT CHECK (estado IN ('draft','pendiente_revision','aprobado')) DEFAULT 'draft',
            approved_by      UUID REFERENCES users(id) ON DELETE SET NULL,
            approved_at      TIMESTAMPTZ,
            created_at       TIMESTAMPTZ DEFAULT NOW()
          )
        `);
        const { rows: fallback } = await db.query(`
          SELECT id, nombre, balance,
            NULL::uuid AS last_report_id,
            NULL::text AS last_report_estado,
            NULL::timestamptz AS last_report_at,
            NULL::text AS periodo_label
          FROM users
          WHERE rol = 'student' AND activo = TRUE
          ORDER BY nombre ASC
        `);
        return res.json({ ok: true, data: fallback });
      } catch (e2) {
        console.error('[diwy] GET /students fallback:', e2);
        return res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e2.message } });
      }
    }
    console.error('[diwy] GET /students:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── POST /observations — admin/teacher ───────────────────────
router.post('/observations', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { student_id, texto, semana } = req.body;
    if (!student_id || !texto) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'student_id y texto son requeridos' } });
    }
    const semanaFinal = semana || getMondayISO();
    const { rows } = await db.query(`
      INSERT INTO diwy_observations (student_id, teacher_id, semana, texto)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [student_id, req.user.id, semanaFinal, texto.trim()]);
    res.json({ ok: true, data: rows[0] });
  } catch (e) {
    console.error('[diwy] POST /observations:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── GET /observations/:studentId — admin/teacher ─────────────
router.get('/observations/:studentId', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT o.*, u.nombre AS docente_nombre
      FROM diwy_observations o
      JOIN users u ON u.id = o.teacher_id
      WHERE o.student_id = $1
      ORDER BY o.semana DESC, o.created_at DESC
    `, [req.params.studentId]);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[diwy] GET /observations/:studentId:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── DELETE /observations/:id — admin/teacher (own or admin) ──
router.delete('/observations/:id', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM diwy_observations WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Observación no encontrada' } });
    const obs = rows[0];
    if (req.user.rol !== 'admin' && obs.teacher_id !== req.user.id) {
      return res.status(403).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Solo podés eliminar tus propias observaciones' } });
    }
    await db.query('DELETE FROM diwy_observations WHERE id = $1', [req.params.id]);
    res.json({ ok: true, data: { deleted: true } });
  } catch (e) {
    console.error('[diwy] DELETE /observations/:id:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── POST /generate/:studentId — admin/teacher ────────────────
router.post('/generate/:studentId', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { studentId } = req.params;
    const openai = getOpenAI();

    // 1. Student info
    const { rows: [student] } = await db.query(
      'SELECT id, nombre, balance FROM users WHERE id = $1 AND rol = $2',
      [studentId, 'student']
    );
    if (!student) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Alumno no encontrado' } });

    // 2. Last 30 days transactions
    const { rows: txRows } = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0)  AS coins_ganadas,
        COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0)  AS coins_perdidas,
        COUNT(*) AS tx_count
      FROM transactions
      WHERE (from_user_id = $1 OR to_user_id = $1)
        AND created_at > NOW() - INTERVAL '30 days'
    `, [studentId]);
    const txData = txRows[0];

    // 3. Check-ins last 30 days
    const checkinCount = await db.query(`
      SELECT COUNT(*) AS cnt
      FROM daily_checkins
      WHERE user_id = $1 AND fecha > NOW() - INTERVAL '30 days'
    `, [studentId]).then(r => parseInt(r.rows[0].cnt, 10)).catch(() => 0);

    // 3b. Mood/wellness last 30 days
    const moodData = await db.query(`
      SELECT
        ROUND(AVG(mood::numeric), 1)                          AS mood_promedio,
        COUNT(*)::int                                         AS mood_registros,
        (SELECT cat FROM mood_entries, UNNEST(categories) AS cat
          WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
          GROUP BY cat ORDER BY COUNT(*) DESC LIMIT 1)       AS categoria_frecuente
      FROM mood_entries
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
    `, [studentId]).then(r => r.rows[0]).catch(() => null);

    // 4. Verdicts last 30 days
    const { rows: verdicts } = await db.query(`
      SELECT severity, coins_penalty
      FROM verdicts
      WHERE to_user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
    `, [studentId]).catch(() => ({ rows: [] }));

    // 5. Missions completed last 30 days
    const missionsCount = await db.query(`
      SELECT COUNT(*) AS cnt
      FROM mission_submissions
      WHERE student_id = $1 AND estado = 'aprobada'
        AND completed_at > NOW() - INTERVAL '30 days'
    `, [studentId]).then(r => parseInt(r.rows[0].cnt, 10)).catch(() => 0);

    // 6. Last 3 teacher observations
    const { rows: obsRows } = await db.query(`
      SELECT o.texto, o.semana, u.nombre AS docente_nombre
      FROM diwy_observations o
      JOIN users u ON u.id = o.teacher_id
      WHERE o.student_id = $1
      ORDER BY o.semana DESC, o.created_at DESC
      LIMIT 3
    `, [studentId]);

    // Build snapshot
    const snapshot = {
      nombre: student.nombre,
      balance: student.balance,
      coins_ganadas: parseInt(txData.coins_ganadas, 10),
      coins_perdidas: parseInt(txData.coins_perdidas, 10),
      tx_count: parseInt(txData.tx_count, 10),
      checkins: checkinCount,
      wellness: moodData?.mood_registros > 0 ? {
        promedio: parseFloat(moodData.mood_promedio),
        registros: moodData.mood_registros,
        categoria_frecuente: moodData.categoria_frecuente || null,
      } : null,
      verdicts: verdicts,
      misiones_completadas: missionsCount,
      observaciones: obsRows,
    };

    const periodoLabel = `Semana del ${getMondayISO()}`;

    // Build user message for AI
    const userMsg = `
Datos del alumno para generar el reporte:

Nombre: ${student.nombre}
Balance actual: ${student.balance} monedas
Período: ${periodoLabel}

ACTIVIDAD ÚLTIMOS 30 DÍAS:
- Monedas ganadas: ${snapshot.coins_ganadas}
- Monedas perdidas: ${Math.abs(snapshot.coins_perdidas)}
- Transacciones totales: ${snapshot.tx_count}
- Check-ins realizados: ${checkinCount}
- Misiones completadas: ${missionsCount}
${snapshot.wellness
  ? `- Estado emocional (escala 1-5): promedio ${snapshot.wellness.promedio} en ${snapshot.wellness.registros} registros${snapshot.wellness.categoria_frecuente ? ` · emoción más frecuente: ${snapshot.wellness.categoria_frecuente}` : ''}`
  : '- Estado emocional: sin registros en el período'}`

${verdicts.length > 0 ? `VEREDICTOS DE CONDUCTA (${verdicts.length}):
${verdicts.map(v => `- Severidad: ${v.severity} | Penalidad: ${v.coins_penalty} monedas`).join('\n')}` : 'VEREDICTOS DE CONDUCTA: Ninguno en el período.'}

${obsRows.length > 0 ? `OBSERVACIONES DE DOCENTES:
${obsRows.map(o => `- Semana ${o.semana} (${o.docente_nombre}): "${o.texto}"`).join('\n')}` : 'OBSERVACIONES DE DOCENTES: Sin observaciones registradas.'}

Generá el reporte de seguimiento para la familia.
`.trim();

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: `Sos Diwy, el asistente preceptor IA de la institución educativa.
Redactás reportes de seguimiento semanal para los padres.

REGLAS:
1. Basate EXCLUSIVAMENTE en los datos proporcionados. Nunca inventés información.
2. Tono: empático, constructivo, profesional. Nunca peyorativo.
3. Destacá fortalezas antes que áreas de mejora.
4. Si hay veredictos de conducta, mencionarlos con cuidado y objetividad.
5. Incluí 1-2 recomendaciones concretas para acompañamiento desde el hogar.
6. Cerrá con una frase de aliento hacia el alumno y su familia.
7. Máximo 280 palabras. Párrafos cortos. Sin títulos ni bullets — prosa fluida.
8. Comenzá con "Estimada familia de [nombre],"`,
        },
        { role: 'user', content: userMsg },
      ],
      max_tokens: 600,
      temperature: 0.7,
    });

    const reporteIA = completion.choices[0]?.message?.content?.trim() || '';

    // Save report
    const { rows: [report] } = await db.query(`
      INSERT INTO diwy_reports (student_id, generated_by, periodo_label, data_snapshot, reporte_ia, estado)
      VALUES ($1, $2, $3, $4, $5, 'draft')
      RETURNING *
    `, [studentId, req.user.id, periodoLabel, JSON.stringify(snapshot), reporteIA]);

    res.json({ ok: true, data: report });
  } catch (e) {
    console.error('[diwy] POST /generate/:studentId:', e);
    const code = e.code === 'NO_API_KEY' ? 'NO_API_KEY' : 'SERVER_ERROR';
    res.status(500).json({ ok: false, error: { code, message: e.message } });
  }
});

// ── GET /reports/:studentId — admin/teacher ───────────────────
router.get('/reports/:studentId', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT r.*, u.nombre AS generado_por_nombre
      FROM diwy_reports r
      LEFT JOIN users u ON u.id = r.generated_by
      WHERE r.student_id = $1
      ORDER BY r.created_at DESC
    `, [req.params.studentId]);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[diwy] GET /reports/:studentId:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── PATCH /reports/:id/review — admin/teacher ────────────────
router.patch('/reports/:id/review', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { reporte_final } = req.body;
    if (!reporte_final) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'reporte_final es requerido' } });
    }
    const { rows } = await db.query(`
      UPDATE diwy_reports
      SET estado = 'pendiente_revision', reporte_final = $1
      WHERE id = $2
      RETURNING *
    `, [reporte_final, req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Reporte no encontrado' } });
    res.json({ ok: true, data: rows[0] });
  } catch (e) {
    console.error('[diwy] PATCH /reports/:id/review:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── PATCH /reports/:id/approve — admin/teacher ───────────────
router.patch('/reports/:id/approve', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      UPDATE diwy_reports
      SET estado = 'aprobado',
          approved_by = $1,
          approved_at = NOW(),
          reporte_final = COALESCE(NULLIF(reporte_final, ''), reporte_ia)
      WHERE id = $2
      RETURNING *
    `, [req.user.id, req.params.id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Reporte no encontrado' } });
    res.json({ ok: true, data: rows[0] });
  } catch (e) {
    console.error('[diwy] PATCH /reports/:id/approve:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── GET /parent — parent only ─────────────────────────────────
router.get('/parent', auth, roles('parent'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        r.id, r.student_id, u.nombre AS alumno_nombre,
        r.periodo_label, r.reporte_final, r.approved_at, r.created_at
      FROM diwy_reports r
      JOIN users u ON u.id = r.student_id
      JOIN parent_student_links psl ON psl.student_id = r.student_id
      WHERE psl.parent_id = $1 AND r.estado = 'aprobado'
      ORDER BY r.approved_at DESC
    `, [req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[diwy] GET /parent:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── POST /parent/request/:studentId — parent only ─────────────
router.post('/parent/request/:studentId', auth, roles('parent'), async (req, res) => {
  try {
    const { studentId } = req.params;
    const parentId = req.user.id;

    // Verify link exists
    const { rows: linkRows } = await db.query(
      'SELECT 1 FROM parent_student_links WHERE parent_id = $1 AND student_id = $2',
      [parentId, studentId]
    );
    if (!linkRows.length) {
      return res.status(403).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'No estás vinculado a este alumno' } });
    }

    // Rate limit: check requests in last 7 days
    const { rows: recentReqs } = await db.query(`
      SELECT requested_at FROM diwy_parent_requests
      WHERE parent_id = $1 AND student_id = $2
        AND requested_at > NOW() - INTERVAL '7 days'
      ORDER BY requested_at DESC
      LIMIT 1
    `, [parentId, studentId]);

    if (recentReqs.length > 0) {
      const lastReq = new Date(recentReqs[0].requested_at);
      const nextAllowed = new Date(lastReq.getTime() + 7 * 24 * 60 * 60 * 1000);
      const daysRemaining = Math.ceil((nextAllowed - Date.now()) / (1000 * 60 * 60 * 24));
      return res.status(429).json({
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: `Ya realizaste una solicitud recientemente. Podés volver a solicitar en ${daysRemaining} día${daysRemaining !== 1 ? 's' : ''}.`,
          days_remaining: daysRemaining,
        }
      });
    }

    // Get student name for notification
    const { rows: [st] } = await db.query('SELECT nombre FROM users WHERE id = $1', [studentId]);
    const alumnoNombre = st?.nombre || 'un alumno';

    // Insert request
    await db.query(
      'INSERT INTO diwy_parent_requests (student_id, parent_id) VALUES ($1, $2)',
      [studentId, parentId]
    );

    // Notify all admins
    const { rows: admins } = await db.query("SELECT id FROM users WHERE rol = 'admin' AND activo = TRUE");
    if (admins.length > 0) {
      const insertValues = admins.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(', ');
      const insertParams = admins.flatMap(a => [
        a.id,
        'diwy_request',
        `Un padre solicitó reporte Diwy para ${alumnoNombre}`,
      ]);
      await db.query(
        `INSERT INTO notifications (user_id, tipo, mensaje) VALUES ${insertValues}`,
        insertParams
      ).catch(e => console.warn('[diwy] notification insert failed:', e.message));
    }

    res.json({ ok: true, data: { message: 'Solicitud enviada. El equipo generará el reporte a la brevedad.' } });
  } catch (e) {
    console.error('[diwy] POST /parent/request/:studentId:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

module.exports = router;
