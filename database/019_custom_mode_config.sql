-- 019_custom_mode_config.sql
-- Agrega columna para guardar el modo de pantalla personalizado del alumno

ALTER TABLE user_custom_active 
  ADD COLUMN IF NOT EXISTS custom_mode_config JSONB DEFAULT NULL;
