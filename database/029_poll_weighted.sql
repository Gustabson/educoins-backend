-- ============================================================
-- 029_poll_weighted.sql
-- Sistema DAO: poder de voto basado en monedas
-- ============================================================

-- Marca si una poll usa votación ponderada por monedas
ALTER TABLE polls
  ADD COLUMN IF NOT EXISTS weighted BOOLEAN NOT NULL DEFAULT FALSE;

-- Guarda el peso (balance del usuario en el momento de votar)
ALTER TABLE poll_votes
  ADD COLUMN IF NOT EXISTS peso NUMERIC NOT NULL DEFAULT 1;

SELECT '029_poll_weighted completada ✅' AS resultado;
