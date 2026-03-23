-- Items prestados por el admin (marcos, fondos, etc.) con expiración opcional
CREATE TABLE IF NOT EXISTS loaned_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(30) NOT NULL,  -- 'avatar_bg', 'border', etc.
  item_data   JSONB NOT NULL,        -- el item completo { name, type, value, glow, ... }
  note        TEXT,
  expires_at  TIMESTAMPTZ DEFAULT NULL,  -- NULL = sin vencimiento
  granted_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  active      BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_loaned_user ON loaned_items(user_id, active);
