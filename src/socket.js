// src/socket.js
// Logica WebSocket con socket.io
// Maneja conexiones, salas y mensajes en tiempo real
//
// Eventos que recibe del cliente:
//   join_global             -> unirse al chat global
//   join_classroom          -> unirse al chat del aula
//   join_personal (userId)  -> unirse a una sala personal
//   send_message { conversation_id, texto, type }
//   typing { conversation_id, type }
//
// Eventos que emite al cliente:
//   new_message  { message }
//   user_typing  { user_id, nombre, conversation_id }
//   error        { message }

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./config/env');
const db = require('./config/db');

// Rooms nomenclatura:
//   global:           "global"
//   classroom:        "classroom:{classroom_id}"
//   personal:         "personal:{conversation_id}"

function initSocket(io) {

  // ── Middleware de autenticacion ──────────────────────────────
  // El cliente debe enviar el token JWT en el handshake
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('NO_TOKEN'));

      let payload;
      try {
        payload = jwt.verify(token, JWT_SECRET);
      } catch {
        return next(new Error('INVALID_TOKEN'));
      }

      const { rows } = await db.query(
        'SELECT id, nombre, rol, skin, border, activo FROM users WHERE id = $1',
        [payload.sub]
      );
      if (rows.length === 0 || !rows[0].activo) {
        return next(new Error('ACCOUNT_INACTIVE'));
      }

      // Adjuntar usuario al socket
      socket.user = rows[0];
      next();
    } catch (err) {
      console.error('Socket auth error:', err);
      next(new Error('SERVER_ERROR'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.user;
    console.log(`Socket conectado: ${user.nombre} (${user.rol}) [${socket.id}]`);

    // ── Unirse al chat global ──────────────────────────────────
    socket.on('join_global', async () => {
      try {
        socket.join('global');
        // Agregar al usuario a la tabla si no esta
        const { rows: conv } = await db.query(
          "SELECT id FROM conversations WHERE type = 'global' LIMIT 1"
        );
        if (conv.length > 0) {
          await db.query(`
            INSERT INTO conversation_members (conversation_id, user_id)
            VALUES ($1, $2) ON CONFLICT DO NOTHING
          `, [conv[0].id, user.id]);
        }
      } catch (err) {
        console.error('join_global error:', err);
      }
    });

    // ── Unirse al chat del aula ────────────────────────────────
    socket.on('join_classroom', async () => {
      try {
        const { rows } = await db.query(`
          SELECT cl.id AS classroom_id, conv.id AS conversation_id
          FROM classroom_members cm
          JOIN classrooms cl ON cl.id = cm.classroom_id AND cl.activa = TRUE
          LEFT JOIN conversations conv ON conv.classroom_id = cl.id AND conv.type = 'classroom'
          WHERE cm.user_id = $1
          LIMIT 1
        `, [user.id]);

        if (rows.length === 0) return;

        const room = `classroom:${rows[0].classroom_id}`;
        socket.join(room);
        socket.classroomRoom = room;
        socket.classroomConvId = rows[0].conversation_id;
      } catch (err) {
        console.error('join_classroom error:', err);
      }
    });

    // ── Unirse a una sala personal ─────────────────────────────
    socket.on('join_personal', async (conversationId) => {
      try {
        // Verificar que el usuario es miembro de esta conversacion
        const { rows } = await db.query(`
          SELECT 1 FROM conversation_members
          WHERE conversation_id = $1 AND user_id = $2
        `, [conversationId, user.id]);

        if (rows.length === 0) return;

        const room = `personal:${conversationId}`;
        socket.join(room);
      } catch (err) {
        console.error('join_personal error:', err);
      }
    });

    // ── Enviar mensaje ─────────────────────────────────────────
    // Payload: { conversation_id, texto, type: 'global'|'classroom'|'personal' }
    socket.on('send_message', async ({ conversation_id, texto, type }) => {
      try {
        // Validaciones basicas
        if (!texto || typeof texto !== 'string') return;
        const textoClean = texto.trim().substring(0, 1000);
        if (textoClean.length === 0) return;
        if (!conversation_id || !type) return;

        // Verificar que el usuario tiene acceso a esta conversacion
        const { rows: access } = await db.query(`
          SELECT 1 FROM conversation_members
          WHERE conversation_id = $1 AND user_id = $2
        `, [conversation_id, user.id]);

        if (access.length === 0) {
          socket.emit('error', { message: 'No tenes acceso a esta conversacion' });
          return;
        }

        // Guardar mensaje en la DB
        const { rows } = await db.query(`
          INSERT INTO messages (conversation_id, sender_id, texto)
          VALUES ($1, $2, $3)
          RETURNING id, conversation_id, texto, created_at
        `, [conversation_id, user.id, textoClean]);

        const message = {
          ...rows[0],
          sender_id:     user.id,
          sender_nombre: user.nombre,
          sender_rol:    user.rol,
          skin:          user.skin,
          border:        user.border,
        };

        // Emitir al room correcto segun el tipo
        let room;
        if (type === 'global') {
          room = 'global';
        } else if (type === 'classroom') {
          // Encontrar el classroom_id de esta conversacion
          const { rows: conv } = await db.query(
            'SELECT classroom_id FROM conversations WHERE id = $1',
            [conversation_id]
          );
          if (conv.length > 0) room = `classroom:${conv[0].classroom_id}`;
        } else if (type === 'personal') {
          room = `personal:${conversation_id}`;
        }

        if (room) {
          io.to(room).emit('new_message', message);
        }

      } catch (err) {
        console.error('send_message error:', err);
        socket.emit('error', { message: 'Error al enviar mensaje' });
      }
    });

    // ── Indicador de escritura ─────────────────────────────────
    // Payload: { conversation_id, type }
    socket.on('typing', ({ conversation_id, type }) => {
      try {
        let room;
        if (type === 'global') room = 'global';
        else if (type === 'classroom' && socket.classroomRoom) room = socket.classroomRoom;
        else if (type === 'personal') room = `personal:${conversation_id}`;

        if (room) {
          // Emitir a todos menos al que escribe
          socket.to(room).emit('user_typing', {
            user_id:         user.id,
            nombre:          user.nombre,
            conversation_id,
          });
        }
      } catch (err) {
        console.error('typing error:', err);
      }
    });

    // ── Desconexion ────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.log(`Socket desconectado: ${user.nombre} — ${reason}`);
    });
  });
}

module.exports = initSocket;
