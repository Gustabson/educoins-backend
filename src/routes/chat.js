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
// POST /api/v1/chat/groups                 -> crear grupo
// GET  /api/v1/chat/groups                 -> mis grupos
// GET  /api/v1/chat/groups/:id/messages    -> mensajes de un grupo

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
        COALESCE(u.apodo, u.nombre) AS sender_nombre,
        u.apodo AS sender_apodo,
        u.rol       AS sender_rol,
        u.skin, u.border, u.avatar_bg, u.foto_url
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
        COALESCE(u.apodo, u.nombre) AS sender_nombre,
        u.apodo AS sender_apodo,
        u.rol    AS sender_rol,
        u.skin, u.border, u.avatar_bg, u.foto_url
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

    // Verificar que existe una conversacion personal entre ambos (independiente de si siguen siendo amigos)
    const { rows: convCheck } = await db.query(`
      SELECT c.id FROM conversations c
      JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $1
      JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $2
      WHERE c.type = 'personal'
      LIMIT 1
    `, [req.user.id, otherId]);

    if (convCheck.length === 0) {
      return res.status(403).json({ ok: false, error: { code: 'NO_CONVERSATION', message: 'No hay conversacion con este usuario' } });
    }

    const convId = await getOrCreatePersonalConv(req.user.id, otherId);
    const before = req.query.before || null;

    const { rows } = await db.query(`
      SELECT
        m.id, m.texto, m.created_at,
        m.conversation_id,
        u.id     AS sender_id,
        COALESCE(u.apodo, u.nombre) AS sender_nombre,
        u.apodo AS sender_apodo,
        u.skin, u.border, u.avatar_bg, u.foto_url
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
        CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END AS user_id,
        CASE WHEN f.requester_id = $1 THEN ua.nombre     ELSE ur.nombre     END AS nombre,
        CASE WHEN f.requester_id = $1 THEN ua.apodo      ELSE ur.apodo      END AS apodo,
        CASE WHEN f.requester_id = $1 THEN ua.skin       ELSE ur.skin       END AS skin,
        CASE WHEN f.requester_id = $1 THEN ua.border     ELSE ur.border     END AS border,
        CASE WHEN f.requester_id = $1 THEN ua.avatar_bg  ELSE ur.avatar_bg  END AS avatar_bg,
        CASE WHEN f.requester_id = $1 THEN ua.foto_url   ELSE ur.foto_url   END AS foto_url,
        CASE WHEN f.requester_id = $1 THEN ua.rol        ELSE ur.rol        END AS rol,
        (f.requester_id = $1) AS soy_requester
      FROM friendships f
      JOIN users ur ON ur.id = f.requester_id
      JOIN users ua ON ua.id = f.addressee_id
      WHERE (f.requester_id = $1 OR f.addressee_id = $1)
        AND f.estado IN ('pending', 'accepted')
        -- Filtro asimétrico: solo mostrar si YO no me eliminé
        AND NOT (f.requester_id = $1 AND f.removed_by_requester)
        AND NOT (f.addressee_id = $1 AND f.removed_by_addressee)
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
      SELECT u.id, u.nombre, u.apodo, u.rol, u.skin, u.border, u.avatar_bg, u.foto_url,
        f.estado AS friendship_estado,
        f.id     AS friendship_id
      FROM users u
      LEFT JOIN friendships f ON
        (f.requester_id = $1 AND f.addressee_id = u.id) OR
        (f.addressee_id = $1 AND f.requester_id = u.id)
      WHERE u.id <> $1
        AND u.activo = TRUE
        AND (u.nombre ILIKE $2 OR u.apodo ILIKE $2)
      ORDER BY
        -- Priorizar coincidencia exacta de apodo, luego nombre
        CASE WHEN LOWER(u.apodo) = LOWER($3) THEN 0
             WHEN LOWER(u.nombre) = LOWER($3) THEN 1
             WHEN u.apodo ILIKE $2 THEN 2
             ELSE 3 END,
        COALESCE(u.apodo, u.nombre)
      LIMIT 15
    `, [req.user.id, `%${q}%`, q]);

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

      // Notificar al destinatario en tiempo real
      const { getIO } = require('../socket');
      const io = getIO();
      if (io) {
        io.to(`user:${addressee_id}`).emit('friend_request', {
          friendship_id: rows[0].id,
          from_user_id:  req.user.id,
          from_nombre:   req.user.nombre,
        });
      }

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

    // Notificar al requester en tiempo real
    const { getIO } = require('../socket');
    const io = getIO();
    if (io) {
      io.to(`user:${rows[0].requester_id}`).emit('friend_accepted', {
        friendship_id: rows[0].id,
        by_user_id:    req.user.id,
        by_nombre:     req.user.nombre,
      });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('POST /chat/friends/:id/accept error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al aceptar solicitud' } });
  }
});

