// src/config/db.js
// Pool de conexiones a PostgreSQL.
// Un "pool" reutiliza conexiones abiertas en lugar de abrir una nueva
// por cada request — es más eficiente y rápido.

const { Pool } = require('pg');
const { DATABASE_URL, NODE_ENV, DB_SSL } = require('./env');

let databaseHost = '';
try { databaseHost = new URL(DATABASE_URL).hostname; } catch { /* Pool reportará la URL inválida */ }
const isLocalDatabase = ['localhost', '127.0.0.1', '::1'].includes(databaseHost);
const useSsl = DB_SSL === 'true' ||
  (DB_SSL === 'auto' && NODE_ENV === 'production' && !isLocalDatabase);

const pool = new Pool({
  connectionString: DATABASE_URL,
  // En producción, PostgreSQL puede requerir SSL
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

// Función helper para ejecutar queries
// Uso: await db.query('SELECT * FROM users WHERE id = $1', [id])
const db = {
  query: (text, params) => pool.query(text, params),

  // Para transacciones atómicas (todo o nada)
  // Uso: const client = await db.getClient()
  //      await client.query('BEGIN')
  //      ... múltiples queries ...
  //      await client.query('COMMIT')
  //      client.release()
  getClient: () => pool.connect(),
  close: () => pool.end(),
};

module.exports = db;
