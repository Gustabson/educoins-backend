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
  cors: {
    origin: ['https://educoins-frontend.vercel.app', 'http://localhost:3000', /\.vercel\.app$/],
    methods: ['GET', 'POST'],
    credentials: true,
  }
});
initSocket(io);
app.set('io', io); // Exponer io para req.app.get('io') en rutas

// ── Middlewares globales ──────────────────────────────────────
const corsOptions = {
  origin: [
    'https://educoins-frontend.vercel.app',
    'http://localhost:3000',
    /\.vercel\.app$/,
  ],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
};

// Responder preflight OPTIONS — fix CORS 2026-03-25 00:30 en todas las rutas — necesario para CORS con POST/PATCH/DELETE
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json());

// ── Rutas REST ────────────────────────────────────────────────
app.use('/api/v1/auth',         require('./routes/auth'));
app.use('/api/v1/accounts',     require('./routes/accounts'));
app.use('/api/v1/transactions', require('./routes/transactions'));
app.use('/api/v1/missions',     require('./routes/missions'));
app.use('/api/v1/store',        require('./routes/store'));
app.use('/api/v1/profile',      require('./routes/profile'));
app.use('/api/v1/prizes',       require('./routes/prizes').router);
app.use('/api/v1/p2p',          require('./routes/p2p'));
app.use('/api/v1/admin',        require('./routes/admin'));
app.use('/api/v1/posts',        require('./routes/posts'));
app.use('/api/v1/polls',        require('./routes/polls'));
app.use('/api/v1/reports',      require('./routes/reports'));
app.use('/api/v1/chat',         require('./routes/chat'));
app.use('/api/v1/custom',       require('./routes/customization'));
app.use('/api/v1/checkin',      require('./routes/checkin'));
app.use('/api/v1/notifications',require('./routes/notifications'));
app.use('/api/v1/ranking',      require('./routes/ranking'));
app.use('/api/v1/subscriptions',require('./routes/subscriptions'));
app.use('/api/v1/parent',       require('./routes/parent'));
app.use('/api/v1/wellness',     require('./routes/wellness'));

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

// ── Fix one-time: simetrizar friendships asimétricos (datos viejos) ──────────
require('./config/db').query(`
  UPDATE friendships
  SET removed_by_requester = TRUE, removed_by_addressee = TRUE
  WHERE (removed_by_requester = TRUE AND removed_by_addressee = FALSE)
     OR (removed_by_requester = FALSE AND removed_by_addressee = TRUE)
`).catch(e => console.error('[startup] friendship symmetry fix failed:', e));

// ── Iniciar servidor ──────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Aubank API corriendo en http://localhost:${PORT}`);
  console.log(`   WebSocket activo en ws://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
});