// ── DELETE /chat/friends/:id ──────────────────────────────────
// Eliminación asimétrica: solo marca que YO eliminé, el otro sigue viéndolo
router.delete('/friends/:id', auth, async (req, res) => {
  try {
    const { rows, rowCount } = await db.query(`
      UPDATE friendships
      SET
        removed_by_requester = CASE WHEN requester_id = $2 THEN TRUE ELSE removed_by_requester END,
        removed_by_addressee = CASE WHEN addressee_id = $2 THEN TRUE ELSE removed_by_addressee END,
        updated_at = NOW()
      WHERE id = $1
        AND (requester_id = $2 OR addressee_id = $2)
        AND estado = 'accepted'
      RETURNING
        requester_id, addressee_id,
        CASE WHEN requester_id = $2 THEN addressee_id ELSE requester_id END AS other_id
    `, [req.params.id, req.user.id]);

    if (rowCount === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Amistad no encontrada' } });
    }

    // Notificar al otro en tiempo real
    const { getIO } = require('../socket');
    const io = getIO();
    if (io) {
      io.to(`user:${rows[0].other_id}`).emit('friend_removed', {
        friendship_id: req.params.id,
        by_user_id: req.user.id,
      });
    }

    res.json({ ok: true, data: { message: 'Amigo eliminado' } });
  } catch (err) {
    console.error('DELETE /chat/friends/:id error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al eliminar amigo' } });
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

// ── POST /chat/groups ─────────────────────────────────────────
router.post('/groups', auth, async (req, res) => {
  try {
    let { nombre, icono, member_ids } = req.body;

    nombre = (nombre || '').trim().substring(0, 40);
    icono  = (icono  || '👥').trim().substring(0, 4) || '👥';

    if (nombre.length < 2) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_NAME', message: 'El nombre debe tener al menos 2 caracteres' } });
    }
    if (!Array.isArray(member_ids) || member_ids.length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'NO_MEMBERS', message: 'Seleccioná al menos un miembro' } });
    }
    const MAX_MEMBERS = 30;
    if (member_ids.length > MAX_MEMBERS - 1) {
      return res.status(400).json({ ok: false, error: { code: 'TOO_MANY_MEMBERS', message: `Máximo ${MAX_MEMBERS} miembros por grupo` } });
    }

    // Todos los miembros deben ser amigos del creador
    const { rows: friends } = await db.query(`
      SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id
      FROM friendships
      WHERE (requester_id = $1 OR addressee_id = $1)
        AND estado = 'accepted'
        AND NOT (requester_id = $1 AND removed_by_requester)
        AND NOT (addressee_id = $1 AND removed_by_addressee)
    `, [req.user.id]);
    const friendIds = new Set(friends.map(f => f.friend_id));
    const invalid = member_ids.filter(id => !friendIds.has(id));
    if (invalid.length > 0) {
      return res.status(400).json({ ok: false, error: { code: 'NOT_FRIENDS', message: 'Solo podés agregar amigos al grupo' } });
    }

    // Límite: 10 grupos creados por usuario
    const { rows: gc } = await db.query(
      "SELECT COUNT(*)::int AS total FROM conversations WHERE type = 'group' AND created_by = $1",
      [req.user.id]
    );
    if (gc[0].total >= 10) {
      return res.status(400).json({ ok: false, error: { code: 'TOO_MANY_GROUPS', message: 'Máximo 10 grupos por usuario' } });
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const { rows: conv } = await client.query(
        "INSERT INTO conversations (type, nombre, icono, created_by) VALUES ('group',$1,$2,$3) RETURNING id",
        [nombre, icono, req.user.id]
      );
      const convId = conv[0].id;
      await client.query(
        'INSERT INTO conversation_members (conversation_id, user_id, rol) VALUES ($1,$2,$3)',
        [convId, req.user.id, 'owner']
      );
      for (const mid of member_ids) {
        await client.query(
          'INSERT INTO conversation_members (conversation_id, user_id, rol) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [convId, mid, 'member']
        );
      }
      await client.query('COMMIT');

      const { getIO } = require('../socket');
      const io = getIO();
      if (io) {
        // Notificar a miembros Y al creador
        [...member_ids, req.user.id].forEach(uid => {
          io.to(`user:${uid}`).emit('group_added', { conversation_id: convId, nombre, icono, by_nombre: req.user.nombre });
        });
      }

      res.status(201).json({ ok: true, data: { conversation_id: convId, nombre, icono } });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /chat/groups error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al crear grupo' } });
  }
});

// ── GET /chat/groups ──────────────────────────────────────────
router.get('/groups', auth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        c.id AS conversation_id, c.nombre, c.icono, c.created_at,
        c.allow_invites,
        cm.rol AS my_rol,
        COUNT(cm2.user_id)::int AS total_miembros
      FROM conversations c
      JOIN conversation_members cm  ON cm.conversation_id  = c.id AND cm.user_id = $1
      JOIN conversation_members cm2 ON cm2.conversation_id = c.id
      WHERE c.type = 'group'
      GROUP BY c.id, c.nombre, c.icono, c.created_at, c.allow_invites, cm.rol
      ORDER BY c.created_at DESC
    `, [req.user.id]);
    res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('GET /chat/groups error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al cargar grupos' } });
  }
});

// ── GET /chat/groups/:id/messages ─────────────────────────────
router.get('/groups/:id/messages', auth, async (req, res) => {
  try {
    const convId = req.params.id;
    const { rows: access } = await db.query(
      'SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',
      [convId, req.user.id]
    );
    if (access.length === 0) {
      return res.status(403).json({ ok: false, error: { code: 'NOT_MEMBER', message: 'No sos miembro de este grupo' } });
    }

    const before = req.query.before || null;
    const { rows } = await db.query(`
      SELECT
        m.id, m.texto, m.created_at, m.conversation_id,
        u.id AS sender_id,
        COALESCE(u.apodo, u.nombre) AS sender_nombre,
        u.apodo AS sender_apodo, u.rol AS sender_rol,
        u.skin, u.border, u.avatar_bg, u.foto_url
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
    console.error('GET /chat/groups/:id/messages error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al cargar mensajes del grupo' } });
  }
});

