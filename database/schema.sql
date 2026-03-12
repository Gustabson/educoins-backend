-- ============================================================
-- EduCoins - Schema de Base de Datos
-- PostgreSQL 15+
-- Ejecutar: psql $DATABASE_URL -f database/schema.sql
-- ============================================================

-- Extensión para UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── USERS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  nombre          VARCHAR(255) NOT NULL,
  rol             VARCHAR(20) NOT NULL CHECK (rol IN ('admin','teacher','student')),
  activo          BOOLEAN DEFAULT true,
  created_at      TIMESTAMP DEFAULT NOW(),

  -- Gamificación
  skin            VARCHAR(10) DEFAULT 's1',
  border          VARCHAR(10) DEFAULT 'b1',
  title           VARCHAR(10) DEFAULT 'tl1',
  unlocked_skins    TEXT[] DEFAULT '{s1}',
  unlocked_borders  TEXT[] DEFAULT '{b1}',
  unlocked_titles   TEXT[] DEFAULT '{tl1}',
  total_earned    INTEGER DEFAULT 0
);

-- ── ACCOUNTS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID REFERENCES users(id),  -- NULL para cuentas sistema
  account_type  VARCHAR(20) NOT NULL CHECK (account_type IN ('student','teacher','treasury','store','void')),
  label         VARCHAR(255) NOT NULL,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- ── TRANSACTIONS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type            VARCHAR(20) NOT NULL CHECK (type IN ('mint','reward','purchase','transfer','adjustment')),
  description     VARCHAR(500) NOT NULL,
  initiated_by    UUID REFERENCES users(id),
  reference_id    UUID,
  reference_type  VARCHAR(50),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ── LEDGER_ENTRIES ───────────────────────────────────────────
-- El corazón del sistema. Nunca se editan ni borran.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id  UUID NOT NULL REFERENCES transactions(id),
  account_id      UUID NOT NULL REFERENCES accounts(id),
  amount          INTEGER NOT NULL,  -- positivo=crédito, negativo=débito
  created_at      TIMESTAMP DEFAULT NOW()
);

-- Índice para calcular balances rápidamente
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_transaction ON ledger_entries(transaction_id);

-- ── MISSIONS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS missions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  titulo      VARCHAR(255) NOT NULL,
  descripcion TEXT,
  recompensa  INTEGER NOT NULL CHECK (recompensa > 0),
  dificultad  VARCHAR(10) NOT NULL CHECK (dificultad IN ('fácil','media','difícil')),
  activa      BOOLEAN DEFAULT true,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ── MISSION_SUBMISSIONS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS mission_submissions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  mission_id      UUID NOT NULL REFERENCES missions(id),
  student_id      UUID NOT NULL REFERENCES users(id),
  estado          VARCHAR(20) DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aprobada','rechazada')),
  submitted_at    TIMESTAMP DEFAULT NOW(),
  reviewed_at     TIMESTAMP,
  reviewed_by     UUID REFERENCES users(id),
  transaction_id  UUID REFERENCES transactions(id)
);

-- ── STORE_ITEMS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store_items (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre      VARCHAR(255) NOT NULL,
  descripcion TEXT,
  precio      INTEGER NOT NULL CHECK (precio > 0),
  stock       INTEGER DEFAULT -1,  -- -1 = ilimitado
  icon        VARCHAR(10),
  activo      BOOLEAN DEFAULT true,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ── TEACHER_BUDGETS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teacher_budgets (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  teacher_id    UUID NOT NULL REFERENCES users(id),
  monthly_limit INTEGER NOT NULL CHECK (monthly_limit > 0),
  current_spent INTEGER DEFAULT 0,
  month         DATE NOT NULL,  -- siempre el día 1 del mes: '2026-03-01'
  assigned_by   UUID REFERENCES users(id),
  created_at    TIMESTAMP DEFAULT NOW(),

  UNIQUE(teacher_id, month)
);

-- ── AUDIT_LOG ────────────────────────────────────────────────
-- Solo escritura. Nadie puede modificar este log.
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id    UUID REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,
  target_type VARCHAR(50),
  target_id   UUID,
  details     JSONB DEFAULT '{}',
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

-- ============================================================
-- DATOS INICIALES DEL SISTEMA
-- ============================================================

-- Cuentas del sistema (sin user_id — son del sistema, no de personas)
INSERT INTO accounts (id, user_id, account_type, label)
VALUES
  (uuid_generate_v4(), NULL, 'treasury', 'Tesorería del Sistema'),
  (uuid_generate_v4(), NULL, 'store',    'Tienda Escolar'),
  (uuid_generate_v4(), NULL, 'void',     'Cuenta Void')
ON CONFLICT DO NOTHING;

-- ============================================================
-- CÓMO CREAR EL PRIMER ADMIN (ejecutar manualmente):
-- ============================================================
-- Reemplazá TU_HASH con el resultado de bcrypt.hashSync('tu_password', 12)
--
-- INSERT INTO users (id, email, password_hash, nombre, rol)
-- VALUES (uuid_generate_v4(), 'admin@escuela.com', 'TU_HASH', 'Administrador', 'admin');
-- ============================================================
