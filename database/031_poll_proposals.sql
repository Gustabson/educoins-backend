-- ============================================================
-- 031_poll_proposals.sql
-- Sistema DAO abierto: propuestas de todos, pre-aprobación admin
-- ============================================================

-- Estado del ciclo de vida de cada propuesta/poll
ALTER TABLE polls
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';

ALTER TABLE polls
  DROP CONSTRAINT IF EXISTS polls_status_check;

ALTER TABLE polls
  ADD CONSTRAINT polls_status_check
  CHECK (status IN ('pending', 'active', 'rejected'));

-- Contexto / descripción del problema (obligatorio para alumnos/padres)
ALTER TABLE polls
  ADD COLUMN IF NOT EXISTS contexto TEXT;

-- Nota de revisión (motivo de rechazo o condición de aprobación)
ALTER TABLE polls
  ADD COLUMN IF NOT EXISTS review_note TEXT;

-- Quién revisó la propuesta
ALTER TABLE polls
  ADD COLUMN IF NOT EXISTS review_by UUID REFERENCES users(id);

-- Todas las polls existentes se marcan como activas
UPDATE polls SET status = 'active' WHERE status IS NULL OR status = '' OR status = 'active';

SELECT '031_poll_proposals completada ✅' AS resultado;
