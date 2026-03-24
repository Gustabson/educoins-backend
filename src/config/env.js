// src/config/env.js
// Carga y valida las variables de entorno al arrancar el servidor.
// Si falta alguna variable crítica, el servidor no arranca.

require('dotenv').config();

const required = ['DATABASE_URL', 'JWT_SECRET'];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`❌ Variable de entorno faltante: ${key}`);
    console.error(`   Copiá .env.example a .env y completá los valores.`);
    process.exit(1);
  }
}

module.exports = {
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_SECRET:   process.env.JWT_SECRET,
  PORT:         process.env.PORT || 3000,
  NODE_ENV:     process.env.NODE_ENV || 'development',
};
