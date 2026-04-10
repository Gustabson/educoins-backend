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
app.use('/api/v1/staff',        require('./routes/staff'));
app.use('/api/v1/verdicts',     require('./routes/verdicts'));
app.use('/api/v1/ai',           require('./routes/ai'));
app.use('/api/v1/ai-docs',      require('./routes/ai-docs'));
app.use('/api/v1/diwy',         require('./routes/diwy'));
app.use('/api/v1/schedules',    require('./routes/schedules'));

// ── One-time migrations ───────────────────────────────────────
// Unify legacy 'maestra' role → 'teacher'
require('./config/db').query(
  "UPDATE users SET rol = 'teacher' WHERE rol = 'maestra'"
).then(r => {
  if (r.rowCount > 0) console.log(`[migration] Migrated ${r.rowCount} user(s) from rol='maestra' to 'teacher'`);
}).catch(e => console.warn('[migration] maestra→teacher:', e.message));

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

// ── Migración: ampliar CHECK constraint de users.rol para incluir parent/staff ─
require('./config/db').query(`
  ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_rol_check,
    ADD CONSTRAINT users_rol_check
      CHECK (rol IN ('student','teacher','admin','parent','staff'))
`).catch(e => console.error('[startup] users_rol_check migration:', e.message));

// ── Iniciar servidor ──────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Aubank API corriendo en http://localhost:${PORT}`);
  console.log(`   WebSocket activo en ws://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
});
