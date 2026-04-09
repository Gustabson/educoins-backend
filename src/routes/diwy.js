// src/routes/diwy.js
// Diwy — Asistente Preceptor IA
// Genera reportes de seguimiento para padres usando OpenAI.

const express   = require('express');
const OpenAI    = require('openai');
const db        = require('../config/db');
const auth      = require('../middleware/auth');
const roles     = require('../middleware/roles');
const { getIO } = require('../socket');
const { getBalance, getAccountByUserId } = require('../services/balance');
const router    = express.Router();

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

db.query(`
  CREATE TABLE IF NOT EXISTS diwy_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id       UUID REFERENCES users(id) ON DELETE CASCADE,
    student_id      UUID REFERENCES users(id) ON DELETE CASCADE,
    original_msg    TEXT NOT NULL,
    formatted_msg   TEXT,
    teacher_reply   TEXT,
    formatted_reply TEXT,
    teacher_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    estado          TEXT CHECK (estado IN ('pending','replied')) DEFAULT 'pending',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    replied_at      TIMESTAMPTZ
  )
`).catch(e => console.warn('[diwy] diwy_messages table:', e.message));

db.query(`
  CREATE TABLE IF NOT EXISTS diwy_class_preview (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id UUID REFERENCES users(id) ON DELETE CASCADE,
    fecha      DATE NOT NULL DEFAULT CURRENT_DATE,
    tema       TEXT NOT NULL,
    detalle    TEXT,
    imagen     TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (fecha)
  )
`).catch(e => console.warn('[diwy] diwy_class_preview table:', e.message));

db.query(`ALTER TABLE diwy_class_preview ADD COLUMN IF NOT EXISTS imagen TEXT`)
  .catch(() => {});

db.query(`
  CREATE TABLE IF NOT EXISTS attendance (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id   UUID REFERENCES users(id) ON DELETE CASCADE,
    classroom_id UUID REFERENCES classrooms(id) ON DELETE SET NULL,
    teacher_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    fecha        DATE NOT NULL,
    estado       TEXT CHECK (estado IN ('presente','ausente','tarde')) NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(student_id, fecha)
  )
`).catch(e => console.warn('[diwy] attendance table:', e.message));

db.query(`
  CREATE TABLE IF NOT EXISTS attendance_edit_requests (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id   UUID REFERENCES users(id) ON DELETE CASCADE,
    classroom_id UUID REFERENCES classrooms(id) ON DELETE CASCADE,
    fecha        DATE NOT NULL,
    motivo       TEXT,
    status       TEXT CHECK (status IN ('pending','approved','denied','consumed')) DEFAULT 'pending',
    reviewed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.warn('[diwy] attendance_edit_requests table:', e.message));

db.query(`
  CREATE TABLE IF NOT EXISTS diwy_parent_asks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id   UUID REFERENCES users(id) ON DELETE CASCADE,
    student_id  UUID REFERENCES users(id) ON DELETE CASCADE,
    question    TEXT NOT NULL,
    answer      TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.warn('[diwy] diwy_parent_asks table:', e.message));

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
      SELECT DISTINCT ON (u.id)
        u.id, u.nombre,
        c.id     AS classroom_id,
        c.nombre AS classroom_nombre,
        lr.id            AS last_report_id,
        lr.estado        AS last_report_estado,
        lr.created_at    AS last_report_at,
        lr.periodo_label
      FROM users u
      LEFT JOIN classroom_members cm ON cm.user_id = u.id AND cm.rol = 'student'
      LEFT JOIN classrooms c ON c.id = cm.classroom_id AND c.activa = TRUE
      LEFT JOIN LATERAL (
        SELECT id, estado, created_at, periodo_label
        FROM diwy_reports
        WHERE student_id = u.id
        ORDER BY created_at DESC
        LIMIT 1
      ) lr ON TRUE
      WHERE u.rol = 'student' AND u.activo = TRUE
      ORDER BY u.id, c.nombre ASC NULLS LAST, u.nombre ASC
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
- Estado emocional: ${snapshot.wellness ? `promedio ${snapshot.wellness.promedio}/5 en ${snapshot.wellness.registros} registros${snapshot.wellness.categoria_frecuente ? ` (emoción frecuente: ${snapshot.wellness.categoria_frecuente})` : ''}` : 'sin registros en el período'}

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

