// src/config/env.js
// Carga y valida las variables de entorno al arrancar el servidor.
// Si falta alguna variable crítica, el servidor no arranca.

require('dotenv').config();
const { normalizeJwtSecret } = require('./secrets');

const required = ['DATABASE_URL', 'JWT_SECRET'];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Variable de entorno faltante: ${key}`);
    console.error(`   Copiá .env.example a .env y completá los valores.`);
    process.exit(1);
  }
}

const nodeEnv = process.env.NODE_ENV || 'development';
const normalizedJwtSecret = normalizeJwtSecret(process.env.JWT_SECRET, nodeEnv);
if (nodeEnv === 'production' && process.env.JWT_SECRET.length < 32) {
  console.warn('⚠️ JWT_SECRET legado detectado: se usa una clave derivada segura. Rotá la variable a 32+ caracteres.');
}

module.exports = {
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET:   normalizedJwtSecret.value,
  PORT:         process.env.PORT || 3000,
  NODE_ENV:     nodeEnv,
  FRONTEND_URL: process.env.FRONTEND_URL || 'https://educoins-frontend.vercel.app',
  DB_SSL:       process.env.DB_SSL || 'auto',
};
