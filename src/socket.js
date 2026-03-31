// src/socket.js
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./config/env');
const db = require('./config/db');

// Rooms:
//   global, classroom:{id}, personal:{conv_id}, user:{user_id}

// Exportar io para usarlo desde otras rutas
let _io = null;
function getIO() { return _io; }

function initSocket(io) {
  _io = io;

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('NO_TOKEN'));
      let payload;
      try { payload = jwt.verify(token, JWT_SECRET); }
      catch { return next(new Error('INVALID_TOKEN')); }
      const { rows } = await db.query(
        'SELECT id, nombre, apodo, rol, skin, border, avatar_bg, foto_url, activo FROM users WHERE id = $1',
        [payload.sub]
      );
      if (rows.length === 0 || !rows[0].activo) return next(new Error('ACCOUNT_INACTIVE'));
      socket.user = rows[0];
      next();
    } catch (err) {
      next(new Error('SERVER_ERROR'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.user;
    console.log(`Socket conectado: ${user.nombre} (${user.rol}) [${socket.id}]`);

    // ── Sala personal de notificaciones ─────────────────────────
    // Cada usuario tiene su propia sala para recibir notificaciones
    socket.join(`user:${user.id}`);

    // ── Chat global ──────────────────────────────────────────────
    socket.on('join_global', async () => {
      try {
        socket.join('global');
        const { rows: conv } = await db.query(
          "SELECT id FROM conversations WHERE type = 'global' LIMIT 1"
        );
        if (conv.length > 0) {
          await db.query(`
            INSERT INTO conversation_members (conversation_id, user_id)
            VALUES ($1, $2) ON CONFLICT DO NOTHING
          `, [conv[0].id, user.id]);
        }
      } catch (err) { console.error('join_global error:', err); }
    });

    // ── Chat aula ────────────────────────────────────────────────
    socket.on('join_classroom', async () => {
      try {
        const { rows } = await db.query(`
          SELECT cl.id AS classroom_id, conv.id AS conversation_id
          FROM classroom_members cm
          JOIN classrooms cl ON cl.id = cm.classroom_id AND cl.activa = TRUE
          LEFT JOIN conversations conv ON conv.classroom_id = cl.id AND conv.type = 'classroom'
          WHERE cm.user_id = $1 LIMIT 1
        `, [user.id]);
        if (rows.length === 0) return;
        const room = `classroom:${rows[0].classroom_id}`;
        socket.join(room);
        socket.classroomRoom = room;
        socket.classroomConvId = rows[0].conversation_id;
      } catch (err) { console.error('join_classroom error:', err); }
    });

    // ── Chat grupal ──────────────────────────────────────────────
    socket.on('join_group', async (conversationId) => {
      try {
        const { rows } = await db.query(
          'SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2',
          [conversationId, user.id]
        );
        if (rows.length === 0) return;
        socket.join(`group:${conversationId}`);
      } catch (err) { console.error('join_group error:', err); }
    });

    // ── Chat personal ────────────────────────────────────────────
    socket.on('join_personal', async (conversationId) => {
      try {
        const { rows } = await db.query(`
          SELECT 1 FROM conversation_members
          WHERE conversation_id = $1 AND user_id = $2
        `, [conversationId, user.id]);
        if (rows.length === 0) return;
        socket.join(`personal:${conversationId}`);
      } catch (err) { console.error('join_personal error:', err); }
    });

    // ── Enviar mensaje ───────────────────────────────────────────
    socket.on('send_message', async ({ conversation_id, texto, type }) => {
      try {
        if (!texto?.trim() || !conversation_id || !type) return;
        const textoClean = texto.trim().substring(0, 1000);

        const { rows: access } = await db.query(`
          SELECT 1 FROM conversation_members
          WHERE conversation_id = $1 AND user_id = $2
        `, [conversation_id, user.id]);
        if (access.length === 0) { socket.emit('error', { message: 'Sin acceso' }); return; }

        const { rows } = await db.query(`
          INSERT INTO messages (conversation_id, sender_id, texto)
          VALUES ($1, $2, $3) RETURNING id, conversation_id, texto, created_at
        `, [conversation_id, user.id, textoClean]);

        // Obtener apodo y name_color del sender para que el frontend decida según amistad
        let senderApodo = null;
        let senderNameColor = null;
        try {
          const { rows: senderExtra } = await db.query(`
            SELECT u.apodo, sc.config AS name_color_config
            FROM users u
            LEFT JOIN user_custom_active uca ON uca.user_id = u.id
            LEFT JOIN shop_items_custom sc ON sc.id = uca.name_color_id
            WHERE u.id = $1
          `, [user.id]);
          if (senderExtra.length) {
            senderApodo = senderExtra[0].apodo;
            senderNameColor = senderExtra[0].name_color_config;
          }
        } catch(e) {}

        const message = {
          ...rows[0],
          sender_id:          user.id,
          sender_nombre:      user.nombre,   // nombre real siempre
          sender_apodo:       senderApodo,   // frontend usa si son amigos
          sender_rol:         user.rol,
          skin:               user.skin,
          border:             user.border,
          avatar_bg:          user.avatar_bg || null,
          foto_url:           user.foto_url || null,
          sender_name_color:  senderNameColor,
        };

        let room;
        if (type === 'global') {
          room = 'global';
        } else if (type === 'classroom') {
          const { rows: conv } = await db.query(
            'SELECT classroom_id FROM conversations WHERE id = $1', [conversation_id]);
          if (conv.length > 0) room = `classroom:${conv[0].classroom_id}`;
        } else if (type === 'personal') {
          room = `personal:${conversation_id}`;
        } else if (type === 'group') {
          room = `group:${conversation_id}`;
        }

        if (room) io.to(room).emit('new_message', message);

        // ── Notificaciones a miembros que no están en la sala ────
        // Para personal: notificar al otro usuario
        if (type === 'personal') {
          const { rows: members } = await db.query(`
            SELECT user_id FROM conversation_members
            WHERE conversation_id = $1 AND user_id != $2
          `, [conversation_id, user.id]);
          members.forEach(m => {
            io.to(`user:${m.user_id}`).emit('notification', {
              type:    'chat_personal',
              from:    user.nombre,
              preview: textoClean.substring(0, 60),
              conv_id: conversation_id,
            });
          });
        }

      } catch (err) {
        console.error('send_message error:', err);
        socket.emit('error', { message: 'Error al enviar mensaje' });
      }
    });

    // ── Typing ───────────────────────────────────────────────────
    socket.on('typing', ({ conversation_id, type }) => {
      try {
        let room;
        if (type === 'global') room = 'global';
        else if (type === 'classroom' && socket.classroomRoom) room = socket.classroomRoom;
        else if (type === 'personal') room = `personal:${conversation_id}`;
        if (room) {
          socket.to(room).emit('user_typing', { user_id: user.id, nombre: user.nombre, conversation_id });
        }
      } catch (err) { console.error('typing error:', err); }
    });

    socket.on('disconnect', (reason) => {
      console.log(`Socket desconectado: ${user.nombre} — ${reason}`);
    });
  });
}

module.exports = initSocket;
module.exports.getIO = getIO;
