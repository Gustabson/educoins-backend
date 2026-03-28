-- ============================================================
-- 032_quorum.sql
-- Configuración de quórum para votaciones DAO
-- ============================================================

CREATE TABLE IF NOT EXISTS quorum_settings (
  scope       VARCHAR(10)   NOT NULL PRIMARY KEY,
  threshold   NUMERIC(5,2)  NOT NULL DEFAULT 50,
  mode        VARCHAR(10)   NOT NULL DEFAULT 'people',
  updated_by  UUID          REFERENCES users(id),
  updated_at  TIMESTAMP     NOT NULL DEFAULT NOW(),
  CONSTRAINT  qs_scope_chk  CHECK (scope IN ('aula','global')),
  CONSTRAINT  qs_mode_chk   CHECK (mode  IN ('people','coins')),
  CONSTRAINT  qs_thresh_chk CHECK (threshold > 0 AND threshold <= 100)
);

-- Valores por defecto: aula 50% personas, global 50% monedas
INSERT INTO quorum_settings (scope, threshold, mode) VALUES
  ('aula',   50, 'people'),
  ('global', 50, 'coins')
ON CONFLICT DO NOTHING;

SELECT '032_quorum completada ✅' AS resultado;