// ── GET /parent/snapshot — parent only ───────────────────────
router.get('/parent/snapshot', auth, roles('parent'), async (req, res) => {
  try {
    const parentId = req.user.id;

    const { rows: links } = await db.query(`
      SELECT psl.student_id, u.nombre
      FROM parent_student_links psl
      JOIN users u ON u.id = psl.student_id
      WHERE psl.parent_id = $1
      ORDER BY u.nombre ASC
    `, [parentId]);

    const children = await Promise.all(links.map(async child => {
      const sid = child.student_id;

      // Balance from ledger (double-entry source of truth)
      const balance = await getAccountByUserId(sid)
        .then(accountId => getBalance(accountId))
        .catch(() => 0);

      // Mood avg last 7 days
      const moodData = await db.query(`
        SELECT ROUND(AVG(mood::numeric), 1) AS avg, COUNT(*)::int AS count
        FROM mood_entries
        WHERE user_id = $1 AND created_at > NOW() - INTERVAL '7 days'
      `, [sid]).then(r => r.rows[0]).catch(() => null);

      // Check-in streak (distinct days in last 14 days)
      const streak = await db.query(`
        SELECT COUNT(DISTINCT fecha)::int AS cnt
        FROM daily_checkins
        WHERE user_id = $1 AND fecha > CURRENT_DATE - INTERVAL '14 days'
      `, [sid]).then(r => r.rows[0]?.cnt || 0).catch(() => 0);

      // Recent verdicts
      const verdicts = await db.query(`
        SELECT severity, coins_penalty, created_at
        FROM verdicts
        WHERE to_user_id = $1
        ORDER BY created_at DESC
        LIMIT 4
      `, [sid]).then(r => r.rows).catch(() => []);

      // Recent transactions (excluding taxes)
      const txns = await db.query(`
        SELECT tipo, amount, descripcion, created_at,
          CASE WHEN to_user_id = $1 THEN 'ingreso' ELSE 'egreso' END AS direccion
        FROM transactions
        WHERE (to_user_id = $1 OR from_user_id = $1)
          AND tipo NOT IN ('tax', 'fee')
        ORDER BY created_at DESC
        LIMIT 5
      `, [sid]).then(r => r.rows).catch(() => []);

      return {
        id: sid,
        nombre: child.nombre,
        balance,
        mood_avg:       moodData?.count > 0 ? parseFloat(moodData.avg) : null,
        mood_count:     moodData?.count || 0,
        checkin_streak: streak,
        recent_verdicts: verdicts,
        recent_txns:     txns,
      };
    }));

    res.json({ ok: true, data: children });
  } catch (e) {
    console.error('[diwy] GET /parent/snapshot:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── POST /parent/ask — parent only ────────────────────────────
router.post('/parent/ask', auth, roles('parent'), async (req, res) => {
  try {
    const parentId = req.user.id;
    const { studentId, question } = req.body;

    if (!studentId || !question?.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'studentId y question son requeridos' } });
    }

    // Verify parent-child link
    const { rows: linkRows } = await db.query(
      'SELECT 1 FROM parent_student_links WHERE parent_id = $1 AND student_id = $2',
      [parentId, studentId]
    );
    if (!linkRows.length) {
      return res.status(403).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'No estás vinculado a este alumno' } });
    }

    // Rate limit: 5 questions per parent per day
    const { rows: [rateRow] } = await db.query(`
      SELECT COUNT(*)::int AS cnt FROM diwy_parent_asks
      WHERE parent_id = $1 AND created_at > NOW() - INTERVAL '1 day'
    `, [parentId]).catch(() => ({ rows: [{ cnt: 0 }] }));

    if ((rateRow?.cnt || 0) >= 5) {
      return res.status(429).json({
        ok: false,
        error: { code: 'RATE_LIMITED', message: 'Llegaste al límite de 5 consultas por día. Volvé mañana.' },
      });
    }

    const openai = getOpenAI();

    const { rows: [student] } = await db.query(
      'SELECT nombre FROM users WHERE id = $1 AND rol = $2',
      [studentId, 'student']
    );
    if (!student) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Alumno no encontrado' } });

    // Build context
    const txData = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN to_user_id = $1 AND amount > 0 THEN amount ELSE 0 END), 0)::int AS ganadas,
        COALESCE(SUM(CASE WHEN from_user_id = $1 AND amount > 0 THEN amount ELSE 0 END), 0)::int AS perdidas
      FROM transactions
      WHERE (to_user_id = $1 OR from_user_id = $1)
        AND created_at > NOW() - INTERVAL '14 days'
    `, [studentId]).then(r => r.rows[0]).catch(() => ({ ganadas: 0, perdidas: 0 }));

    const moodData = await db.query(`
      SELECT ROUND(AVG(mood::numeric), 1) AS avg, COUNT(*)::int AS count
      FROM mood_entries
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '14 days'
    `, [studentId]).then(r => r.rows[0]).catch(() => null);

    const verdicts = await db.query(`
      SELECT severity, coins_penalty, created_at FROM verdicts
      WHERE to_user_id = $1 ORDER BY created_at DESC LIMIT 5
    `, [studentId]).then(r => r.rows).catch(() => []);

    const obsRows = await db.query(`
      SELECT o.texto, o.semana, u.nombre AS docente_nombre
      FROM diwy_observations o JOIN users u ON u.id = o.teacher_id
      WHERE o.student_id = $1 ORDER BY o.semana DESC LIMIT 3
    `, [studentId]).then(r => r.rows).catch(() => []);

    const lastReport = await db.query(`
      SELECT reporte_final, periodo_label FROM diwy_reports
      WHERE student_id = $1 AND estado = 'aprobado'
      ORDER BY approved_at DESC LIMIT 1
    `, [studentId]).then(r => r.rows[0] || null).catch(() => null);

    const context = [
      `Alumno: ${student.nombre}`,
      `Últimos 14 días: ganó ${txData.ganadas} monedas, perdió ${txData.perdidas} monedas`,
      moodData?.count > 0
        ? `Estado emocional: promedio ${moodData.avg}/5 en ${moodData.count} registros`
        : 'Estado emocional: sin registros recientes',
      verdicts.length > 0
        ? `Veredictos: ${verdicts.map(v => `${v.severity} (${new Date(v.created_at).toLocaleDateString('es-AR')})`).join(', ')}`
        : 'Sin veredictos de conducta recientes',
      obsRows.length > 0
        ? `Observaciones docentes:\n${obsRows.map(o => `- ${o.docente_nombre}: "${o.texto}"`).join('\n')}`
        : 'Sin observaciones docentes recientes',
      lastReport
        ? `Último reporte (${lastReport.periodo_label}): "${lastReport.reporte_final?.slice(0, 350)}..."`
        : 'Sin reportes aprobados aún',
    ].join('\n');

    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: `Sos Diwy, el asistente IA de seguimiento educativo de la institución. Respondés consultas de padres sobre sus hijos. Basate EXCLUSIVAMENTE en los datos disponibles. Si no tenés información suficiente para responder algo, decilo con honestidad. Tono: cálido, directo, sin tecnicismos. Máximo 120 palabras.`,
        },
        {
          role: 'user',
          content: `Contexto del alumno:\n${context}\n\nPregunta: "${question.trim()}"`,
        },
      ],
      max_tokens: 300,
      temperature: 0.65,
    });

    const answer = completion.choices[0]?.message?.content?.trim() || '';

    // Save for rate limiting (non-critical)
    await db.query(
      'INSERT INTO diwy_parent_asks (parent_id, student_id, question, answer) VALUES ($1, $2, $3, $4)',
      [parentId, studentId, question.trim(), answer]
    ).catch(() => {});

    res.json({ ok: true, data: { answer } });
  } catch (e) {
    console.error('[diwy] POST /parent/ask:', e);
    const code = e.code === 'NO_API_KEY' ? 'NO_API_KEY' : 'SERVER_ERROR';
    res.status(500).json({ ok: false, error: { code, message: e.message } });
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

// ── AI helpers ────────────────────────────────────────────────
async function formatParentMessage(studentName, rawMsg, openai) {
  try {
    const c = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: `Sos Diwy. Reformateás mensajes de padres para docentes: claro, profesional, breve (máx 2 oraciones). Comenzá con "La familia de ${studentName} "` },
        { role: 'user',   content: rawMsg },
      ],
      max_tokens: 120, temperature: 0.3,
    });
    return c.choices[0]?.message?.content?.trim() || rawMsg;
  } catch { return rawMsg; }
}

async function formatTeacherReply(rawReply, openai) {
  try {
    const c = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: `Sos Diwy, un intermediario de comunicación escolar. Tu única tarea es reformular la respuesta breve de un/a docente en un mensaje claro y amable dirigido a los PADRES del alumno/a. NO respondas a la/el docente. NO agregues información que no esté en el texto original. Simplemente reformulá lo que dijo la maestra/el maestro para que llegue claramente a la familia. Empezá con "La/El docente informa que " o "Según la/el docente, ". Máx 2 oraciones.`,
        },
        { role: 'user', content: `Respuesta de la/el docente: "${rawReply}"` },
      ],
      max_tokens: 150, temperature: 0.2,
    });
    return c.choices[0]?.message?.content?.trim() || rawReply;
  } catch { return rawReply; }
}

// ── POST /parent/message — parent only ────────────────────────
// Rate limit: 2 messages per parent per day
router.post('/parent/message', auth, roles('parent'), async (req, res) => {
  try {
    const parentId = req.user.id;
    const { studentId, message } = req.body;
    if (!studentId || !message?.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'studentId y message son requeridos' } });
    }

    // Verify parent-child link
    const { rows: linkRows } = await db.query(
      'SELECT 1 FROM parent_student_links WHERE parent_id = $1 AND student_id = $2',
      [parentId, studentId]
    );
    if (!linkRows.length) return res.status(403).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'No estás vinculado a este alumno' } });

    // Rate limit: 2/day per parent
    const { rows: [rateRow] } = await db.query(`
      SELECT COUNT(*)::int AS cnt FROM diwy_messages
      WHERE parent_id = $1 AND created_at > NOW() - INTERVAL '1 day'
    `, [parentId]).catch(() => ({ rows: [{ cnt: 0 }] }));

    if ((rateRow?.cnt || 0) >= 2) {
      return res.status(429).json({ ok: false, error: { code: 'RATE_LIMITED', message: 'Llegaste al límite de 2 mensajes por día. Intentá mañana.' } });
    }

    const { rows: [student] } = await db.query('SELECT nombre FROM users WHERE id = $1', [studentId]);
    if (!student) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Alumno no encontrado' } });

    // AI format the message
    let formattedMsg = message.trim();
    try {
      const openai = getOpenAI();
      formattedMsg = await formatParentMessage(student.nombre, message.trim(), openai);
    } catch { /* NO_API_KEY — use raw */ }

    // Save message
    const { rows: [msg] } = await db.query(`
      INSERT INTO diwy_messages (parent_id, student_id, original_msg, formatted_msg)
      VALUES ($1, $2, $3, $4)
      RETURNING id, estado, created_at, formatted_msg
    `, [parentId, studentId, message.trim(), formattedMsg]);

    // Notify all active teachers via DB + socket (instant)
    const { rows: teachers } = await db.query(
      "SELECT id FROM users WHERE rol = 'teacher' AND activo = TRUE"
    );
    if (teachers.length > 0) {
      const vals = teachers.map((_, i) => `($${i*3+1}, $${i*3+2}, $${i*3+3})`).join(', ');
      const params = teachers.flatMap(t => [t.id, 'diwy_message', `Nuevo mensaje de padres sobre ${student.nombre}`]);
      await db.query(`INSERT INTO notifications (user_id, tipo, mensaje) VALUES ${vals}`, params).catch(() => {});

      const io = getIO();
      if (io) teachers.forEach(t =>
        io.to(`user:${t.id}`).emit('diwy_message', {
          alumno_nombre: student.nombre,
          formatted_msg: formattedMsg,
        })
      );
    }

    res.json({ ok: true, data: msg });
  } catch (e) {
    console.error('[diwy] POST /parent/message:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── GET /parent/messages — parent only ────────────────────────
router.get('/parent/messages', auth, roles('parent'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT m.id, m.student_id, u.nombre AS alumno_nombre,
        m.original_msg, m.formatted_msg, m.formatted_reply,
        m.estado, m.created_at, m.replied_at,
        t.nombre AS docente_nombre
      FROM diwy_messages m
      JOIN users u ON u.id = m.student_id
      LEFT JOIN users t ON t.id = m.teacher_id
      WHERE m.parent_id = $1
      ORDER BY m.created_at DESC
      LIMIT 20
    `, [req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[diwy] GET /parent/messages:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── GET /teacher/classrooms — teacher's own classrooms ────────
router.get('/teacher/classrooms', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.nombre
      FROM classrooms c
      JOIN classroom_members cm ON cm.classroom_id = c.id
      WHERE cm.user_id = $1 AND c.activa = TRUE
      ORDER BY c.nombre
    `, [req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[diwy] GET /teacher/classrooms:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── GET /teacher/messages — teacher/admin only ────────────────
// Query params: classroom_id, date_from (YYYY-MM-DD), date_to (YYYY-MM-DD)
router.get('/teacher/messages', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const classroom_id = req.query.classroom_id || null;
    const date_from    = req.query.date_from    || null;
    const date_to      = req.query.date_to      || null;

    const { rows } = await db.query(`
      SELECT DISTINCT ON (m.id)
        m.id, m.student_id, s.nombre AS alumno_nombre,
        m.formatted_msg, m.original_msg, m.teacher_reply, m.formatted_reply,
        m.estado, m.created_at, m.replied_at,
        c.id   AS classroom_id,
        c.nombre AS classroom_nombre
      FROM diwy_messages m
      JOIN users s ON s.id = m.student_id
      LEFT JOIN classroom_members cm ON cm.user_id = m.student_id AND cm.rol = 'student'
      LEFT JOIN classrooms c ON c.id = cm.classroom_id
      WHERE m.created_at > NOW() - INTERVAL '2 years'
        AND ($1::uuid IS NULL OR c.id = $1::uuid)
        AND ($2::date IS NULL OR m.created_at >= $2::date)
        AND ($3::date IS NULL OR m.created_at <  ($3::date + INTERVAL '1 day'))
      ORDER BY m.id, m.created_at DESC
      LIMIT 500
    `, [classroom_id, date_from, date_to]);

    // Re-sort after DISTINCT ON
    rows.sort((a, b) => {
      if (a.estado === b.estado) return new Date(b.created_at) - new Date(a.created_at);
      return a.estado === 'pending' ? -1 : 1;
    });

    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[diwy] GET /teacher/messages:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── PATCH /teacher/messages/:id/reply — teacher/admin only ────
router.patch('/teacher/messages/:id/reply', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { reply } = req.body;
    if (!reply?.trim()) return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'reply es requerido' } });

    const { rows: [msg] } = await db.query('SELECT * FROM diwy_messages WHERE id = $1', [req.params.id]);
    if (!msg) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Mensaje no encontrado' } });

    // AI format the reply
    let formattedReply = reply.trim();
    try {
      const openai = getOpenAI();
      formattedReply = await formatTeacherReply(reply.trim(), openai);
    } catch { /* NO_API_KEY — use raw */ }

    const { rows: [updated] } = await db.query(`
      UPDATE diwy_messages
      SET teacher_reply = $1, formatted_reply = $2,
          teacher_id = $3, estado = 'replied', replied_at = NOW()
      WHERE id = $4
      RETURNING id, estado, replied_at, formatted_reply
    `, [reply.trim(), formattedReply, req.user.id, req.params.id]);

    // Notify parent via DB notification + socket (instant)
    await db.query(
      `INSERT INTO notifications (user_id, tipo, mensaje) VALUES ($1, 'diwy_reply', $2)`,
      [msg.parent_id, 'La maestra respondió tu consulta en Diwy']
    ).catch(() => {});

    const io = getIO();
    if (io) io.to(`user:${msg.parent_id}`).emit('diwy_reply', {
      message_id:      updated.id,
      formatted_reply: formattedReply,
      replied_at:      updated.replied_at,
    });

    res.json({ ok: true, data: updated });
  } catch (e) {
    console.error('[diwy] PATCH /teacher/messages/:id/reply:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── GET /teacher/attendance — load students + their status for a date ──────
router.get('/teacher/attendance', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { classroom_id, fecha } = req.query;
    if (!classroom_id) return res.status(400).json({ ok:false, error:{ code:'MISSING_FIELDS', message:'classroom_id requerido' } });
    const dateStr = fecha || new Date().toISOString().split('T')[0];

    const { rows } = await db.query(`
      SELECT u.id, u.nombre, a.estado
      FROM classroom_members cm
      JOIN users u ON u.id = cm.user_id AND u.rol = 'student' AND u.activo = TRUE
      LEFT JOIN attendance a ON a.student_id = u.id AND a.fecha = $2
      WHERE cm.classroom_id = $1
      ORDER BY u.nombre ASC
    `, [classroom_id, dateStr]);

    // Return first_saved so frontend can show lock status
    const { rows:[lockMeta] } = await db.query(`
      SELECT MIN(created_at) AS first_saved FROM attendance
      WHERE classroom_id=$1 AND fecha=$2
    `, [classroom_id, dateStr]);

    res.json({ ok: true, data: rows, first_saved: lockMeta?.first_saved || null });
  } catch (e) {
    console.error('[diwy] GET /teacher/attendance:', e);
    res.status(500).json({ ok:false, error:{ code:'SERVER_ERROR', message:e.message } });
  }
});

// ── POST /teacher/attendance — upsert with 4-hour lock ───────────────────
router.post('/teacher/attendance', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { classroom_id, fecha, records } = req.body;
    if (!classroom_id || !fecha || !Array.isArray(records) || records.length === 0)
      return res.status(400).json({ ok:false, error:{ code:'MISSING_FIELDS' } });

    // 4-hour lock check
    const { rows:[lockRow] } = await db.query(`
      SELECT MIN(created_at) AS first_saved FROM attendance
      WHERE classroom_id=$1 AND fecha=$2
    `, [classroom_id, fecha]);

    const locked = lockRow?.first_saved &&
      (Date.now() - new Date(lockRow.first_saved).getTime()) > 4 * 3600 * 1000;

    if (locked) {
      // Check for an approved (unconsumed) edit request
      const { rows:[approved] } = await db.query(`
        SELECT id FROM attendance_edit_requests
        WHERE teacher_id=$1 AND classroom_id=$2 AND fecha=$3 AND status='approved'
        LIMIT 1
      `, [req.user.id, classroom_id, fecha]);

      if (!approved) {
        return res.status(403).json({ ok:false, error:{
          code:'ATTENDANCE_LOCKED',
          message:'Han pasado más de 4 horas. Solicitá autorización al administrador para editar.',
        }});
      }
      // Consume the authorization
      await db.query(`UPDATE attendance_edit_requests SET status='consumed' WHERE id=$1`, [approved.id]);
    }

    const valid = ['presente','ausente','tarde'];
    for (const r of records) {
      if (!r.student_id || !valid.includes(r.estado)) continue;
      await db.query(`
        INSERT INTO attendance (student_id, classroom_id, teacher_id, fecha, estado)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (student_id, fecha)
        DO UPDATE SET estado=$5, teacher_id=$3, classroom_id=$2
      `, [r.student_id, classroom_id, req.user.id, fecha, r.estado]);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[diwy] POST /teacher/attendance:', e);
    res.status(500).json({ ok:false, error:{ code:'SERVER_ERROR', message:e.message } });
  }
});

// ── GET /teacher/attendance/history — past records summary ────────────────
router.get('/teacher/attendance/history', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        a.classroom_id, c.nombre AS classroom_nombre,
        a.fecha::text,
        COUNT(*)::int                                         AS total,
        COUNT(*) FILTER (WHERE a.estado='presente')::int     AS presentes,
        COUNT(*) FILTER (WHERE a.estado='ausente')::int      AS ausentes,
        COUNT(*) FILTER (WHERE a.estado='tarde')::int        AS tardes,
        MIN(a.created_at)                                    AS first_saved
      FROM attendance a
      JOIN classrooms c ON c.id = a.classroom_id
      WHERE a.teacher_id = $1
      GROUP BY a.classroom_id, c.nombre, a.fecha
      ORDER BY a.fecha DESC, c.nombre
      LIMIT 60
    `, [req.user.id]);
    res.json({ ok:true, data:rows });
  } catch(e) {
    res.status(500).json({ ok:false, error:{ code:'SERVER_ERROR', message:e.message } });
  }
});

