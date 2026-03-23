-- Tabla de títulos obtenidos (otorgados por admin)
CREATE TABLE IF NOT EXISTS earned_titles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          VARCHAR(40) NOT NULL,
  rarity        VARCHAR(20) NOT NULL DEFAULT 'common', -- common|rare|epic|legendary
  color         VARCHAR(20) DEFAULT '#ffffff',
  glow_color    VARCHAR(20) DEFAULT NULL,
  emoji         VARCHAR(10) DEFAULT NULL,
  note          TEXT DEFAULT NULL,  -- motivo del otorgamiento
  granted_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_earned_titles_user ON earned_titles(user_id);

-- Columna para fondo del avatar
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_bg JSONB DEFAULT NULL;
-- Ejemplo: {"type":"solid","value":"#ff0000"} 
--          {"type":"gradient","value":"linear-gradient(135deg,#f59e0b,#ef4444)"}
--          {"type":"frame","value":"gold","css":"3px solid #f59e0b"}
