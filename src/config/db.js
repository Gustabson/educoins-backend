// src/config/db.js
// Pool de conexiones a PostgreSQL.
// Un "pool" reutiliza conexiones abiertas en lugar de abrir una nueva
// por cada request — es más eficiente y rápido.

const { Pool } = require('pg');
const { DATABASE_URL, NODE_ENV } = require('./env');

const pool = new Pool({
  connectionString: DATABASE_URL,
  // En producción, PostgreSQL puede requerir SSL
  ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Verificar conexión al arrancar
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
    console.error('   Verificá que PostgreSQL esté corriendo y que DATABASE_URL sea correcta.');
    process.exit(1);
  }
  release();
  console.log('✅ Conectado a PostgreSQL');
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
};

module.exports = db;