// ── POST /teacher/attendance/request-edit — request unlock ────────────────
router.post('/teacher/attendance/request-edit', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { classroom_id, fecha, motivo } = req.body;
    if (!classroom_id || !fecha)
      return res.status(400).json({ ok:false, error:{ code:'MISSING_FIELDS' } });

    // Avoid duplicate pending requests
    const { rows:[existing] } = await db.query(`
      SELECT id FROM attendance_edit_requests
      WHERE teacher_id=$1 AND classroom_id=$2 AND fecha=$3 AND status='pending'
    `, [req.user.id, classroom_id, fecha]);
    if (existing) return res.json({ ok:true, data:{ id:existing.id, status:'pending' } });

    const { rows:[req_] } = await db.query(`
      INSERT INTO attendance_edit_requests (teacher_id, classroom_id, fecha, motivo)
      VALUES ($1,$2,$3,$4) RETURNING id, status, created_at
    `, [req.user.id, classroom_id, fecha, motivo||null]);

    // Notify admins via socket
    try {
      const { getIO } = require('../socket');
      const io = getIO();
      if (io) io.emit('attendance_edit_request', { classroom_id, fecha });
    } catch {}

    res.json({ ok:true, data:req_ });
  } catch(e) {
    res.status(500).json({ ok:false, error:{ code:'SERVER_ERROR', message:e.message } });
  }
});

