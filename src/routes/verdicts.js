// src/routes/verdicts.js
// Canal de veredictos del superadmin → alumnos.
// Solo el superadmin puede enviar veredictos.
// Los alumnos pueden ver y marcar como leídos los propios.

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const db       = require('../config/db');
const auth     = require('../middleware/auth');
const roles    = require('../middleware/roles');
const router   = express.Router();

// ── Startup migration ─────────────────────────────────────────
db.query(`
  CREATE TABLE IF NOT EXISTS verdicts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    to_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mensaje        TEXT NOT NULL,
    severity       TEXT NOT NULL DEFAULT 'advertencia',
    coins_penalty  INTEGER NOT NULL DEFAULT 0,
    read_at        TIMESTAMPTZ,
    created_at     TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.warn('[verdicts] table migration:', e.message));

// ── POST / — enviar veredicto (superadmin) ────────────────────
router.post('/', auth, roles('admin'), async (req, res) => {
  const client = await db.getClient();
  try {
    const { to_user_ids, mensaje, severity = 'advertencia', coins_penalty = 0 } = req.body;
    if (!to_user_ids?.length || !mensaje?.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'Destinatarios y mensaje son requeridos' } });
    }
    const penalty = Math.max(0, parseInt(coins_penalty) || 0);

    // Obtener treasury una sola vez si hay penalización
    let treasuryId = null;
    if (penalty > 0) {
      const { rows: tr } = await client.query(
        "SELECT id FROM accounts WHERE account_type = 'treasury' AND is_active = TRUE LIMIT 1"
      );
      treasuryId = tr[0]?.id;
    }

    const { getIO } = require('../socket');
    const io = getIO();
    const results = [];

    for (const userId of to_user_ids) {
      await client.query('BEGIN');
      try {
        // Insertar veredicto
        const { rows } = await client.query(`
          INSERT INTO verdicts (from_user_id, to_user_id, mensaje, severity, coins_penalty)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `, [req.user.id, userId, mensaje.trim(), severity, penalty]);

        const verdict = rows[0];

        // Aplicar penalización económica si corresponde
        if (penalty > 0 && treasuryId) {
          const { rows: accRows } = await client.query(
            'SELECT id FROM accounts WHERE user_id = $1 AND is_active = TRUE LIMIT 1',
            [userId]
          );
          const userAccId = accRows[0]?.id;

          if (userAccId) {
            const { rows: balRows } = await client.query(
              'SELECT COALESCE(SUM(amount), 0)::INTEGER AS bal FROM ledger_entries WHERE account_id = $1',
              [userAccId]
            );
            const cobrar = Math.min(parseInt(balRows[0].bal), penalty);

            if (cobrar > 0) {
              const txId = uuidv4();
              await client.query(
                `INSERT INTO transactions (id, type, description, initiated_by, metadata)
                 VALUES ($1, 'adjustment', $2, $3, $4)`,
                [txId,
                 `Penalización veredicto: ${mensaje.trim().substring(0, 80)}`,
                 req.user.id,
                 JSON.stringify({ verdict_id: verdict.id, severity, coins_penalty: cobrar })]
              );
              await client.query(
                'INSERT INTO ledger_entries (id, transaction_id, account_id, amount) VALUES ($1,$2,$3,$4)',
                [uuidv4(), txId, userAccId, -cobrar]
              );
              await client.query(
                'INSERT INTO ledger_entries (id, transaction_id, account_id, amount) VALUES ($1,$2,$3,$4)',
                [uuidv4(), txId, treasuryId, cobrar]
              );
            }
          }
        }

        await client.query('COMMIT');
        results.push(verdict);

        // Emitir al alumno en tiempo real
        if (io) {
          io.to(`user:${userId}`).emit('new_verdict', {
            id:            verdict.id,
            mensaje:       verdict.mensaje,
            severity:      verdict.severity,
            coins_penalty: verdict.coins_penalty,
            created_at:    verdict.created_at,
            from_nombre:   req.user.nombre,
          });
        }

      } catch (innerErr) {
        await client.query('ROLLBACK');
        console.error(`[verdicts] error procesando userId ${userId}:`, innerErr);
        results.push({ to_user_id: userId, error: innerErr.message });
      }
    }

    res.json({ ok: true, data: results });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[verdicts] POST:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  } finally {
    client.release();
  }
});

// ── GET / — todos los veredictos (superadmin) ─────────────────
router.get('/', auth, roles('admin'), async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT v.*,
             u.nombre  AS to_nombre,
             f.nombre  AS from_nombre
      FROM verdicts v
      JOIN users u ON u.id = v.to_user_id
      LEFT JOIN users f ON f.id = v.from_user_id
      ORDER BY v.created_at DESC
      LIMIT 300
    `);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── GET /mine — veredictos propios (alumno) ───────────────────
router.get('/mine', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT v.*, f.nombre AS from_nombre
      FROM verdicts v
      LEFT JOIN users f ON f.id = v.from_user_id
      WHERE v.to_user_id = $1
      ORDER BY v.created_at DESC
    `, [req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── PATCH /:id/read — marcar como leído (alumno) ──────────────
router.patch('/:id/read', auth, async (req, res) => {
  try {
    await db.query(`
      UPDATE verdicts SET read_at = NOW()
      WHERE id = $1 AND to_user_id = $2 AND read_at IS NULL
    `, [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

module.exports = router;
