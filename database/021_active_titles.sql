-- Agregar columna active_titles para múltiples títulos activos
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_titles JSONB DEFAULT '[]'::jsonb;

-- Migrar datos existentes: title y titulo_custom → active_titles
UPDATE users SET active_titles = (
  CASE 
    WHEN title IS NOT NULL AND title != 'tl1' AND titulo_custom IS NOT NULL
      THEN jsonb_build_array(title, 'custom:' || titulo_custom)
    WHEN title IS NOT NULL AND title != 'tl1'
      THEN jsonb_build_array(title)
    WHEN titulo_custom IS NOT NULL
      THEN jsonb_build_array('custom:' || titulo_custom)
    ELSE '[]'::jsonb
  END
)
WHERE active_titles = '[]'::jsonb;
