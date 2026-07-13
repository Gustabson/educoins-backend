# EduCoins Backend

API Node.js/Express y Socket.io para la economía escolar EduCoins. PostgreSQL y el ledger de doble entrada son la fuente de verdad de todos los saldos.

## Desarrollo

Requiere Node.js 20.19+, PostgreSQL 15+ y una base creada.

```bash
npm ci
cp .env.example .env
npm run db:setup
npm start
```

Al iniciar, el servidor ejecuta migraciones idempotentes antes de escuchar conexiones. `/health` verifica realmente PostgreSQL y responde 503 si la base no está disponible.

## Variables

```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/educoins
DB_SSL=auto
JWT_SECRET=reemplazar-por-un-secreto-largo-y-aleatorio
BACKUP_KEY=otro-secreto-estable-para-los-backups-de-bienestar
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
PORT=3000
NODE_ENV=development
FRONTEND_URL=http://localhost:3001
```

En producción `JWT_SECRET` debe tener al menos 32 caracteres.
`BACKUP_KEY` debe conservarse aunque se rote el JWT; la descarga mantiene compatibilidad con backups históricos cifrados con el secreto anterior.
`OPENAI_MODEL` permite actualizar el modelo sin modificar código; el valor predeterminado prioriza costo y velocidad para el asistente escolar.

## Verificación

```bash
npm run check
npm test
npm audit
```

## Reglas económicas

- Los saldos se calculan exclusivamente desde `ledger_entries`.
- Todo débito bloquea las cuentas participantes antes de comprobar saldo, evitando doble gasto concurrente.
- Las garantías P2P usan una cuenta `escrow` separada de Tesorería.
- Los impuestos diarios y vencimientos P2P se procesan de forma idempotente en segundo plano.
- Nunca se editan o eliminan entradas históricas del ledger; una reversa crea otra transacción compensatoria.

Railway despliega automáticamente cada push a `main`.
