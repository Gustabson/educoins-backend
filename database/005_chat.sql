-- ============================================================
-- 005_chat.sql
-- Modulo de Chat: aulas, amigos, conversaciones, mensajes
-- Ejecutar: \i C:/Users/GustavoS/Desktop/EEE/educoins-backend/database/005_chat.sql
-- ============================================================

-- ── AULAS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS classrooms (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      TEXT        NOT NULL CHECK (length(nombre) BETWEEN 2 AND 60),
  descripcion TEXT,
  activa      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS classroom_members (
  classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  rol          TEXT NOT NULL DEFAULT 'student' CHECK (rol IN ('student','teacher')),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (classroom_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_classroom_members_user ON classroom_members(user_id);

-- ── AMISTADES ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS friendships (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  estado       TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (estado IN ('pending','accepted','blocked')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (requester_id, addressee_id),
  CHECK (requester_id <> addressee_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id, estado);
CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id, estado);

-- ── CONVERSACIONES ───────────────────────────────────────────
-- type: 'personal' | 'classroom' | 'global'
-- Para personal: los dos user_ids van en conversation_members
-- Para classroom: conversation_id referencia el classroom
-- Para global: una sola conversacion para toda la escuela
CREATE TABLE IF NOT EXISTS conversations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT        NOT NULL CHECK (type IN ('personal','classroom','global')),
  classroom_id UUID        REFERENCES classrooms(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Solo puede haber una global
  CONSTRAINT one_global EXCLUDE USING btree (type WITH =) WHERE (type = 'global')
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  last_read_at    TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);

-- ── MENSAJES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID        REFERENCES users(id) ON DELETE SET NULL,
  texto           TEXT        NOT NULL CHECK (length(texto) BETWEEN 1 AND 1000),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at DESC);

-- ── DATOS INICIALES ──────────────────────────────────────────

-- Conversacion global (unica)
INSERT INTO conversations (type)
SELECT 'global'
WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE type = 'global');

-- Agregar todos los usuarios activos a la conversacion global
INSERT INTO conversation_members (conversation_id, user_id)
SELECT c.id, u.id
FROM conversations c, users u
WHERE c.type = 'global'
  AND u.activo = TRUE
ON CONFLICT DO NOTHING;

-- Aula de ejemplo
WITH new_class AS (
  INSERT INTO classrooms (nombre, descripcion, created_by)
  SELECT '3 B', 'Aula principal de ejemplo', id
  FROM users WHERE rol = 'admin' LIMIT 1
  RETURNING id
),
-- Agregar todos los alumnos al aula
ins_students AS (
  INSERT INTO classroom_members (classroom_id, user_id, rol)
  SELECT nc.id, u.id, 'student'
  FROM new_class nc, users u
  WHERE u.rol = 'student' AND u.activo = TRUE
  RETURNING classroom_id
),
-- Agregar todos los teachers al aula
ins_teachers AS (
  INSERT INTO classroom_members (classroom_id, user_id, rol)
  SELECT nc.id, u.id, 'teacher'
  FROM new_class nc, users u
  WHERE u.rol = 'teacher' AND u.activo = TRUE
  RETURNING classroom_id
),
-- Crear la conversacion del aula
new_conv AS (
  INSERT INTO conversations (type, classroom_id)
  SELECT 'classroom', nc.id FROM new_class nc
  RETURNING id, classroom_id
)
-- Agregar todos los miembros del aula a la conversacion
INSERT INTO conversation_members (conversation_id, user_id)
SELECT nconv.id, cm.user_id
FROM new_conv nconv
JOIN classroom_members cm ON cm.classroom_id = nconv.classroom_id
ON CONFLICT DO NOTHING;

-- Mensaje de bienvenida en el global
INSERT INTO messages (conversation_id, sender_id, texto)
SELECT
  c.id,
  (SELECT id FROM users WHERE rol = 'admin' LIMIT 1),
  'Bienvenidos al chat de Aubank! Este es el espacio de toda la escuela.'
FROM conversations c
WHERE c.type = 'global'
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id);

SELECT 'Migracion 005_chat completada' AS resultado;
