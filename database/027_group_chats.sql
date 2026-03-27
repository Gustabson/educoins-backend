-- ============================================================
-- 027_group_chats.sql
-- Soporte para conversaciones grupales
-- ============================================================

-- 1. Agregar tipo 'group' al check constraint de conversations
DO $$
DECLARE cname TEXT;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'conversations'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%type%';
  IF cname IS NOT NULL THEN
    EXECUTE 'ALTER TABLE conversations DROP CONSTRAINT ' || quote_ident(cname);
  END IF;
END $$;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_type_check
  CHECK (type IN ('personal','classroom','global','group'));

-- 2. Columnas de metadata para grupos
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS nombre     TEXT,
  ADD COLUMN IF NOT EXISTS icono      TEXT DEFAULT '👥',
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- 3. Rol dentro de una conversacion (dueño vs miembro)
ALTER TABLE conversation_members
  ADD COLUMN IF NOT EXISTS rol TEXT NOT NULL DEFAULT 'member'
  CHECK (rol IN ('owner','member'));

SELECT '027_group_chats completada ✅' AS resultado;
