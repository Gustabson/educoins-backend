// Esquema idempotente de los módulos que históricamente se creaban a mano.
// No contiene datos de demostración: solo estructura y valores operativos seguros.

async function ensureApplicationSchema(client) {
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    ALTER TABLE users ADD COLUMN IF NOT EXISTS apodo VARCHAR(40);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS foto_url TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS titulo_custom VARCHAR(100);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS estado VARCHAR(40);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_bg JSONB;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS active_titles JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS unlocked_avatar_bgs TEXT[] DEFAULT ARRAY['ab0'];
    ALTER TABLE users ADD COLUMN IF NOT EXISTS permisos TEXT[] DEFAULT '{}';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_prefs JSONB DEFAULT '{}'::jsonb;

    ALTER TABLE missions ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'normal';
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS fecha_fin TIMESTAMPTZ;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS max_submissions INTEGER;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS classroom_id UUID;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS prerequisite_id UUID;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS xp_bonus INTEGER DEFAULT 0;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS imagen_url TEXT;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT '⚡';
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS auto_approve BOOLEAN DEFAULT FALSE;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS reward_type TEXT DEFAULT 'monedas';
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS reward_extra JSONB;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS fecha_inicio TIMESTAMPTZ;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS grupo_min_size INTEGER DEFAULT 2;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS grupo_max_size INTEGER DEFAULT 2;
    ALTER TABLE missions ADD COLUMN IF NOT EXISTS requires_peer_eval BOOLEAN DEFAULT FALSE;
    ALTER TABLE mission_submissions ADD COLUMN IF NOT EXISTS feedback TEXT;
    ALTER TABLE mission_submissions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS classrooms (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      nombre TEXT NOT NULL,
      descripcion TEXT,
      activa BOOLEAN NOT NULL DEFAULT TRUE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS classroom_members (
      classroom_id UUID NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rol TEXT NOT NULL DEFAULT 'student' CHECK (rol IN ('student','teacher')),
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (classroom_id,user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_classroom_members_user ON classroom_members(user_id);

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='missions_classroom_id_fkey') THEN
        ALTER TABLE missions ADD CONSTRAINT missions_classroom_id_fkey
          FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='missions_prerequisite_id_fkey') THEN
        ALTER TABLE missions ADD CONSTRAINT missions_prerequisite_id_fkey
          FOREIGN KEY (prerequisite_id) REFERENCES missions(id) ON DELETE SET NULL;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS friendships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      requester_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      addressee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      estado TEXT NOT NULL DEFAULT 'pending' CHECK (estado IN ('pending','accepted','blocked')),
      removed_by_requester BOOLEAN NOT NULL DEFAULT FALSE,
      removed_by_addressee BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(requester_id,addressee_id),
      CHECK(requester_id <> addressee_id)
    );
    ALTER TABLE friendships ADD COLUMN IF NOT EXISTS removed_by_requester BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE friendships ADD COLUMN IF NOT EXISTS removed_by_addressee BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id,estado);
    CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id,estado);

    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      type TEXT NOT NULL,
      classroom_id UUID REFERENCES classrooms(id) ON DELETE CASCADE,
      nombre TEXT,
      icono TEXT DEFAULT '👥',
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      allow_invites BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS nombre TEXT;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS icono TEXT DEFAULT '👥';
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS allow_invites BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rol TEXT NOT NULL DEFAULT 'member',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(conversation_id,user_id)
    );
    ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS rol TEXT NOT NULL DEFAULT 'member';
    ALTER TABLE conversation_members ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      texto TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id,created_at DESC);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      titulo TEXT NOT NULL,
      cuerpo TEXT NOT NULL,
      autor_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tag TEXT NOT NULL DEFAULT 'General',
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_activo ON posts(activo);

    CREATE TABLE IF NOT EXISTS polls (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      titulo TEXT NOT NULL,
      activa BOOLEAN NOT NULL DEFAULT TRUE,
      inicio TIMESTAMPTZ,
      fin DATE,
      created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      weighted BOOLEAN NOT NULL DEFAULT FALSE,
      scope VARCHAR(20) NOT NULL DEFAULT 'global',
      classroom_id UUID REFERENCES classrooms(id) ON DELETE SET NULL,
      contexto TEXT,
      review_note TEXT,
      review_by UUID REFERENCES users(id),
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      poll_number SERIAL,
      snapshot_total_coins NUMERIC NOT NULL DEFAULT 0,
      snapshot_total_voters INTEGER NOT NULL DEFAULT 0,
      approved_at TIMESTAMPTZ,
      approved_by UUID REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE polls ADD COLUMN IF NOT EXISTS weighted BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE polls ADD COLUMN IF NOT EXISTS scope VARCHAR(20) NOT NULL DEFAULT 'global';
    ALTER TABLE polls ADD COLUMN IF NOT EXISTS classroom_id UUID REFERENCES classrooms(id) ON DELETE SET NULL;
    ALTER TABLE polls ADD COLUMN IF NOT EXISTS contexto TEXT;
    ALTER TABLE polls ADD COLUMN IF NOT EXISTS review_note TEXT;
    ALTER TABLE polls ADD COLUMN IF NOT EXISTS review_by UUID REFERENCES users(id);
    ALTER TABLE polls ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';
    ALTER TABLE polls ADD COLUMN IF NOT EXISTS poll_number SERIAL;
    ALTER TABLE polls ADD COLUMN IF NOT EXISTS snapshot_total_coins NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE polls ADD COLUMN IF NOT EXISTS snapshot_total_voters INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE polls ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
    ALTER TABLE polls ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id);
    ALTER TABLE polls ADD COLUMN IF NOT EXISTS inicio TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS poll_options (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      texto TEXT NOT NULL,
      orden SMALLINT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS poll_votes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      option_id UUID NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      peso NUMERIC NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(poll_id,user_id)
    );
    ALTER TABLE poll_votes ADD COLUMN IF NOT EXISTS peso NUMERIC NOT NULL DEFAULT 1;
    CREATE TABLE IF NOT EXISTS poll_reactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tipo VARCHAR(10) NOT NULL,
      UNIQUE(poll_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS poll_comments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      poll_id UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id UUID REFERENCES poll_comments(id) ON DELETE CASCADE,
      texto TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS poll_comment_reactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      comment_id UUID NOT NULL REFERENCES poll_comments(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tipo VARCHAR(10) NOT NULL,
      UNIQUE(comment_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS quorum_settings (
      id SERIAL PRIMARY KEY,
      scope VARCHAR(20) NOT NULL UNIQUE,
      threshold NUMERIC NOT NULL DEFAULT 50,
      mode VARCHAR(20) NOT NULL DEFAULT 'people'
    );
    INSERT INTO quorum_settings(scope,threshold,mode)
      VALUES ('global',50,'coins'),('aula',50,'people')
      ON CONFLICT(scope) DO NOTHING;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tipo TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      reporter_id UUID REFERENCES users(id) ON DELETE SET NULL,
      estado TEXT NOT NULL DEFAULT 'recibido',
      resolucion TEXT,
      grupo TEXT,
      adjuntos JSONB NOT NULL DEFAULT '[]'::jsonb,
      compartido_con TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS grupo TEXT;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS adjuntos JSONB DEFAULT '[]'::jsonb;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS compartido_con TEXT[] DEFAULT ARRAY[]::text[];
    CREATE TABLE IF NOT EXISTS report_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      texto TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_report_messages_report ON report_messages(report_id,created_at);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id,endpoint)
    );
    CREATE TABLE IF NOT EXISTS user_blocks (
      blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(blocker_id,blocked_id),
      CHECK(blocker_id <> blocked_id)
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS shop_items_custom (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tipo TEXT NOT NULL,
      nombre TEXT NOT NULL,
      descripcion TEXT,
      precio INTEGER NOT NULL DEFAULT 0 CHECK(precio >= 0),
      config JSONB NOT NULL DEFAULT '{}',
      preview TEXT,
      orden INTEGER NOT NULL DEFAULT 0,
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      es_suscripcion BOOLEAN NOT NULL DEFAULT FALSE,
      periodo_default TEXT,
      precio_semanal INTEGER CHECK(precio_semanal >= 0),
      precio_mensual INTEGER CHECK(precio_mensual >= 0),
      precio_anual INTEGER CHECK(precio_anual >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_custom_items (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id UUID NOT NULL REFERENCES shop_items_custom(id) ON DELETE CASCADE,
      purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id,item_id)
    );
    CREATE TABLE IF NOT EXISTS user_custom_active (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme_id UUID REFERENCES shop_items_custom(id) ON DELETE SET NULL,
      name_color_id UUID REFERENCES shop_items_custom(id) ON DELETE SET NULL,
      emoji_pack_id UUID REFERENCES shop_items_custom(id) ON DELETE SET NULL,
      title_effect_id UUID REFERENCES shop_items_custom(id) ON DELETE SET NULL,
      name_effect_id UUID REFERENCES shop_items_custom(id) ON DELETE SET NULL,
      avatar_frame_id UUID REFERENCES shop_items_custom(id) ON DELETE SET NULL,
      screen_mode_id UUID REFERENCES shop_items_custom(id) ON DELETE SET NULL,
      text_style_id UUID REFERENCES shop_items_custom(id) ON DELETE SET NULL,
      custom_bg_color TEXT,
      custom_accent_color TEXT,
      custom_txt_color TEXT,
      custom_sub_color TEXT,
      custom_card_color TEXT,
      custom_mode_config JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE user_custom_active ADD COLUMN IF NOT EXISTS screen_mode_id UUID REFERENCES shop_items_custom(id) ON DELETE SET NULL;
    ALTER TABLE user_custom_active ADD COLUMN IF NOT EXISTS text_style_id UUID REFERENCES shop_items_custom(id) ON DELETE SET NULL;
    ALTER TABLE user_custom_active ADD COLUMN IF NOT EXISTS custom_bg_color TEXT;
    ALTER TABLE user_custom_active ADD COLUMN IF NOT EXISTS custom_accent_color TEXT;
    ALTER TABLE user_custom_active ADD COLUMN IF NOT EXISTS custom_txt_color TEXT;
    ALTER TABLE user_custom_active ADD COLUMN IF NOT EXISTS custom_sub_color TEXT;
    ALTER TABLE user_custom_active ADD COLUMN IF NOT EXISTS custom_card_color TEXT;
    ALTER TABLE user_custom_active ADD COLUMN IF NOT EXISTS custom_mode_config JSONB;
    CREATE TABLE IF NOT EXISTS gifts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id UUID REFERENCES shop_items_custom(id) ON DELETE SET NULL,
      coins INTEGER NOT NULL DEFAULT 0 CHECK(coins >= 0),
      mensaje TEXT,
      leido BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id UUID NOT NULL REFERENCES shop_items_custom(id) ON DELETE CASCADE,
      periodo TEXT NOT NULL CHECK(periodo IN ('weekly','monthly','annual')),
      precio INTEGER NOT NULL CHECK(precio >= 0),
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      next_charge TIMESTAMPTZ NOT NULL,
      last_charge TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id,item_id)
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS checkin_config (
      id SMALLSERIAL PRIMARY KEY,
      base_reward INTEGER NOT NULL DEFAULT 5 CHECK(base_reward >= 0),
      bonus_3days INTEGER NOT NULL DEFAULT 10 CHECK(bonus_3days >= 0),
      bonus_7days INTEGER NOT NULL DEFAULT 25 CHECK(bonus_7days >= 0),
      bonus_30days INTEGER NOT NULL DEFAULT 100 CHECK(bonus_30days >= 0),
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO checkin_config(base_reward,bonus_3days,bonus_7days,bonus_30days)
      SELECT 5,10,25,100 WHERE NOT EXISTS (SELECT 1 FROM checkin_config);
    CREATE TABLE IF NOT EXISTS daily_checkins (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fecha DATE NOT NULL,
      racha INTEGER NOT NULL DEFAULT 1 CHECK(racha > 0),
      recompensa INTEGER NOT NULL DEFAULT 0 CHECK(recompensa >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id,fecha)
    );

    CREATE TABLE IF NOT EXISTS economy_config (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      categoria TEXT NOT NULL,
      item_key TEXT NOT NULL,
      precio INTEGER NOT NULL DEFAULT 0 CHECK(precio >= 0),
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      descripcion TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(categoria,item_key)
    );
    CREATE TABLE IF NOT EXISTS ranking_config (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      periodo TEXT NOT NULL CHECK(periodo IN ('daily','weekly','monthly')),
      scope TEXT NOT NULL CHECK(scope IN ('global','aula')),
      posicion INTEGER NOT NULL CHECK(posicion > 0),
      premio INTEGER NOT NULL DEFAULT 0 CHECK(premio >= 0),
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(periodo,scope,posicion)
    );
    CREATE TABLE IF NOT EXISTS ranking_payouts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      periodo TEXT NOT NULL,
      scope TEXT NOT NULL,
      periodo_label TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id),
      classroom_id UUID REFERENCES classrooms(id) ON DELETE SET NULL,
      posicion INTEGER NOT NULL,
      premio INTEGER NOT NULL CHECK(premio > 0),
      transaction_id UUID NOT NULL REFERENCES transactions(id),
      revertida BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE ranking_payouts ADD COLUMN IF NOT EXISTS classroom_id UUID REFERENCES classrooms(id) ON DELETE SET NULL;
    DROP INDEX IF EXISTS uq_ranking_payout;
    CREATE UNIQUE INDEX uq_ranking_payout
      ON ranking_payouts(periodo,scope,periodo_label,COALESCE(classroom_id,'00000000-0000-0000-0000-000000000000'::uuid),user_id,posicion);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS mood_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mood SMALLINT NOT NULL CHECK(mood BETWEEN 1 AND 5),
      categories TEXT[] NOT NULL DEFAULT '{}',
      nota TEXT,
      coins_earned INTEGER NOT NULL DEFAULT 0 CHECK(coins_earned >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mood_user_created ON mood_entries(user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS wellness_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      tipo TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      is_anonymous BOOLEAN NOT NULL DEFAULT FALSE,
      reviewed BOOLEAN NOT NULL DEFAULT FALSE,
      reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_proposals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      seccion TEXT NOT NULL,
      titulo TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pending',
      respuesta TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      resolved_by UUID REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS parent_student_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(parent_id,student_id)
    );
    CREATE TABLE IF NOT EXISTS parent_link_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_id UUID REFERENCES users(id) ON DELETE CASCADE,
      student_id UUID REFERENCES users(id) ON DELETE CASCADE,
      student_name TEXT,
      estado TEXT DEFAULT 'pendiente' CHECK(estado IN ('pendiente','aprobado','rechazado')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      turno TEXT NOT NULL CHECK(turno IN ('manana','tarde','noche','extra')),
      day_of_week SMALLINT NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
      subject TEXT NOT NULL,
      time_from TEXT,
      time_to TEXT,
      color TEXT DEFAULT '#3b82f6',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS academic_events (
      id SERIAL PRIMARY KEY,
      titulo TEXT NOT NULL,
      descripcion TEXT,
      fecha DATE NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'evento',
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS parent_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      texto TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS mission_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      mission_id UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      submission_id UUID,
      created_by UUID NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'forming' CHECK(status IN ('forming','ready','submitted','approved','rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mission_group_members (
      group_id UUID NOT NULL REFERENCES mission_groups(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      accepted BOOLEAN DEFAULT FALSE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(group_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS peer_evaluations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID NOT NULL REFERENCES mission_groups(id) ON DELETE CASCADE,
      mission_id UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      evaluator_id UUID NOT NULL REFERENCES users(id),
      evaluatee_id UUID NOT NULL REFERENCES users(id),
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      comment TEXT,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(group_id,evaluator_id,evaluatee_id)
    );
    CREATE TABLE IF NOT EXISTS teacher_coop_observations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      teacher_id UUID NOT NULL REFERENCES users(id),
      student_id UUID NOT NULL REFERENCES users(id),
      group_id UUID REFERENCES mission_groups(id) ON DELETE SET NULL,
      mission_id UUID REFERENCES missions(id) ON DELETE SET NULL,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS coop_ranking_config (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      posicion INTEGER NOT NULL UNIQUE,
      premio INTEGER NOT NULL DEFAULT 0,
      activo BOOLEAN DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS coop_ranking_payouts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      periodo_label TEXT NOT NULL,
      user_id UUID NOT NULL REFERENCES users(id),
      posicion INTEGER NOT NULL,
      premio INTEGER NOT NULL,
      transaction_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS peer_eval_config (
      id SERIAL PRIMARY KEY,
      config JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO peer_eval_config(config)
      SELECT '{"school_hour_start":"07:00","school_hour_end":"15:00","timezone":"America/Argentina/Buenos_Aires","rotation_lookback":5,"history_months":6}'::jsonb
      WHERE NOT EXISTS(SELECT 1 FROM peer_eval_config);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS attendance (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      classroom_id UUID REFERENCES classrooms(id) ON DELETE SET NULL,
      teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
      fecha DATE NOT NULL,
      estado TEXT NOT NULL CHECK(estado IN ('presente','ausente','tarde')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(student_id,fecha)
    );
    CREATE TABLE IF NOT EXISTS attendance_edit_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      teacher_id UUID REFERENCES users(id) ON DELETE CASCADE,
      classroom_id UUID REFERENCES classrooms(id) ON DELETE CASCADE,
      fecha DATE NOT NULL,
      motivo TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','consumed')),
      reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS diwy_observations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID REFERENCES users(id) ON DELETE CASCADE,
      teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
      semana DATE NOT NULL,
      texto TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS diwy_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID REFERENCES users(id) ON DELETE CASCADE,
      generated_by UUID REFERENCES users(id) ON DELETE SET NULL,
      periodo_label TEXT,
      data_snapshot JSONB,
      reporte_ia TEXT,
      reporte_final TEXT,
      estado TEXT DEFAULT 'draft' CHECK(estado IN ('draft','pendiente_revision','aprobado')),
      approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS diwy_parent_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id UUID REFERENCES users(id) ON DELETE CASCADE,
      parent_id UUID REFERENCES users(id) ON DELETE CASCADE,
      requested_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS diwy_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_id UUID REFERENCES users(id) ON DELETE CASCADE,
      student_id UUID REFERENCES users(id) ON DELETE CASCADE,
      original_msg TEXT NOT NULL,
      formatted_msg TEXT,
      teacher_reply TEXT,
      formatted_reply TEXT,
      teacher_id UUID REFERENCES users(id) ON DELETE SET NULL,
      estado TEXT DEFAULT 'pending' CHECK(estado IN ('pending','replied')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      replied_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS diwy_parent_asks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_id UUID REFERENCES users(id) ON DELETE CASCADE,
      student_id UUID REFERENCES users(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS parent_teacher_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      teacher_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL CHECK(sender_role IN ('parent','teacher')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      read_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_ptm_thread
      ON parent_teacher_messages(parent_id,student_id,teacher_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS parent_admin_contacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      admin_id UUID REFERENCES users(id) ON DELETE SET NULL,
      sender_role TEXT NOT NULL CHECK(sender_role IN ('parent','admin')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      read_at TIMESTAMPTZ
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS wellness_notes (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mood INTEGER,
      categories JSONB DEFAULT '[]',
      nota TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wellness_backups (
      id UUID PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      period_days INTEGER NOT NULL,
      record_count INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      encrypted_data TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wellness_config (
      id SERIAL PRIMARY KEY,
      config JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    INSERT INTO wellness_config(config)
      SELECT '{}'::jsonb WHERE NOT EXISTS(SELECT 1 FROM wellness_config);
    CREATE TABLE IF NOT EXISTS verdicts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      to_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mensaje TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'advertencia',
      coins_penalty INTEGER NOT NULL DEFAULT 0,
      coins_reward INTEGER NOT NULL DEFAULT 0,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE verdicts ADD COLUMN IF NOT EXISTS coins_reward INTEGER NOT NULL DEFAULT 0;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS earned_titles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      rarity VARCHAR(20) NOT NULL DEFAULT 'common',
      color VARCHAR(30) DEFAULT '#ffffff',
      glow_color VARCHAR(30),
      emoji VARCHAR(20),
      note TEXT,
      granted_by UUID REFERENCES users(id),
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS loaned_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(30) NOT NULL,
      item_data JSONB NOT NULL DEFAULT '{}',
      note TEXT,
      expires_at TIMESTAMPTZ,
      granted_by UUID REFERENCES users(id),
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ranking_prize_sets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      periodo TEXT NOT NULL,
      puesto INTEGER NOT NULL,
      puesto_hasta INTEGER,
      activo BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(periodo,puesto)
    );
    CREATE TABLE IF NOT EXISTS ranking_prize_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      prize_set_id UUID REFERENCES ranking_prize_sets(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL,
      valor JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ranking_prizes_granted (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      periodo TEXT NOT NULL,
      periodo_label TEXT NOT NULL,
      puesto INTEGER NOT NULL,
      premio_data JSONB NOT NULL,
      granted_at TIMESTAMPTZ DEFAULT NOW(),
      granted_by VARCHAR(40) DEFAULT 'system'
    );
    CREATE TABLE IF NOT EXISTS prize_schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      periodo VARCHAR(10) NOT NULL UNIQUE,
      hora TIME NOT NULL DEFAULT '18:00:00',
      dia_semana INTEGER,
      dia_mes INTEGER,
      activo BOOLEAN DEFAULT TRUE,
      ultima_ejecucion TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

module.exports = { ensureApplicationSchema };
