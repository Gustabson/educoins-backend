// src/routes/chat.js
// Endpoints REST del modulo Chat
// Los mensajes en tiempo real van por WebSocket (src/socket.js)
//
// GET  /api/v1/chat/global/messages        -> historial global (ultimos 50)
// GET  /api/v1/chat/classroom/messages     -> historial del aula del usuario
// GET  /api/v1/chat/personal/:userId/messages -> historial con un amigo
// GET  /api/v1/chat/friends                -> lista de amigos aceptados + pendientes
// POST /api/v1/chat/friends/request        -> enviar solicitud de amistad
// POST /api/v1/chat/friends/:id/accept     -> aceptar solicitud
// POST /api/v1/chat/friends/:id/reject     -> rechazar solicitud
// GET  /api/v1/chat/classroom/info         -> info del aula del usuario
// GET  /api/v1/chat/users/search           -> buscar usuarios para agregar

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const auth    = require('../middleware/auth');
const roles   = require('../middleware/roles');

const MSG_LIMIT = 50; // mensajes por pagina

// ── Funcion auxiliar: obtener o crear conversacion personal ───
async function getOrCreatePersonalConv(userA, userB) {
  // Buscar si ya existe
  const { rows } = await db.query(`
    SELECT c.id FROM conversations c
    JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $1
    JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $2
    WHERE c.type = 'personal'
    LIMIT 1
  `, [userA, userB]);

  if (rows.length > 0) return rows[0].id;

  // Crear nueva conversacion personal
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const { rows: conv } = await client.query(
      "INSERT INTO conversations (type) VALUES ('personal') RETURNING id"
    );
    const convId = conv[0].id;
    await client.query(
      'INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2),($1,$3)',
      [convId, userA, userB]
    );
    await client.query('COMMIT');
    return convId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── GET /chat/global/info ─────────────────────────────────────
// Devuelve el conversation_id del chat global
router.get('/global/info', auth, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT id AS conversation_id FROM conversations WHERE type = 'global' LIMIT 1"
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Chat global no existe' } });
    }
    // Asegurar que el usuario esté en la tabla de miembros
    await db.query(`
      INSERT INTO conversation_members (conversation_id, user_id)
      VALUES ($1, $2) ON CONFLICT DO NOTHING
    `, [rows[0].conversation_id, req.user.id]);
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('GET /chat/global/info error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error' } });
  }
});

// ── GET /chat/global/messages ─────────────────────────────────
router.get('/global/messages', auth, async (req, res) => {
  try {
    const before = req.query.before || null; // cursor para paginacion
    const { rows } = await db.query(`
      SELECT
        m.id, m.texto, m.created_at,
        m.conversation_id,
        u.id        AS sender_id,
        u.nombre    AS sender_nombre,
        u.rol       AS sender_rol,
        u.skin, u.border
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id AND c.type = 'global'
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE ($1::timestamptz IS NULL OR m.created_at < $1)
      ORDER BY m.created_at DESC
      LIMIT $2
    `, [before, MSG_LIMIT]);

    // Marcar como leido
    const { rows: conv } = await db.query(
      "SELECT id FROM conversations WHERE type = 'global' LIMIT 1"
    );
    if (conv.length > 0) {
      await db.query(`
        INSERT INTO conversation_members (conversation_id, user_id, last_read_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (conversation_id, user_id)
        DO UPDATE SET last_read_at = NOW()
      `, [conv[0].id, req.user.id]);
    }

    res.json({ ok: true, data: rows.reverse() });
  } catch (err) {
    console.error('GET /chat/global/messages error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al cargar mensajes' } });
  }
});

