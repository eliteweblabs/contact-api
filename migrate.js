const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

const migration = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS contacts (
  id           SERIAL PRIMARY KEY,
  uid          UUID UNIQUE DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  first_name   TEXT,
  last_name    TEXT,
  email        TEXT,
  phone        TEXT,
  company      TEXT,
  notes        TEXT,
  priority    INTEGER DEFAULT 500,
  status      TEXT DEFAULT 'active',
  archived     BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contact_aliases (
  id           SERIAL PRIMARY KEY,
  contact_id   INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  field        TEXT NOT NULL CHECK (field IN ('name','email','phone')),
  value        TEXT NOT NULL,
  UNIQUE(contact_id, field, value)
);

CREATE TABLE IF NOT EXISTS contact_links (
  id           SERIAL PRIMARY KEY,
  contact_id   INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  system       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  metadata     JSONB DEFAULT '{}',
  UNIQUE(system, external_id)
);

CREATE INDEX IF NOT EXISTS idx_contacts_email       ON contacts(lower(email));
CREATE INDEX IF NOT EXISTS idx_contacts_phone       ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm   ON contacts USING gin(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_contacts_first_trgm  ON contacts USING gin(first_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_contacts_last_trgm   ON contacts USING gin(last_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_aliases_value_trgm   ON contact_aliases USING gin(value gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_aliases_field_value   ON contact_aliases(field, lower(value));
CREATE INDEX IF NOT EXISTS idx_links_system          ON contact_links(system, external_id);

UPDATE contacts SET archived = false WHERE archived IS NULL;
`;

async function run() {
  console.log('[migrate] Running schema migration...');
  try {
    await pool.query(migration);
    console.log('[migrate] Done.');
  } catch (e) {
    console.error('[migrate] Error:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
