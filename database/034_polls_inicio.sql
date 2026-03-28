-- ============================================================
-- 034_polls_inicio.sql
-- Campo inicio: momento en que comienza la votación y se toma snapshot
-- ============================================================

ALTER TABLE polls ADD COLUMN IF NOT EXISTS inicio TIMESTAMPTZ;

-- Polls existentes: inicio = created_at (ya empezaron)
UPDATE polls SET inicio = created_at WHERE inicio IS NULL;

SELECT '034_polls_inicio completada ✅' AS resultado;