// ── GET /chat/classroom/info ──────────────────────────────────
router.get('/classroom/info', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        cl.id, cl.nombre, cl.descripcion,
        COUNT(cm.user_id)::int AS total_miembros,
        conv.id AS conversation_id
      FROM classrooms cl
      JOIN classroom_members cm_me ON cm_me.classroom_id = cl.id AND cm_me.user_id = $1
      JOIN classroom_members cm    ON cm.classroom_id    = cl.id
      LEFT JOIN conversations conv ON conv.classroom_id  = cl.id AND conv.type = 'classroom'
      WHERE cl.activa = TRUE
      GROUP BY cl.id, cl.nombre, cl.descripcion, conv.id
      LIMIT 1
    `, [req.user.id]);

    if (rows.length === 0) {
      return res.json({ ok: true, data: null }); // no pertenece a ningun aula
    }
    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('GET /chat/classroom/info error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al cargar aula' } });
  }
});

// ── GET /chat/classroom/messages ──────────────────────────────
router.get('/classroom/messages', auth, async (req, res) => {
  try {
    // Verificar que el usuario pertenece a un aula
    const { rows: aula } = await db.query(`
      SELECT conv.id AS conversation_id
      FROM conversations conv
      JOIN classroom_members cm ON cm.classroom_id = conv.classroom_id AND cm.user_id = $1
      WHERE conv.type = 'classroom'
      LIMIT 1
    `, [req.user.id]);

    if (aula.length === 0) {
      return res.status(403).json({ ok: false, error: { code: 'NOT_IN_CLASSROOM', message: 'No perteneces a ningun aula' } });
    }

    const convId = aula[0].conversation_id;
    const before = req.query.before || null;

    const { rows } = await db.query(`
      SELECT
        m.id, m.texto, m.created_at,
        m.conversation_id,
        u.id     AS sender_id,
        u.nombre AS sender_nombre,
        u.rol    AS sender_rol,
        u.skin, u.border
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = $1
        AND ($2::timestamptz IS NULL OR m.created_at < $2)
      ORDER BY m.created_at DESC
      LIMIT $3
    `, [convId, before, MSG_LIMIT]);

    // Actualizar last_read
    await db.query(`
      INSERT INTO conversation_members (conversation_id, user_id, last_read_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = NOW()
    `, [convId, req.user.id]);

    res.json({ ok: true, data: rows.reverse() });
  } catch (err) {
    console.error('GET /chat/classroom/messages error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al cargar mensajes' } });
  }
});

// ── GET /chat/personal/:userId/messages ───────────────────────
router.get('/personal/:userId/messages', auth, async (req, res) => {
  try {
    const otherId = req.params.userId;

    // Verificar amistad aceptada
    const { rows: friendship } = await db.query(`
      SELECT id FROM friendships
      WHERE estado = 'accepted'
        AND ((requester_id = $1 AND addressee_id = $2)
          OR (requester_id = $2 AND addressee_id = $1))
    `, [req.user.id, otherId]);

    if (friendship.length === 0) {
      return res.status(403).json({ ok: false, error: { code: 'NOT_FRIENDS', message: 'Solo podes chatear con tus amigos' } });
    }

    const convId = await getOrCreatePersonalConv(req.user.id, otherId);
    const before = req.query.before || null;

    const { rows } = await db.query(`
      SELECT
        m.id, m.texto, m.created_at,
        m.conversation_id,
        u.id     AS sender_id,
        u.nombre AS sender_nombre,
        u.skin, u.border
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = $1
        AND ($2::timestamptz IS NULL OR m.created_at < $2)
      ORDER BY m.created_at DESC
      LIMIT $3
    `, [convId, before, MSG_LIMIT]);

    await db.query(`
      INSERT INTO conversation_members (conversation_id, user_id, last_read_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET last_read_at = NOW()
    `, [convId, req.user.id]);

    res.json({ ok: true, data: { messages: rows.reverse(), conversation_id: convId } });
  } catch (err) {
    console.error('GET /chat/personal/:userId/messages error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al cargar mensajes' } });
  }
});

// ── GET /chat/friends ─────────────────────────────────────────
router.get('/friends', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        f.id        AS friendship_id,
        f.estado,
        f.created_at,
        -- El "otro" usuario en la relacion
        CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END AS user_id,
        CASE WHEN f.requester_id = $1 THEN ua.nombre     ELSE ur.nombre     END AS nombre,
        CASE WHEN f.requester_id = $1 THEN ua.skin       ELSE ur.skin       END AS skin,
        CASE WHEN f.requester_id = $1 THEN ua.border     ELSE ur.border     END AS border,
        CASE WHEN f.requester_id = $1 THEN ua.rol        ELSE ur.rol        END AS rol,
        -- soy yo el que envio la solicitud?
        (f.requester_id = $1) AS soy_requester
      FROM friendships f
      JOIN users ur ON ur.id = f.requester_id
      JOIN users ua ON ua.id = f.addressee_id
      WHERE (f.requester_id = $1 OR f.addressee_id = $1)
        AND f.estado IN ('pending', 'accepted')
      ORDER BY f.estado DESC, f.created_at DESC
    `, [req.user.id]);

    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('GET /chat/friends error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al cargar amigos' } });
  }
});

