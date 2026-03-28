-- ============================================================
-- 033_polls_features.sql
-- Autónomo: agrega columnas de migraciones previas si faltan
-- + poll_number, snapshot, status aprobado, approved_at/by
-- ============================================================

-- ── De migración 029 (weighted) ──────────────────────────────
ALTER TABLE polls ADD COLUMN IF NOT EXISTS weighted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE poll_votes ADD COLUMN IF NOT EXISTS peso NUMERIC NOT NULL DEFAULT 1;

-- ── De migración 031 (proposals) ─────────────────────────────
ALTER TABLE polls ADD COLUMN IF NOT EXISTS scope       VARCHAR(20) NOT NULL DEFAULT 'global';
ALTER TABLE polls ADD COLUMN IF NOT EXISTS classroom_id UUID REFERENCES classrooms(id) ON DELETE SET NULL;
ALTER TABLE polls ADD COLUMN IF NOT EXISTS contexto    TEXT;
ALTER TABLE polls ADD COLUMN IF NOT EXISTS review_note TEXT;
ALTER TABLE polls ADD COLUMN IF NOT EXISTS review_by   UUID REFERENCES users(id);
ALTER TABLE polls ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';

-- ── De migración 032 (quorum) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS quorum_settings (
  id        SERIAL PRIMARY KEY,
  scope     VARCHAR(20) NOT NULL UNIQUE,
  threshold NUMERIC     NOT NULL DEFAULT 50,
  mode      VARCHAR(20) NOT NULL DEFAULT 'people'
);
INSERT INTO quorum_settings (scope, threshold, mode)
  VALUES ('global', 50, 'coins'), ('aula', 50, 'people')
  ON CONFLICT (scope) DO NOTHING;

-- ── Nuevas columnas 033 ───────────────────────────────────────
-- Número secuencial de display para cada votación (#1, #2, ...)
ALTER TABLE polls ADD COLUMN IF NOT EXISTS poll_number SERIAL;

-- Snapshot del estado de la economía al crear la votación
ALTER TABLE polls ADD COLUMN IF NOT EXISTS snapshot_total_coins NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE polls ADD COLUMN IF NOT EXISTS snapshot_total_voters INT     NOT NULL DEFAULT 0;

-- Agregar status 'approved' a la constraint
ALTER TABLE polls DROP CONSTRAINT IF EXISTS polls_status_check;
ALTER TABLE polls ADD CONSTRAINT polls_status_check
  CHECK (status IN ('pending', 'active', 'rejected', 'approved'));

-- Auditoría de aprobación oficial
ALTER TABLE polls ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE polls ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id);

-- Reactions y comentarios de polls (si no existen de migración 004)
CREATE TABLE IF NOT EXISTS poll_reactions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id    UUID        NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipo       VARCHAR(10) NOT NULL,
  UNIQUE(poll_id, user_id)
);
CREATE TABLE IF NOT EXISTS poll_comments (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id    UUID        NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  UUID        REFERENCES poll_comments(id) ON DELETE CASCADE,
  texto      TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS poll_comment_reactions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id UUID        NOT NULL REFERENCES poll_comments(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipo       VARCHAR(10) NOT NULL,
  UNIQUE(comment_id, user_id)
);

SELECT '033_polls_features completada ✅' AS resultado;
