-- Universal Mail: Cloudflare Worker çıkış aktarıcısının D1 şeması (deploy/cloudflare-worker/README.md, adım 1).
-- Tekrar çalıştırmak güvenlidir (IF NOT EXISTS / OR IGNORE); mevcut kayıtlara dokunmaz.

CREATE TABLE IF NOT EXISTS spool_events (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 30),
  token TEXT NOT NULL CHECK (length(token) BETWEEN 1 AND 700),
  received_at INTEGER NOT NULL CHECK (received_at > 0),
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS spool_events_token_received ON spool_events (token, received_at);

-- Bekleyen olay sayısı TEK satırda tutulur: her çıkışta `COUNT(*)` (D1'de tablodaki her satır "okunan satır" sayılır)
-- yerine bu satır okunur. Tetikleyiciler sayıyı her ekleme/silmede (konsoldan elle yapılanlar dahil) günceller.
CREATE TABLE IF NOT EXISTS spool_meta (
  k INTEGER PRIMARY KEY NOT NULL CHECK (k = 1),
  depth INTEGER NOT NULL CHECK (depth >= 0)
);

INSERT OR IGNORE INTO spool_meta (k, depth) SELECT 1, COUNT(*) FROM spool_events;

CREATE TRIGGER IF NOT EXISTS spool_events_count_insert AFTER INSERT ON spool_events BEGIN UPDATE spool_meta SET depth = depth + 1 WHERE k = 1; END;

CREATE TRIGGER IF NOT EXISTS spool_events_count_delete AFTER DELETE ON spool_events BEGIN UPDATE spool_meta SET depth = max(depth - 1, 0) WHERE k = 1; END;

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