// ── POST /chat/groups/:id/members ────────────────────────────
// Cualquier miembro puede invitar a SUS propios amigos (si allow_invites=true)
// El admin puede invitar a cualquiera que sea su amigo
router.post('/groups/:id/members', auth, async (req, res) => {
  try {
    const convId = req.params.id;
    const { user_id: newMemberId } = req.body;
    if (!newMemberId) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_BODY', message: 'Falta user_id' } });
    }

    // Verificar que el invitador es miembro
    const { rows: myMembership } = await db.query(
      'SELECT rol FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',
      [convId, req.user.id]
    );
    if (myMembership.length === 0) {
      return res.status(403).json({ ok: false, error: { code: 'NOT_MEMBER', message: 'No sos miembro del grupo' } });
    }
    const isAdmin = myMembership[0].rol === 'owner';

    // Si no es admin, verificar que allow_invites está activo
    if (!isAdmin) {
      const { rows: grp } = await db.query(
        'SELECT allow_invites FROM conversations WHERE id=$1',
        [convId]
      );
      if (!grp[0]?.allow_invites) {
        return res.status(403).json({ ok: false, error: { code: 'INVITES_DISABLED', message: 'Solo el admin puede invitar en este grupo' } });
      }
    }

    // El nuevo miembro debe ser amigo del INVITADOR (no del creador)
    const { rows: friendship } = await db.query(`
      SELECT 1 FROM friendships
      WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)
        AND estado='accepted'
        AND NOT (requester_id=$1 AND removed_by_requester)
        AND NOT (addressee_id=$1 AND removed_by_addressee)
    `, [req.user.id, newMemberId]);
    if (friendship.length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'NOT_FRIENDS', message: 'Solo podés invitar a tus amigos' } });
    }

    // Verificar límite de miembros
    const { rows: count } = await db.query(
      'SELECT COUNT(*)::int AS total FROM conversation_members WHERE conversation_id=$1',
      [convId]
    );
    if (count[0].total >= 30) {
      return res.status(400).json({ ok: false, error: { code: 'TOO_MANY_MEMBERS', message: 'El grupo alcanzó el límite de 30 miembros' } });
    }

    await db.query(
      'INSERT INTO conversation_members (conversation_id, user_id, rol) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [convId, newMemberId, 'member']
    );

    const { getIO } = require('../socket');
    const io = getIO();
    if (io) {
      io.to(`user:${newMemberId}`).emit('group_added', {
        conversation_id: convId,
        by_nombre: req.user.nombre,
      });
    }

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('POST /chat/groups/:id/members error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al agregar miembro' } });
  }
});

// ── PATCH /chat/groups/:id/settings ──────────────────────────
// Solo el admin (owner) puede modificar configuración del grupo
router.patch('/groups/:id/settings', auth, async (req, res) => {
  try {
    const convId = req.params.id;

    const { rows: membership } = await db.query(
      'SELECT rol FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',
      [convId, req.user.id]
    );
    if (membership.length === 0 || membership[0].rol !== 'owner') {
      return res.status(403).json({ ok: false, error: { code: 'NOT_ADMIN', message: 'Solo el admin puede modificar el grupo' } });
    }

    const { allow_invites, nombre, icono } = req.body;
    const updates = [];
    const vals = [];
    let i = 1;

    if (allow_invites !== undefined) { updates.push(`allow_invites=$${i++}`); vals.push(allow_invites); }
    if (nombre !== undefined) {
      const n = nombre.trim().substring(0, 40);
      if (n.length < 2) return res.status(400).json({ ok: false, error: { code: 'INVALID_NAME', message: 'Nombre muy corto' } });
      updates.push(`nombre=$${i++}`); vals.push(n);
    }
    if (icono !== undefined) { updates.push(`icono=$${i++}`); vals.push(icono.trim().substring(0,4)||'👥'); }

    if (updates.length === 0) {
      return res.status(400).json({ ok: false, error: { code: 'NO_CHANGES', message: 'Nada para actualizar' } });
    }

    vals.push(convId);
    const { rows } = await db.query(
      `UPDATE conversations SET ${updates.join(',')} WHERE id=$${i} RETURNING id, nombre, icono, allow_invites`,
      vals
    );

    res.json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error('PATCH /chat/groups/:id/settings error:', err);
    res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error al actualizar grupo' } });
  }
});

module.exports = router;
