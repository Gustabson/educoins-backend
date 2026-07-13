// src/app.js
// Punto de entrada del servidor.
// Configura Express + Socket.io, registra rutas y arranca.

const { PORT, NODE_ENV, FRONTEND_URL } = require('./config/env');
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const http     = require('http');
const crypto   = require('crypto');
const { Server } = require('socket.io');
const initSocket = require('./socket');
const { runCoreMigrations } = require('./config/migrations');
const { expirePendingOrders } = require('./services/p2p');
const { processDueTaxes } = require('./services/taxes');
const sanitizeErrors = require('./middleware/sanitize-errors');

const app    = express();
const server = http.createServer(app);
app.disable('x-powered-by');
if (NODE_ENV === 'production') app.set('trust proxy', 1);

const isAllowedOrigin = origin => {
  if (!origin) return true;
  if (origin === FRONTEND_URL || origin === 'https://educoins-frontend.vercel.app') return true;
  if (/^https:\/\/educoins-frontend(?:-[a-z0-9]+)*\.vercel\.app$/i.test(origin)) return true;
  if (NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1):(3000|3001|4173|5173)$/i.test(origin)) return true;
  return false;
};

const corsOrigin = (origin, callback) => callback(null, isAllowedOrigin(origin));

// ── Socket.io ─────────────────────────────────────────────────
const io = new Server(server, {
  serveClient: false,
  maxHttpBufferSize: 100_000,
  perMessageDeflate: false,
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  }
});
initSocket(io);
app.set('io', io); // Exponer io para req.app.get('io') en rutas

// ── Middlewares globales ──────────────────────────────────────
const corsOptions = {
  origin: corsOrigin,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
};

// Responder preflight OPTIONS — fix CORS 2026-03-25 00:30 en todas las rutas — necesario para CORS con POST/PATCH/DELETE
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use((req, res, next) => {
  req.id = req.get('x-request-id') || crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
});
app.use(express.json({ limit: '1mb', strict: true }));
app.use(sanitizeErrors);

const rateLimitHandler = (req, res) => res.status(429).json({
  ok: false,
  error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes. Esperá un momento e intentá de nuevo.' }
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3000,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: rateLimitHandler,
});
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 8,
  keyGenerator: req => `${ipKeyGenerator(req.ip)}:${String(req.body?.email || '').trim().toLowerCase()}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: rateLimitHandler,
});
app.use('/api', apiLimiter);
app.use('/api/v1/auth/login', loginLimiter);

let applicationRegistered = false;
function registerApplication() {
  if (applicationRegistered) return;
  applicationRegistered = true;

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
app.use('/api/v1/academic',     require('./routes/academic'));
app.use('/api/v1/peer-eval',    require('./routes/peer-eval'));

// ── Health check ──────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await require('./config/db').query('SELECT 1');
    res.json({ ok: true, service: 'educoins-api', status: 'healthy', timestamp: new Date() });
  } catch {
    res.status(503).json({ ok: false, service: 'educoins-api', status: 'unavailable' });
  }
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' } });
});

// ── Error global ──────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'El contenido enviado es demasiado grande' } });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_JSON', message: 'El cuerpo de la solicitud no es JSON válido' } });
  }
  res.status(500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Error interno del servidor' } });
});
}

// ── Iniciar servidor ──────────────────────────────────────────
server.requestTimeout = 65_000;
server.headersTimeout = 70_000;
server.keepAliveTimeout = 5_000;
let p2pExpiryTimer;
let taxTimer;

async function startServer() {
  await runCoreMigrations();
  registerApplication();
  await expirePendingOrders().catch(error => console.error('Error venciendo órdenes P2P:', error.message));
  await processDueTaxes().catch(error => console.error('Error procesando impuestos:', error.message));
  return server.listen(PORT, () => {
    console.log(`EduCoins API corriendo en http://localhost:${PORT}`);
    console.log(`   WebSocket activo en ws://localhost:${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/health`);
    p2pExpiryTimer = setInterval(() => {
      expirePendingOrders().catch(error => console.error('Error venciendo órdenes P2P:', error.message));
    }, 60_000);
    p2pExpiryTimer.unref();
    taxTimer = setInterval(() => {
      processDueTaxes().catch(error => console.error('Error procesando impuestos:', error.message));
    }, 15 * 60_000);
    taxTimer.unref();
  });
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('No se pudo iniciar EduCoins:', error);
    process.exit(1);
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (p2pExpiryTimer) clearInterval(p2pExpiryTimer);
  if (taxTimer) clearInterval(taxTimer);
  console.log(`${signal}: cerrando servidor de forma segura`);
  io.close();
  server.close(async () => {
    await require('./config/db').close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, startServer };
