// CRUD de documentos oficiales usados por el asistente de IA.

const express = require('express');
const db = require('../config/db');
const auth = require('../middleware/auth');
const roles = require('../middleware/roles');
const uuidParams = require('../middleware/uuid-params');
const { validate: isUuid } = require('uuid');
const router = express.Router();
uuidParams(router, 'id');

const TYPES = new Set(['reglamento', 'institucional']);
const MAX_CONTENT_CHARS = 100_000;

router.get('/', auth, roles('admin'), async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, tipo, titulo, activo, char_length(contenido) AS caracteres, updated_at
         FROM ai_documents
        ORDER BY tipo, updated_at DESC`
    );
    return res.json({ ok: true, data: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.get('/:id', auth, roles('admin'), async (req, res) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_ID', message: 'Documento inválido' } });
    }
    const { rows } = await db.query('SELECT * FROM ai_documents WHERE id=$1', [req.params.id]);
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Documento no encontrado' } });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.post('/', auth, roles('admin'), async (req, res) => {
  try {
    const { tipo, titulo, contenido = '' } = req.body;
    if (!TYPES.has(tipo) || typeof titulo !== 'string' ||
        titulo.trim().length < 3 || titulo.trim().length > 200 ||
        typeof contenido !== 'string' || contenido.length > MAX_CONTENT_CHARS) {
      return res.status(400).json({
        ok: false,
        error: { code: 'INVALID_DOCUMENT', message: 'Revisá el tipo, el título y el contenido del documento' },
      });
    }
    const { rows } = await db.query(
      `INSERT INTO ai_documents (tipo, titulo, contenido, created_by)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [tipo, titulo.trim(), contenido, req.user.id]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.patch('/:id', auth, roles('admin'), async (req, res) => {
  try {
    const { titulo, contenido, activo } = req.body;
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_ID', message: 'Documento inválido' } });
    }
    if ((titulo !== undefined && (typeof titulo !== 'string' || titulo.trim().length < 3 || titulo.trim().length > 200)) ||
        (contenido !== undefined && (typeof contenido !== 'string' || contenido.length > MAX_CONTENT_CHARS)) ||
        (activo !== undefined && typeof activo !== 'boolean')) {
      return res.status(400).json({
        ok: false,
        error: { code: 'INVALID_DOCUMENT', message: 'Los datos del documento no son válidos' },
      });
    }
    if (titulo === undefined && contenido === undefined && activo === undefined) {
      return res.status(400).json({ ok: false, error: { code: 'NO_CHANGES', message: 'No hay cambios para guardar' } });
    }
    const { rows } = await db.query(
      `UPDATE ai_documents
          SET titulo=COALESCE($2,titulo),
              contenido=COALESCE($3,contenido),
              activo=COALESCE($4,activo),
              updated_at=NOW()
        WHERE id=$1
        RETURNING *`,
      [req.params.id, titulo?.trim(), contenido, activo]
    );
    if (!rows.length) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Documento no encontrado' } });
    }
    return res.json({ ok: true, data: rows[0] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

router.delete('/:id', auth, roles('admin'), async (req, res) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_ID', message: 'Documento inválido' } });
    }
    const result = await db.query('DELETE FROM ai_documents WHERE id=$1', [req.params.id]);
    if (!result.rowCount) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Documento no encontrado' } });
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: error.message } });
  }
});

module.exports = router;
