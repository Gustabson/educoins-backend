const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { ensureApplicationSchema } = require('./application-schema');

async function runCoreMigrations() {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('educoins-core-migrations-v1'))");
    await ensureApplicationSchema(client);

    // Migración temporal solicitada: crear una cuenta de alumno accesible.
    const { rows: demoStudentRows } = await client.query(`
      INSERT INTO users (id, email, password_hash, nombre, rol, activo)
      VALUES ($1, 'alumno@educoins.demo', $2, 'Alumno Demo', 'student', TRUE)
      ON CONFLICT (email) DO UPDATE
        SET password_hash=EXCLUDED.password_hash,
            nombre=EXCLUDED.nombre,
            rol='student',
            activo=TRUE
      RETURNING id
    `, [uuidv4(), '$2a$12$Y3waxs/M2rlLeIyxdQ5CHO4nZT8VCYrM1PBADduqv1/vwWJdQ01RC']);
    await client.query(`
      INSERT INTO accounts (id, user_id, account_type, label)
      SELECT $1, $2, 'student', 'Cuenta de Alumno Demo'
      WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE user_id=$2)
    `, [uuidv4(), demoStudentRows[0].id]);

    await client.query(`
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_rol_check;
      -- Normalizar instalaciones antiguas que guardaban los roles en español.
      -- Se hace antes de volver a crear el CHECK para que el despliegue no falle
      -- aunque Railway todavía tenga datos de una versión previa.
      UPDATE users
         SET rol = CASE rol
           WHEN 'alumno' THEN 'student'
           WHEN 'maestra' THEN 'teacher'
           WHEN 'padre' THEN 'parent'
           ELSE rol
         END
       WHERE rol IN ('alumno','maestra','padre');
      ALTER TABLE users ADD CONSTRAINT users_rol_check
        CHECK (rol IN ('student','teacher','admin','parent','staff'));

      ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_account_type_check;
      UPDATE accounts
         SET account_type = CASE account_type
           WHEN 'alumno' THEN 'student'
           WHEN 'maestra' THEN 'teacher'
           WHEN 'padre' THEN 'parent'
           ELSE account_type
         END
       WHERE account_type IN ('alumno','maestra','padre');
      ALTER TABLE accounts ADD CONSTRAINT accounts_account_type_check
        CHECK (account_type IN ('student','teacher','parent','treasury','store','void','escrow'));

      ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
      ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
        CHECK (type IN (
          'mint','burn','reward','purchase','transfer','adjustment','tax',
          'escrow','escrow_return','p2p_release','p2p_resolve'
        ));

      ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_nonzero_amount;
      ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_nonzero_amount
        CHECK (amount <> 0) NOT VALID;

      ALTER TABLE store_items ADD COLUMN IF NOT EXISTS imagen_url TEXT;
      ALTER TABLE store_items ADD COLUMN IF NOT EXISTS mensaje_oculto TEXT;
      ALTER TABLE store_items ADD COLUMN IF NOT EXISTS published_by UUID REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS permisos TEXT[] DEFAULT '{}';
    `);

    await client.query(`
      DELETE FROM conversation_members cm
       USING conversations c, users u
       WHERE cm.conversation_id=c.id AND cm.user_id=u.id
         AND ((c.type='global_parents' AND u.rol<>'parent')
           OR (c.type='global' AND u.rol='parent'));

      DELETE FROM conversation_members cm
       USING conversations c
       WHERE cm.conversation_id=c.id
         AND c.type='classroom_parents'
         AND NOT EXISTS (
           SELECT 1
             FROM parent_student_links psl
             JOIN classroom_members student_membership
               ON student_membership.user_id=psl.student_id
              AND student_membership.rol='student'
            WHERE psl.parent_id=cm.user_id
              AND student_membership.classroom_id=c.classroom_id
         );

      DELETE FROM conversation_members cm
       USING conversations c
       WHERE cm.conversation_id=c.id
         AND c.type='classroom'
         AND NOT EXISTS (
           SELECT 1 FROM classroom_members classroom_membership
            WHERE classroom_membership.classroom_id=c.classroom_id
              AND classroom_membership.user_id=cm.user_id
         );

      DO $$
      BEGIN
        IF to_regclass('public.friendships') IS NOT NULL THEN
          UPDATE friendships
             SET removed_by_requester=TRUE, removed_by_addressee=TRUE
           WHERE removed_by_requester IS DISTINCT FROM removed_by_addressee;
        END IF;
      END $$
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION educoins_prevent_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'El ledger de EduCoins es inmutable; use una transacción de reversa'
          USING ERRCODE='55000';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_ledger_immutable ON ledger_entries;
      CREATE TRIGGER trg_ledger_immutable
        BEFORE UPDATE OR DELETE ON ledger_entries
        FOR EACH ROW EXECUTE FUNCTION educoins_prevent_ledger_mutation();

      CREATE OR REPLACE FUNCTION educoins_check_transaction_balance()
      RETURNS TRIGGER AS $$
      DECLARE
        transaction_type TEXT;
        transaction_sum BIGINT;
      BEGIN
        SELECT type INTO transaction_type FROM transactions WHERE id=NEW.transaction_id;
        IF transaction_type NOT IN ('mint','burn') THEN
          SELECT COALESCE(SUM(amount),0) INTO transaction_sum
            FROM ledger_entries WHERE transaction_id=NEW.transaction_id;
          IF transaction_sum <> 0 THEN
            RAISE EXCEPTION 'Transacción % desbalanceada: suma %', NEW.transaction_id, transaction_sum
              USING ERRCODE='23514';
          END IF;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_ledger_balanced ON ledger_entries;
      CREATE CONSTRAINT TRIGGER trg_ledger_balanced
        AFTER INSERT ON ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION educoins_check_transaction_balance();
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS store_reports (
        id          BIGSERIAL PRIMARY KEY,
        item_id     UUID NOT NULL REFERENCES store_items(id) ON DELETE CASCADE,
        reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason      TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 300),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(item_id, reporter_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tipo       VARCHAR(50) NOT NULL DEFAULT 'info',
        titulo     TEXT NOT NULL,
        cuerpo     TEXT,
        leida      BOOLEAN NOT NULL DEFAULT FALSE,
        data       JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ai_documents (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tipo       TEXT NOT NULL CHECK (tipo IN ('reglamento','institucional')),
        titulo     TEXT NOT NULL,
        contenido  TEXT NOT NULL DEFAULT '',
        activo     BOOLEAN NOT NULL DEFAULT TRUE,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS ai_queries (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
        modulo      TEXT NOT NULL,
        pregunta    TEXT NOT NULL,
        respuesta   TEXT,
        tokens_used INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
        escalado    BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS diwy_subscriptions (
        user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        plan          TEXT NOT NULL DEFAULT 'beta',
        active        BOOLEAN NOT NULL DEFAULT TRUE,
        activated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at    TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS diwy_class_preview (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        teacher_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        fecha       DATE NOT NULL DEFAULT CURRENT_DATE,
        tema        TEXT NOT NULL,
        detalle     TEXT,
        imagen      TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE diwy_class_preview ADD COLUMN IF NOT EXISTS imagen TEXT;
      ALTER TABLE diwy_class_preview DROP CONSTRAINT IF EXISTS diwy_class_preview_fecha_key;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_diwy_preview_teacher_date
        ON diwy_class_preview(teacher_id,fecha);

      UPDATE ai_documents
         SET activo=FALSE
       WHERE created_by IS NULL AND titulo LIKE '%(PRUEBA)%';
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS p2p_config (
        id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id=1),
        activo          BOOLEAN NOT NULL DEFAULT FALSE,
        min_amount      INTEGER NOT NULL DEFAULT 10 CHECK (min_amount > 0),
        max_amount      INTEGER NOT NULL DEFAULT 10000 CHECK (max_amount >= min_amount),
        order_timeout   INTEGER NOT NULL DEFAULT 30 CHECK (order_timeout BETWEEN 1 AND 1440),
        fee_percent     NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (fee_percent BETWEEN 0 AND 25),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE p2p_config ADD COLUMN IF NOT EXISTS order_timeout INTEGER NOT NULL DEFAULT 30;
      ALTER TABLE p2p_config ADD COLUMN IF NOT EXISTS fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS p2p_offers (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seller_id         UUID NOT NULL REFERENCES users(id),
        amount            INTEGER NOT NULL CHECK (amount >= 0),
        price_ars         NUMERIC(12,2) NOT NULL CHECK (price_ars > 0),
        min_order         INTEGER NOT NULL DEFAULT 1 CHECK (min_order > 0),
        max_order         INTEGER NOT NULL CHECK (max_order > 0),
        payment_methods   TEXT[] NOT NULL DEFAULT '{transferencia,efectivo}',
        instructions      TEXT,
        escrow_tx_id      UUID NOT NULL REFERENCES transactions(id),
        status            TEXT NOT NULL DEFAULT 'active',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS p2p_orders (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        offer_id              UUID NOT NULL REFERENCES p2p_offers(id),
        buyer_id              UUID NOT NULL REFERENCES users(id),
        seller_id             UUID NOT NULL REFERENCES users(id),
        amount                INTEGER NOT NULL CHECK (amount > 0),
        price_ars             NUMERIC(12,2) NOT NULL CHECK (price_ars > 0),
        total_ars             NUMERIC(14,2) NOT NULL CHECK (total_ars > 0),
        status                TEXT NOT NULL DEFAULT 'pending_payment',
        payment_deadline      TIMESTAMPTZ NOT NULL,
        comprobante_url       TEXT,
        dispute_reason        TEXT,
        dispute_resolved_by   UUID REFERENCES users(id),
        release_tx_id         UUID REFERENCES transactions(id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS p2p_ratings (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id    UUID NOT NULL REFERENCES p2p_orders(id) ON DELETE CASCADE,
        rater_id    UUID NOT NULL REFERENCES users(id),
        rated_id    UUID NOT NULL REFERENCES users(id),
        score       SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5),
        comment     TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(order_id,rater_id)
      );

      ALTER TABLE p2p_offers DROP CONSTRAINT IF EXISTS p2p_offers_status_check;
      ALTER TABLE p2p_offers ADD CONSTRAINT p2p_offers_status_check
        CHECK (status IN ('active','paused','completed','cancelled'));
      ALTER TABLE p2p_orders DROP CONSTRAINT IF EXISTS p2p_orders_status_check;
      ALTER TABLE p2p_orders ADD CONSTRAINT p2p_orders_status_check
        CHECK (status IN ('pending_payment','payment_sent','disputed','completed','refunded','expired'));
    `);

    // Instalaciones antiguas crearon este singleton con UUID; las nuevas usan
    // SMALLINT. DEFAULT VALUES respeta ambos esquemas sin convertir ni borrar.
    await client.query(`INSERT INTO p2p_config DEFAULT VALUES ON CONFLICT DO NOTHING`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tax_schedules (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount             INTEGER NOT NULL CHECK (amount > 0),
        reason             TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300),
        remaining_charges  INTEGER NOT NULL CHECK (remaining_charges >= 0),
        next_charge        TIMESTAMPTZ NOT NULL,
        active             BOOLEAN NOT NULL DEFAULT TRUE,
        created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const { rows: escrow } = await client.query(
      "SELECT id FROM accounts WHERE account_type='escrow' AND is_active=TRUE LIMIT 1"
    );
    if (!escrow.length) {
      await client.query(
        `INSERT INTO accounts (id,user_id,account_type,label,is_active)
         VALUES ($1,NULL,'escrow','Fondos en garantía P2P',TRUE)`,
        [uuidv4()]
      );
    }

    await client.query('CREATE INDEX IF NOT EXISTS idx_transactions_initiated_type ON transactions(initiated_by,type,created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_store_items_active_created ON store_items(activo,created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_store_items_publisher ON store_items(published_by,created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_p2p_offers_status_price ON p2p_offers(status,price_ars,created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_p2p_orders_parties ON p2p_orders(buyer_id,seller_id,created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_p2p_orders_expiry ON p2p_orders(payment_deadline) WHERE status=\'pending_payment\'');
    await client.query('CREATE INDEX IF NOT EXISTS idx_tax_schedules_due ON tax_schedules(next_charge) WHERE active=TRUE');
    await client.query('CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id,created_at DESC) WHERE leida=FALSE');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ai_queries_daily ON ai_queries(user_id,modulo,created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_ai_documents_active ON ai_documents(tipo,updated_at DESC) WHERE activo=TRUE');
    await client.query('CREATE INDEX IF NOT EXISTS idx_diwy_subscriptions_active ON diwy_subscriptions(active,expires_at)');

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { runCoreMigrations };
