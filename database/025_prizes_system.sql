-- Sistema de premios configurables
-- Cada "prize_set" es un conjunto de premios para un puesto del ranking
CREATE TABLE IF NOT EXISTS ranking_prize_sets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  periodo       VARCHAR(10) NOT NULL CHECK (periodo IN ('daily','weekly','monthly')),
  puesto        INTEGER NOT NULL CHECK (puesto >= 1 AND puesto <= 20),
  activo        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (periodo, puesto)
);

-- Ítems dentro de cada prize_set
CREATE TABLE IF NOT EXISTS ranking_prize_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prize_set_id  UUID NOT NULL REFERENCES ranking_prize_sets(id) ON DELETE CASCADE,
  tipo          VARCHAR(30) NOT NULL,
  -- tipos: 'monedas' | 'titulo' | 'borde' | 'skin' | 'marco' | 'name_color' | 'custom_unlock'
  valor         JSONB NOT NULL DEFAULT '{}',
  -- monedas: {cantidad: 100}
  -- titulo: {name, rarity, color, glow_color, emoji, expires_days}
  -- borde: {item_id: 'b2', expires_days: 30}
  -- skin: {item_id: 's2', expires_days: null}
  -- marco: {name, type, value, glow, expires_days}
  -- name_color: {item_id: uuid, expires_days: 30}
  -- custom_unlock: {tipo: 'nickname', expires_days: 30}
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Historial de premios entregados
CREATE TABLE IF NOT EXISTS ranking_prizes_granted (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prize_set_id  UUID REFERENCES ranking_prize_sets(id),
  periodo       VARCHAR(10) NOT NULL,
  puesto        INTEGER NOT NULL,
  premio_data   JSONB NOT NULL,  -- snapshot de lo que se entregó
  granted_at    TIMESTAMPTZ DEFAULT NOW(),
  granted_by    VARCHAR(20) DEFAULT 'system'  -- 'system' | admin_id
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_prize_sets_periodo ON ranking_prize_sets(periodo, activo);
CREATE INDEX IF NOT EXISTS idx_prizes_granted_user ON ranking_prizes_granted(user_id);

-- Seeds iniciales: premios por defecto
INSERT INTO ranking_prize_sets (periodo, puesto) VALUES
  ('weekly',1), ('weekly',2), ('weekly',3),
  ('monthly',1), ('monthly',2), ('monthly',3)
ON CONFLICT DO NOTHING;

-- Aumentar límite de active_titles a 5 con orden
-- active_titles sigue siendo JSONB array, el frontend controla el max
-- earned_titles: agregar expires_at para títulos temporales
ALTER TABLE earned_titles ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;