// ── GET /admin/attendance — admin read-only view ──────────────────────────
router.get('/admin/attendance', auth, roles('admin'), async (req, res) => {
  try {
    const { fecha, search } = req.query;
    const dateStr = fecha || new Date().toISOString().split('T')[0];

    if (search?.trim()) {
      // Cross-classroom search by name or id fragment
      const { rows } = await db.query(`
        SELECT DISTINCT ON (u.id)
          u.id, u.nombre, a.estado, a.fecha::text,
          c.id AS classroom_id, c.nombre AS classroom_nombre,
          t.nombre AS teacher_nombre
        FROM users u
        JOIN classroom_members cm ON cm.user_id = u.id
        JOIN classrooms c ON c.id = cm.classroom_id AND c.activa = TRUE
        LEFT JOIN attendance a ON a.student_id = u.id AND a.fecha = $2
        LEFT JOIN users t ON t.id = a.teacher_id
        WHERE u.rol = 'student' AND u.activo = TRUE
          AND (u.nombre ILIKE '%' || $1 || '%' OR u.id::text ILIKE $1 || '%')
        ORDER BY u.id, u.nombre
        LIMIT 60
      `, [search.trim(), dateStr]);
      return res.json({ ok:true, data: rows });
    }

    // Overview: all classrooms with attendance summary for the date
    const { rows } = await db.query(`
      SELECT
        c.id, c.nombre,
        COUNT(DISTINCT cm.user_id)::int                          AS total_students,
        COUNT(DISTINCT a.student_id)::int                        AS marked,
        COUNT(*) FILTER (WHERE a.estado='presente')::int         AS presentes,
        COUNT(*) FILTER (WHERE a.estado='ausente')::int          AS ausentes,
        COUNT(*) FILTER (WHERE a.estado='tarde')::int            AS tardes,
        MIN(a.created_at)                                        AS taken_at,
        MAX(t.nombre)                                            AS teacher_nombre
      FROM classrooms c
      JOIN classroom_members cm ON cm.classroom_id = c.id AND cm.rol = 'student'
      LEFT JOIN attendance a   ON a.student_id = cm.user_id AND a.fecha = $1
      LEFT JOIN users t        ON t.id = a.teacher_id
      WHERE c.activa = TRUE
      GROUP BY c.id, c.nombre
      ORDER BY c.nombre
    `, [dateStr]);
    res.json({ ok:true, data: rows });
  } catch(e) {
    console.error('[diwy] GET /admin/attendance:', e);
    res.status(500).json({ ok:false, error:{ code:'SERVER_ERROR', message:e.message } });
  }
});

