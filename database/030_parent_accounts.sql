-- ============================================================
-- 030_parent_accounts.sql
-- Cuentas de padres y vínculos padre-alumno
-- ============================================================

-- Agregar 'parent' al tipo de cuenta permitido
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_account_type_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_account_type_check
  CHECK (account_type IN (
    'student','teacher','treasury','store','void','checking','wallet','parent'
  ));

-- Tabla de vínculos padre-alumno
CREATE TABLE IF NOT EXISTS parent_student_links (
  id         UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  UUID      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id UUID      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(parent_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_psl_parent  ON parent_student_links(parent_id);
CREATE INDEX IF NOT EXISTS idx_psl_student ON parent_student_links(student_id);

SELECT '030_parent_accounts completada ✅' AS resultado;
