-- ============================================================
-- 004_social.sql
-- Módulos: Noticias (posts), Votaciones (polls), Reportes
-- Ejecutar en psql: \i database/004_social.sql
-- ============================================================

-- ── NOTICIAS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo      TEXT        NOT NULL CHECK (length(titulo) BETWEEN 3 AND 120),
  cuerpo      TEXT        NOT NULL CHECK (length(cuerpo) >= 10),
  autor_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag         TEXT        NOT NULL DEFAULT 'General'
                          CHECK (tag IN ('General','Académico','Deportes','Evento','Aviso')),
  activo      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_activo  ON posts(activo);

-- ── VOTACIONES ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS polls (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo      TEXT        NOT NULL CHECK (length(titulo) BETWEEN 5 AND 200),
  activa      BOOLEAN     NOT NULL DEFAULT TRUE,
  fin         DATE,                        -- fecha límite opcional
  created_by  UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS poll_options (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id     UUID        NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  texto       TEXT        NOT NULL CHECK (length(texto) BETWEEN 1 AND 120),
  orden       SMALLINT    NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_votes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id     UUID        NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  option_id   UUID        NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (poll_id, user_id)               -- un voto por encuesta por usuario
);

CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id, orden);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll   ON poll_votes(poll_id);

-- ── REPORTES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo         TEXT        NOT NULL
                           CHECK (tipo IN ('bullying','accidente','perdido','sugerencia','otro')),
  descripcion  TEXT        NOT NULL CHECK (length(descripcion) >= 10),
  reporter_id  UUID        REFERENCES users(id) ON DELETE SET NULL, -- NULL = anónimo
  estado       TEXT        NOT NULL DEFAULT 'recibido'
                           CHECK (estado IN ('recibido','en_revision','resuelto','descartado')),
  resolucion   TEXT,                       -- nota del admin al cerrar
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_estado    ON reports(estado);
CREATE INDEX IF NOT EXISTS idx_reports_created   ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_reporter  ON reports(reporter_id);

-- ── DATOS INICIALES DE EJEMPLO ───────────────────────────────
-- (se insertan solo si las tablas están vacías)

INSERT INTO posts (titulo, cuerpo, autor_id, tag)
SELECT
  'Bienvenidos al nuevo sistema Aubank',
  'A partir de hoy el sistema de economía escolar digital está disponible para todos los alumnos. Podés ganar monedas completando misiones, canjear premios en la tienda y mucho más.',
  (SELECT id FROM users WHERE rol = 'admin' LIMIT 1),
  'Aviso'
WHERE NOT EXISTS (SELECT 1 FROM posts LIMIT 1);

INSERT INTO posts (titulo, cuerpo, autor_id, tag)
SELECT
  '🏆 Torneo Interescolar este viernes',
  'Este viernes a las 14hs se realizará el torneo de fútbol interescolar en el patio principal. ¡Vamos a alentar al equipo! La entrada es libre y gratuita para toda la comunidad educativa.',
  (SELECT id FROM users WHERE rol = 'admin' LIMIT 1),
  'Deportes'
WHERE (SELECT COUNT(*) FROM posts) < 2;

INSERT INTO posts (titulo, cuerpo, autor_id, tag)
SELECT
  '📚 Cronograma de exámenes parciales',
  'La semana del 18 al 22 de marzo se realizarán los exámenes parciales del primer trimestre. Recordá revisar el cronograma publicado en el panel de la dirección y consultar cualquier duda con tu docente.',
  (SELECT id FROM users WHERE rol = 'teacher' LIMIT 1),
  'Académico'
WHERE (SELECT COUNT(*) FROM posts) < 3;

-- Votación de ejemplo
WITH new_poll AS (
  INSERT INTO polls (titulo, activa, fin, created_by)
  SELECT
    '¿Qué actividad preferís para el día del estudiante?',
    TRUE,
    CURRENT_DATE + INTERVAL '14 days',
    (SELECT id FROM users WHERE rol = 'admin' LIMIT 1)
  WHERE NOT EXISTS (SELECT 1 FROM polls LIMIT 1)
  RETURNING id
)
INSERT INTO poll_options (poll_id, texto, orden)
SELECT new_poll.id, opcion, orden
FROM new_poll,
  (VALUES ('Picnic en el parque', 0),
          ('Salida al cine', 1),
          ('Fiesta en la escuela', 2),
          ('Competencia de juegos', 3)) AS opciones(opcion, orden);

SELECT 'Migración 004_social completada ✅' AS resultado;
