-- Agregar columna estado a users
ALTER TABLE users ADD COLUMN IF NOT EXISTS estado VARCHAR(40) DEFAULT NULL;