// ── GET /chat/users/search ────────────────────────────────────
router.get('/users/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) {
      return res.json({ ok: true, data: [] });
    }

    const { rows } = await db.query(`
      SELECT u.id, u.nombre, u.rol, u.skin, u.border,
        f.estado AS friendship_estado,
        f.id     AS friendship_id
      FROM users u
      LEFT JOIN friendships f ON
        (f.requester_id = $1 AND f.addressee_id = u.id) OR
        (f.addressee_id = $1 AND f.requester_id = u.id)
      WHERE u.id <> $1
        AND u.activo = TRUE
        AND u.nombre ILIKE $2
      ORDER BY u.nombre
      LIMIT 10
    `, [req.user.id, `%${q}%`]);

    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('GET /chat/users/search error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al buscar usuarios' } });
  }
});

// ── POST /chat/friends/request ────────────────────────────────
// Body: { addressee_id: UUID }
router.post('/friends/request', auth, async (req, res) => {
  try {
    const { addressee_id } = req.body;
    if (!addressee_id) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_BODY', message: 'Falta addressee_id' } });
    }
    if (addressee_id === req.user.id) {
      return res.status(400).json({ ok: false, error: { code: 'SELF_FRIEND', message: 'No podes agregarte a vos mismo' } });
    }

    // Verificar que el usuario destino existe
    const { rows: target } = await db.query(
      'SELECT id, nombre FROM users WHERE id = $1 AND activo = TRUE',
      [addressee_id]
    );
    if (target.length === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Usuario no encontrado' } });
    }

    try {
      const { rows } = await db.query(`
        INSERT INTO friendships (requester_id, addressee_id, estado)
        VALUES ($1, $2, 'pending')
        RETURNING id, estado, created_at
      `, [req.user.id, addressee_id]);

      res.status(201).json({ ok: true, data: { ...rows[0], nombre: target[0].nombre } });
    } catch (e) {
      if (e.code === '23505') {
        return res.status(409).json({ ok: false, error: { code: 'ALREADY_REQUESTED', message: 'Ya existe una solicitud con este usuario' } });
      }
      throw e;
    }
  } catch (err) {
    console.error('POST /chat/friends/request error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al enviar solicitud' } });
  }
});

// ── POST /chat/friends/:id/accept ─────────────────────────────
router.post('/friends/:id/accept', auth, async (req, res) => {
  try {
    const { rows, rowCount } = await db.query(`
      UPDATE friendships
      SET estado = 'accepted', updated_at = NOW()
      WHERE id = $1 AND addressee_id = $2 AND estado = 'pending'
      RETURNING id, requester_id, addressee_id, estado
    `, [req.params.id, req.user.id]);

    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Solicitud no encontrada' } });
    }

    // Crear conversacion personal entre ambos
    await getOrCreatePersonalConv(rows[0].requester_id, rows[0].addressee_id);

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('POST /chat/friends/:id/accept error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al aceptar solicitud' } });
  }
});

// ── POST /chat/friends/:id/reject ─────────────────────────────
router.post('/friends/:id/reject', auth, async (req, res) => {
  try {
    const { rowCount } = await db.query(`
      DELETE FROM friendships
      WHERE id = $1
        AND (addressee_id = $2 OR requester_id = $2)
        AND estado = 'pending'
    `, [req.params.id, req.user.id]);

    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Solicitud no encontrada' } });
    }

    res.json({ ok: true, data: { message: 'Solicitud rechazada' } });
  } catch (err) {
    console.error('POST /chat/friends/:id/reject error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al rechazar solicitud' } });
  }
});

module.exports = router;
