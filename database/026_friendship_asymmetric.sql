-- ============================================================
-- 026_friendship_asymmetric.sql
-- Soporte para borrado asimétrico de amistades
-- Cada parte puede "eliminar" al otro sin afectar al resto
-- ============================================================

ALTER TABLE friendships
  ADD COLUMN IF NOT EXISTS removed_by_requester BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS removed_by_addressee BOOLEAN NOT NULL DEFAULT FALSE;

SELECT '026_friendship_asymmetric completada ✅' AS resultado;
