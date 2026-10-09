'use strict';
const { Pool } = require('pg');
const cfg = require('./config');

const pool = new Pool({
  connectionString: cfg.databaseUrl,
  ssl: cfg.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
  connectionTimeoutMillis: 10000
});
pool.on('error', e => console.error('[pg pool]', e.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK(role IN('customer','admin')),
  wallet_balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(wallet_balance>=0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

CREATE TABLE IF NOT EXISTS games(
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  image_url TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  fields JSONB NOT NULL DEFAULT '[]',
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS game_packs(
  id BIGSERIAL PRIMARY KEY,
  game_id BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price NUMERIC(14,2) NOT NULL CHECK(price>=0),
  currency TEXT NOT NULL DEFAULT 'GDS',
  image_url TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'Diamonds',
  popular BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE game_packs ADD COLUMN IF NOT EXISTS qty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_packs ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Diamonds';
ALTER TABLE game_packs ADD COLUMN IF NOT EXISTS popular BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS wallet_deposits(
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  method TEXT NOT NULL CHECK(method IN('MonCash','NatCash')),
  amount NUMERIC(14,2) NOT NULL CHECK(amount>0),
  transaction_reference TEXT UNIQUE NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  customer_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','confirmed','refused')),
  admin_note TEXT NOT NULL DEFAULT '',
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE wallet_deposits ADD COLUMN IF NOT EXISTS customer_note TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS orders(
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  game_id BIGINT REFERENCES games(id) ON DELETE SET NULL,
  game TEXT NOT NULL,
  pack_id BIGINT REFERENCES game_packs(id) ON DELETE SET NULL,
  pack TEXT NOT NULL,
  price NUMERIC(14,2) NOT NULL CHECK(price>=0),
  currency TEXT NOT NULL DEFAULT 'GDS',
  player_id TEXT NOT NULL DEFAULT '',
  player_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  customer_name TEXT NOT NULL DEFAULT '',
  referral TEXT NOT NULL DEFAULT '',
  diamonds INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'En attente',
  charged BOOLEAN NOT NULL DEFAULT TRUE,
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS referral TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS diamonds INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS payment_settings(
  id INT PRIMARY KEY DEFAULT 1 CHECK(id=1),
  moncash_number TEXT NOT NULL DEFAULT '',
  natcash_number TEXT NOT NULL DEFAULT '',
  whatsapp_number TEXT NOT NULL DEFAULT '',
  moncash_logo TEXT NOT NULL DEFAULT '',
  natcash_logo TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ads(
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL,
  target_url TEXT NOT NULL DEFAULT '',
  price NUMERIC(14,2) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE ads ADD COLUMN IF NOT EXISTS price NUMERIC(14,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS site_media(
  id INT PRIMARY KEY DEFAULT 1 CHECK(id=1),
  home_image TEXT NOT NULL DEFAULT '',
  games JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tutorial_config(
  id INT PRIMARY KEY DEFAULT 1 CHECK(id=1),
  title TEXT NOT NULL DEFAULT 'Tutoriel FLEX TUPUP',
  video_url TEXT NOT NULL DEFAULT '',
  video_poster TEXT NOT NULL DEFAULT '',
  video_type TEXT NOT NULL DEFAULT 'video/mp4',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  steps JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications(
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referrals(
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  affiliate TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings(
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_notifications(
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}',
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs(
  id BIGSERIAL PRIMARY KEY,
  admin_id BIGINT,
  admin TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}',
  ip TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS security_events(
  id BIGSERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'low',
  ip TEXT NOT NULL DEFAULT '',
  user_id TEXT,
  path TEXT NOT NULL DEFAULT '',
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS security_blocks(
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(kind,value)
);

CREATE INDEX IF NOT EXISTS idx_deposit_user_created ON wallet_deposits(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposit_status ON wallet_deposits(status);
CREATE INDEX IF NOT EXISTS idx_order_user_created ON orders(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_notes_created ON admin_notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sec_events_created ON security_events(created_at DESC);
`;

async function init() {
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL manquant');
  if (!cfg.jwtSecret || cfg.jwtSecret.length < 32) throw new Error('JWT_SECRET doit avoir au moins 32 caractères');

  await pool.query(SCHEMA);
  await pool.query('INSERT INTO site_media(id) VALUES(1) ON CONFLICT(id) DO NOTHING');
  await pool.query('INSERT INTO tutorial_config(id) VALUES(1) ON CONFLICT(id) DO NOTHING');
  await pool.query(
    'INSERT INTO payment_settings(id,moncash_number,natcash_number,whatsapp_number) VALUES(1,$1,$2,$3) ON CONFLICT(id) DO NOTHING',
    [cfg.defaults.moncash.slice(0, 100), cfg.defaults.natcash.slice(0, 100), cfg.defaults.whatsapp.slice(0, 100)]
  );
  // Téléphone unique (si des doublons existent déjà, on continue sans l'index)
  try {
    await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(phone) WHERE phone<>''");
  } catch (e) {
    console.warn('[db] index téléphone unique ignoré (doublons existants):', e.message);
  }
}

module.exports = { pool, init };
