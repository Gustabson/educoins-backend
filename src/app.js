// src/app.js
// Punto de entrada del servidor.
// Configura Express + Socket.io, registra rutas y arranca.

const { PORT } = require('./config/env');
const express  = require('express');
const cors     = require('cors');
const http     = require('http');
const { Server } = require('socket.io');
const initSocket = require('./socket');

const app    = express();
const server = http.createServer(app);

// ── Socket.io ─────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});
initSocket(io);

// ── Middlewares globales ──────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Rutas REST ────────────────────────────────────────────────
app.use('/api/v1/auth',         require('./routes/auth'));
app.use('/api/v1/accounts',     require('./routes/accounts'));
app.use('/api/v1/transactions', require('./routes/transactions'));
app.use('/api/v1/missions',     require('./routes/missions'));
app.use('/api/v1/store',        require('./routes/store'));
app.use('/api/v1/profile',      require('./routes/profile'));
app.use('/api/v1/admin',        require('./routes/admin'));
app.use('/api/v1/posts',        require('./routes/posts'));
app.use('/api/v1/polls',        require('./routes/polls'));
app.use('/api/v1/reports',      require('./routes/reports'));
app.use('/api/v1/chat',         require('./routes/chat'));
app.use('/api/v1/custom',       require('./routes/customization'));
app.use('/api/v1/checkin',      require('./routes/checkin'));
app.use('/api/v1/notifications',require('./routes/notifications'));

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'Aubank API funcionando', timestamp: new Date() });
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' } });
});

// ── Error global ──────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error interno del servidor' } });
});

// ── Iniciar servidor ──────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Aubank API corriendo en http://localhost:${PORT}`);
  console.log(`   WebSocket activo en ws://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
});
