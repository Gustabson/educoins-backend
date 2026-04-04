// src/routes/ai.js
// Motor de IA: asistente para alumnos + sugeridor de veredictos para admin.
// Usa GPT-4.1-mini (OpenAI) con documentos cargados en ai_documents.

const express = require('express');
const OpenAI  = require('openai');
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');
const router  = express.Router();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL  = 'gpt-4.1-mini';

// ── Startup: tabla de logs ────────────────────────────────────
db.query(`
  CREATE TABLE IF NOT EXISTS ai_queries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    modulo      TEXT NOT NULL,
    pregunta    TEXT NOT NULL,
    respuesta   TEXT,
    tokens_used INTEGER DEFAULT 0,
    escalado    BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.warn('[ai] ai_queries table:', e.message));

// ── Palabras que disparan derivación inmediata a admin ────────
const ESCALATION_TRIGGERS = [
  'me están haciendo daño','me hicieron daño','me golpearon','me pegaron',
  'me amenazaron','me siento en peligro','emergencia','bullying',
  'quiero hablar con alguien','me acosan','me lastimaron',
  'me siento mal','no me siento seguro',
];
const detectEscalation = (text) => {
  const lower = text.toLowerCase();
  return ESCALATION_TRIGGERS.some(t => lower.includes(t));
};

// ── Helper: traer documentos activos por tipo ─────────────────
async function getDocs(tipos) {
  const { rows } = await db.query(
    `SELECT tipo, titulo, contenido
     FROM ai_documents
     WHERE activo = TRUE AND tipo = ANY($1)
     ORDER BY tipo, updated_at DESC`,
    [tipos]
  );
  // Si hay múltiples del mismo tipo, concatenarlos
  const byTipo = {};
  for (const row of rows) {
    if (!byTipo[row.tipo]) byTipo[row.tipo] = { titulo: row.titulo, contenido: '' };
    byTipo[row.tipo].contenido += (byTipo[row.tipo].contenido ? '\n\n' : '') + row.contenido;
  }
  return byTipo;
}

// ── POST /api/v1/ai/query — alumno pregunta al asistente ──────
router.post('/query', auth, async (req, res) => {
  try {
    const { pregunta } = req.body;
    if (!pregunta?.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING', message: 'Pregunta requerida' } });
    }

    // Detección de situaciones urgentes → respuesta fija, sin gastar tokens
    if (detectEscalation(pregunta)) {
      await db.query(
        `INSERT INTO ai_queries (user_id, modulo, pregunta, respuesta, escalado)
         VALUES ($1,'asistente',$2,$3,TRUE)`,
        [req.user.id, pregunta.trim(), 'ESCALADO']
      ).catch(() => {});
      return res.json({
        ok: true,
        data: {
          respuesta: 'Esto parece una situación que necesita atención personal urgente. Te recomiendo hablar directamente con la administración lo antes posible. 📋',
          escalado: true,
        }
      });
    }

    const docs = await getDocs(['reglamento', 'institucional']);
    const regDoc  = docs['reglamento'];
    const instDoc = docs['institucional'];

    if (!regDoc && !instDoc) {
      return res.json({
        ok: true,
        data: {
          respuesta: 'El asistente todavía no tiene documentos cargados. Consultá directamente con la administración. 📋',
          escalado: false,
        }
      });
    }

    const systemPrompt = `Sos el Asistente Oficial de la escuela. Tu rol es responder preguntas de estudiantes.

REGLAS ESTRICTAS:
1. SOLO usás información de los documentos adjuntos abajo
2. Si algo no está en los documentos → respondés exactamente: "No tengo esa información. Te recomiendo hablar con la administración 📋"
3. Cuando cités una regla, indicá el artículo: (Reglamento, Art. X)
4. Nunca inventás sanciones, montos ni plazos que no estén escritos
5. Tono amigable y claro, en español, sin tecnicismos innecesarios
6. Respuestas concisas — máx 200 palabras
7. Si el estudiante describe una situación personal grave → siempre recomendá hablar con la administración

${regDoc  ? `[REGLAMENTO — ${regDoc.titulo}]:\n${regDoc.contenido}` : ''}

${instDoc ? `[INSTITUCIONAL — ${instDoc.titulo}]:\n${instDoc.contenido}` : ''}`;

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: 'system',  content: systemPrompt },
        { role: 'user',    content: pregunta.trim() },
      ],
    });

    const respuesta = completion.choices[0].message.content;
    const tokens    = completion.usage?.total_tokens || 0;

    await db.query(
      `INSERT INTO ai_queries (user_id, modulo, pregunta, respuesta, tokens_used)
       VALUES ($1,'asistente',$2,$3,$4)`,
      [req.user.id, pregunta.trim(), respuesta, tokens]
    ).catch(() => {});

    res.json({ ok: true, data: { respuesta, escalado: false } });

  } catch (err) {
    console.error('[ai] /query:', err);
    res.status(500).json({ ok: false, error: { code: 'AI_ERROR', message: 'Error al consultar la IA. Intentá de nuevo.' } });
  }
});

// ── POST /api/v1/ai/verdict-suggest — admin solicita veredicto ─
router.post('/verdict-suggest', auth, roles('admin'), async (req, res) => {
  try {
    const { caso } = req.body;
    if (!caso?.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING', message: 'Descripción del caso requerida' } });
    }

    const docs   = await getDocs(['reglamento']);
    const regDoc = docs['reglamento'];

    const systemPrompt = `Sos el asesor legal interno de la escuela. Redactás veredictos oficiales basándote EXCLUSIVAMENTE en el reglamento adjunto.

INSTRUCCIONES:
• Analizá el caso y determiná la severidad apropiada (advertencia / sancion / grave)
• Citá el artículo específico que fundamenta la decisión
• Si el caso NO está cubierto por el reglamento → indicalo en nota_para_admin
• Sugerí penalización en EduCoins solo si el reglamento lo habilita (0 si no aplica)
• El veredicto debe ser formal, claro y respetuoso — en primera persona institucional
• Esta es una SUGERENCIA: el administrador tiene la decisión final

${regDoc
  ? `[REGLAMENTO]:\n${regDoc.contenido}`
  : '[REGLAMENTO]: No hay reglamento cargado. Procedé con criterio general de convivencia escolar.'
}

Respondé ÚNICAMENTE con JSON válido y sin texto adicional:
{
  "severity": "advertencia|sancion|grave",
  "fundamento": "Artículo X — texto exacto de la regla que aplica",
  "veredicto": "texto formal del veredicto en primera persona institucional, máx 220 palabras",
  "coins_sugeridas": 0,
  "nota_para_admin": "observaciones adicionales o advertencias para el administrador"
}`;

    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0,
      max_tokens: 700,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `Caso a evaluar:\n${caso.trim()}` },
      ],
    });

    let suggestion;
    try {
      suggestion = JSON.parse(completion.choices[0].message.content);
    } catch {
      return res.status(500).json({ ok: false, error: { code: 'PARSE_ERROR', message: 'La IA devolvió una respuesta inválida. Intentá de nuevo.' } });
    }

    const tokens = completion.usage?.total_tokens || 0;
    await db.query(
      `INSERT INTO ai_queries (user_id, modulo, pregunta, respuesta, tokens_used)
       VALUES ($1,'veredicto',$2,$3,$4)`,
      [req.user.id, caso.trim(), JSON.stringify(suggestion), tokens]
    ).catch(() => {});

    res.json({ ok: true, data: suggestion });

  } catch (err) {
    console.error('[ai] /verdict-suggest:', err);
    res.status(500).json({ ok: false, error: { code: 'AI_ERROR', message: 'Error al consultar la IA. Intentá de nuevo.' } });
  }
});

module.exports = router;
