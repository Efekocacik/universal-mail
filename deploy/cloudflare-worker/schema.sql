-- Universal Mail: Cloudflare Worker çıkış aktarıcısının D1 şeması (deploy/cloudflare-worker/README.md, adım 2).
-- Tekrar çalıştırmak güvenlidir (IF NOT EXISTS); mevcut kayıtlara dokunmaz.

CREATE TABLE IF NOT EXISTS spool_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 30),
  token TEXT NOT NULL CHECK (length(token) BETWEEN 1 AND 700),
  received_at INTEGER NOT NULL CHECK (received_at > 0),
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS spool_events_token_received ON spool_events (token, received_at);

CREATE TABLE IF NOT EXISTS spool_corrupt (
  id TEXT PRIMARY KEY NOT NULL,
  token TEXT,
  received_at INTEGER,
  moved_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS replay_jti (
  jti TEXT PRIMARY KEY NOT NULL CHECK (length(jti) BETWEEN 1 AND 64),
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS replay_jti_expires ON replay_jti (expires_at);