// ── GET /admin/attendance/:classroomId/detail — students for a date ────────
router.get('/admin/attendance/:classroomId/detail', auth, roles('admin'), async (req, res) => {
  try {
    const { fecha } = req.query;
    const dateStr = fecha || new Date().toISOString().split('T')[0];
    const { rows } = await db.query(`
      SELECT u.id, u.nombre, a.estado, a.created_at, t.nombre AS teacher_nombre
      FROM classroom_members cm
      JOIN users u ON u.id = cm.user_id AND u.rol = 'student' AND u.activo = TRUE
      LEFT JOIN attendance a ON a.student_id = u.id AND a.fecha = $2
      LEFT JOIN users t ON t.id = a.teacher_id
      WHERE cm.classroom_id = $1
      ORDER BY u.nombre
    `, [req.params.classroomId, dateStr]);
    res.json({ ok:true, data: rows });
  } catch(e) {
    res.status(500).json({ ok:false, error:{ code:'SERVER_ERROR', message:e.message } });
  }
});

// ── GET /admin/attendance/edit-requests — pending edit requests ────────────
router.get('/admin/attendance/edit-requests', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT r.*, t.nombre AS teacher_nombre, c.nombre AS classroom_nombre
      FROM attendance_edit_requests r
      JOIN users t       ON t.id = r.teacher_id
      JOIN classrooms c  ON c.id = r.classroom_id
      WHERE r.status = 'pending'
      ORDER BY r.created_at ASC
    `);
    res.json({ ok:true, data:rows });
  } catch(e) {
    res.status(500).json({ ok:false, error:{ code:'SERVER_ERROR', message:e.message } });
  }
});

// ── PATCH /admin/attendance/edit-requests/:id — approve or deny ────────────
router.patch('/admin/attendance/edit-requests/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { action } = req.body; // 'approved' | 'denied'
    if (!['approved','denied'].includes(action))
      return res.status(400).json({ ok:false, error:{ code:'INVALID_ACTION' } });

    const { rows:[updated] } = await db.query(`
      UPDATE attendance_edit_requests
      SET status=$1, reviewed_by=$2, reviewed_at=NOW()
      WHERE id=$3 AND status='pending'
      RETURNING *
    `, [action, req.user.id, req.params.id]);

    if (!updated) return res.status(404).json({ ok:false, error:{ code:'NOT_FOUND' } });

    // Notify teacher
    try {
      const { getIO } = require('../socket');
      const io = getIO();
      if (io) io.to(`user:${updated.teacher_id}`).emit('attendance_request_reviewed', {
        status: action, classroom_id: updated.classroom_id, fecha: updated.fecha,
      });
    } catch {}

    res.json({ ok:true, data:updated });
  } catch(e) {
    res.status(500).json({ ok:false, error:{ code:'SERVER_ERROR', message:e.message } });
  }
});

// ── GET /parent/attendance — attendance for linked children ───────────────
router.get('/parent/attendance', auth, roles('parent'), async (req, res) => {
  try {
    const weeks = Math.min(Math.max(parseInt(req.query.weeks) || 1, 1), 8);
    const { rows } = await db.query(`
      SELECT a.fecha::text, a.estado, a.student_id, u.nombre AS student_nombre
      FROM attendance a
      JOIN users u ON u.id = a.student_id
      JOIN parent_student_links psl ON psl.student_id = a.student_id
      WHERE psl.parent_id = $1
        AND a.fecha >= CURRENT_DATE - ($2 * 7)::int
      ORDER BY a.fecha DESC, u.nombre ASC
    `, [req.user.id, weeks]);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[diwy] GET /parent/attendance:', e);
    res.status(500).json({ ok:false, error:{ code:'SERVER_ERROR', message:e.message } });
  }
});

// ── POST /teacher/preview — teacher/admin only ────────────────
// Upserts today's class preview (one per day, last write wins)
router.post('/teacher/preview', auth, roles('admin', 'teacher'), async (req, res) => {
  try {
    const { tema, detalle } = req.body;
    if (!tema?.trim()) return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'tema es requerido' } });

    const { imagen } = req.body;
    const { rows: [preview] } = await db.query(`
      INSERT INTO diwy_class_preview (teacher_id, fecha, tema, detalle, imagen)
      VALUES ($1, CURRENT_DATE, $2, $3, $4)
      ON CONFLICT (fecha) DO UPDATE
        SET tema = EXCLUDED.tema, detalle = EXCLUDED.detalle,
            imagen = EXCLUDED.imagen,
            teacher_id = EXCLUDED.teacher_id, created_at = NOW()
      RETURNING *
    `, [req.user.id, tema.trim(), detalle?.trim() || null, imagen || null]);

    // Notify all connected parents instantly
    const io = getIO();
    if (io) io.emit('diwy_preview', {
      tema:           preview.tema,
      detalle:        preview.detalle,
      imagen:         preview.imagen,
      docente_nombre: req.user.nombre,
      fecha:          preview.fecha,
    });

    res.json({ ok: true, data: preview });
  } catch (e) {
    console.error('[diwy] POST /teacher/preview:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// ── GET /parent/preview — parent only ─────────────────────────
router.get('/parent/preview', auth, roles('parent'), async (req, res) => {
  try {
    // Return today's preview if it exists
    const { rows: [preview] } = await db.query(`
      SELECT p.tema, p.detalle, p.imagen, p.fecha, u.nombre AS docente_nombre
      FROM diwy_class_preview p
      JOIN users u ON u.id = p.teacher_id
      WHERE p.fecha = CURRENT_DATE
      LIMIT 1
    `);
    res.json({ ok: true, data: preview || null });
  } catch (e) {
    console.error('[diwy] GET /parent/preview:', e);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

module.exports = router;
