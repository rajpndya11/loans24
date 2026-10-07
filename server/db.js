// Postgres everywhere: a real server via DATABASE_URL (Neon/Supabase/RDS) in production,
// or embedded PGlite on disk for local development (zero setup).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    phone         TEXT NOT NULL UNIQUE,
    name          TEXT,
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS otps (
    phone        TEXT PRIMARY KEY,
    code_hash    TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    sent_count   INTEGER NOT NULL DEFAULT 1,
    window_start TEXT NOT NULL,
    last_sent_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id               TEXT PRIMARY KEY,
    token_hash       TEXT NOT NULL UNIQUE,
    user_id          TEXT,
    loan_id          TEXT NOT NULL,
    applicant_name   TEXT NOT NULL,
    business_name    TEXT,
    address_text     TEXT NOT NULL,
    declared_lat     DOUBLE PRECISION,
    declared_lng     DOUBLE PRECISION,
    geocode_label    TEXT,
    geo_precision    TEXT,
    persona          TEXT NOT NULL,
    assist           INTEGER NOT NULL DEFAULT 0,
    lang             TEXT NOT NULL,
    status           TEXT NOT NULL,
    attempt          INTEGER NOT NULL DEFAULT 1,
    consent_at       TEXT,
    consent_version  TEXT,
    score            INTEGER,
    reasons          TEXT,
    ces              INTEGER,
    review_note      TEXT,
    decided_by       TEXT,
    created_at       TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    submitted_at     TEXT,
    decided_at       TEXT,
    purged_at        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS captures (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    attempt     INTEGER NOT NULL,
    file_key    TEXT NOT NULL,
    mime        TEXT NOT NULL,
    bytes       INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    phash       TEXT,
    lat         DOUBLE PRECISION,
    lng         DOUBLE PRECISION,
    accuracy_m  DOUBLE PRECISION,
    client_ts   TEXT,
    server_ts   TEXT NOT NULL,
    quality     TEXT,
    quality_ok  INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_captures_session ON captures(session_id, attempt);

  CREATE TABLE IF NOT EXISTS events (
    id          BIGSERIAL PRIMARY KEY,
    session_id  TEXT NOT NULL,
    type        TEXT NOT NULL,
    actor       TEXT NOT NULL,
    data        TEXT,
    ip          TEXT,
    at          TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
`;

let ready;

async function connect() {
  let run, exec;
  if (config.databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 3, idleTimeoutMillis: 10_000 });
    run = async (text, params) => (await pool.query(text, params)).rows;
    exec = (sql) => pool.query(sql);
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    fs.mkdirSync(config.dataDir, { recursive: true });
    const lite = new PGlite(path.join(config.dataDir, 'pg'));
    run = async (text, params) => (await lite.query(text, params)).rows;
    exec = (sql) => lite.exec(sql);
  }
  try {
    await exec(SCHEMA);
  } catch (err) {
    // Two cold starts racing to create the schema: the loser can safely ignore it.
    if (!['23505', '42P07'].includes(err.code)) throw err;
  }
  return run;
}

export async function query(text, params = []) {
  ready ??= connect().catch((err) => { ready = undefined; throw err; });
  const run = await ready;
  return run(text, params);
}

export const one = async (text, params) => (await query(text, params))[0];

export const now = () => new Date().toISOString();

export function logEvent(sessionId, type, actor, data = null, ip = null) {
  return query('INSERT INTO events (session_id, type, actor, data, ip, at) VALUES ($1, $2, $3, $4, $5, $6)',
    [sessionId, type, actor, data ? JSON.stringify(data) : null, ip, now()]);
}
