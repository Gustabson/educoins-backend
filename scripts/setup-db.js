const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const db = require('../src/config/db');
const { runCoreMigrations } = require('../src/config/migrations');

async function main() {
  const baseSchema = readFileSync(join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
  await db.query(baseSchema);
  await runCoreMigrations();
  console.log('Base de datos EduCoins preparada correctamente.');
}

main()
  .catch(error => {
    console.error('No se pudo preparar la base de datos:', error.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
