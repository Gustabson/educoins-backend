-- ============================================================
-- 028_group_invites.sql
-- Control de invitaciones en grupos
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS allow_invites BOOLEAN NOT NULL DEFAULT TRUE;

SELECT '028_group_invites completada ✅' AS resultado;
