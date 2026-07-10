import Database from 'better-sqlite3';

const createMetaTableSql = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const migrationSqlList: string[] = [
  `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  `
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  song_id TEXT,
  song_name TEXT,
  artist_name TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);
`,
  `
CREATE TABLE IF NOT EXISTS plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_date TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(plan_date, version)
);
`,
  `
CREATE TABLE IF NOT EXISTS prefs (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  `
CREATE TABLE IF NOT EXISTS tts_cache (
  cache_key TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  `
CREATE TABLE IF NOT EXISTS segues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT,
  from_name TEXT,
  to_id TEXT,
  to_name TEXT,
  say TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  `ALTER TABLE messages ADD COLUMN extracted_at TEXT;`,
  `
CREATE TABLE IF NOT EXISTS chat_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary TEXT NOT NULL,
  message_ids TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  `
CREATE TABLE IF NOT EXISTS users (
  ncm_id       TEXT PRIMARY KEY,
  ncm_cookie   TEXT NOT NULL,
  profile_json TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  `
CREATE TABLE IF NOT EXISTS blocked_login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ncm_id       TEXT NOT NULL,
  profile_json TEXT,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`,
  `
ALTER TABLE messages ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
UPDATE messages SET user_id = '__legacy__' WHERE user_id = '';

ALTER TABLE plays ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
UPDATE plays SET user_id = '__legacy__' WHERE user_id = '';

ALTER TABLE segues ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
UPDATE segues SET user_id = '__legacy__' WHERE user_id = '';

ALTER TABLE chat_preferences ADD COLUMN user_id TEXT NOT NULL DEFAULT '';
UPDATE chat_preferences SET user_id = '__legacy__' WHERE user_id = '';

CREATE TABLE prefs_new (
  user_id    TEXT NOT NULL DEFAULT '',
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);
INSERT INTO prefs_new (user_id, key, value_json, updated_at)
  SELECT '__legacy__', key, value_json, updated_at FROM prefs;
DROP TABLE prefs;
ALTER TABLE prefs_new RENAME TO prefs;

CREATE TABLE plan_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL DEFAULT '',
  plan_date    TEXT NOT NULL,
  version      INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, plan_date, version)
);
INSERT INTO plan_new (id, user_id, plan_date, version, payload_json, created_at)
  SELECT id, '__legacy__', plan_date, version, payload_json, created_at FROM plan;
DROP TABLE plan;
ALTER TABLE plan_new RENAME TO plan;
`,
  `
CREATE TABLE IF NOT EXISTS music_query_stats (
  user_id          TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  display_query    TEXT NOT NULL,
  source           TEXT NOT NULL,
  searched_count   INTEGER NOT NULL DEFAULT 0,
  result_count     INTEGER NOT NULL DEFAULT 0,
  added_count      INTEGER NOT NULL DEFAULT 0,
  selected_count   INTEGER NOT NULL DEFAULT 0,
  last_used_order  INTEGER NOT NULL DEFAULT 0,
  last_used_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, normalized_query, source)
);

CREATE INDEX IF NOT EXISTS idx_music_query_stats_user_recent
  ON music_query_stats (user_id, last_used_order DESC);
`,
  `
CREATE TABLE IF NOT EXISTS music_entities (
  user_id             TEXT NOT NULL,
  id                  TEXT NOT NULL,
  type                TEXT NOT NULL,
  provider            TEXT NOT NULL,
  provider_id         TEXT,
  title               TEXT,
  artist              TEXT,
  album               TEXT,
  description         TEXT NOT NULL,
  style_hints_json    TEXT NOT NULL DEFAULT '[]',
  constraints_json    TEXT NOT NULL DEFAULT '[]',
  source_signals_json TEXT NOT NULL DEFAULT '[]',
  last_verified_at    TEXT,
  selected_count      INTEGER NOT NULL DEFAULT 0,
  skipped_count       INTEGER NOT NULL DEFAULT 0,
  last_used_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_music_entities_user_type
  ON music_entities (user_id, type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_music_entities_user_provider
  ON music_entities (user_id, provider, provider_id);

CREATE TABLE IF NOT EXISTS music_entity_embeddings (
  user_id    TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  model      TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, entity_id, model),
  FOREIGN KEY (user_id, entity_id) REFERENCES music_entities(user_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_music_entity_embeddings_user_model
  ON music_entity_embeddings (user_id, model);
`,
  `
CREATE TABLE IF NOT EXISTS music_entity_index_state (
  user_id     TEXT NOT NULL,
  source      TEXT NOT NULL,
  cursor      TEXT NOT NULL DEFAULT '',
  last_run_at TEXT,
  last_error  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, source)
);
`,
  `
CREATE TABLE IF NOT EXISTS dj_events (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  type               TEXT NOT NULL,
  correlation_id     TEXT NOT NULL,
  causation_event_id TEXT,
  run_id             TEXT,
  track_id           TEXT,
  payload_json       TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dj_events_user_created
  ON dj_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dj_events_user_correlation
  ON dj_events (user_id, correlation_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_dj_events_user_track
  ON dj_events (user_id, track_id, created_at DESC);
`,
  `
CREATE TABLE IF NOT EXISTS personal_dj_contexts (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,
  source_kind      TEXT NOT NULL,
  source_bundle_id TEXT,
  slice_count      INTEGER NOT NULL DEFAULT 0,
  uploaded_at      TEXT NOT NULL,
  revoked_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_personal_dj_contexts_user_uploaded
  ON personal_dj_contexts (user_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS personal_dj_context_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_personal_dj_context_tokens_user
  ON personal_dj_context_tokens (user_id, created_at DESC);
  `,
  `
CREATE TABLE IF NOT EXISTS music_track_analysis_cache (
  provider                TEXT NOT NULL,
  track_id                TEXT NOT NULL,
  analyzer_version        TEXT,
  lyric_status            TEXT NOT NULL DEFAULT 'unknown',
  lyric_hash              TEXT,
  profile_json            TEXT,
  confidence_json         TEXT,
  evidence_json           TEXT,
  extraction_summary_json TEXT NOT NULL DEFAULT '{}',
  analysis_model          TEXT,
  last_lyric_refresh_at   TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, track_id)
);
  `
];

export function runMigrations(db: Database.Database): void {
  db.exec(createMetaTableSql);

  const getVersionStmt = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`);
  const row = getVersionStmt.get() as { value?: string } | undefined;
  const currentVersion = Number(row?.value ?? '0');

  if (currentVersion >= migrationSqlList.length) {
    return;
  }

  const transaction = db.transaction(() => {
    for (let i = currentVersion; i < migrationSqlList.length; i += 1) {
      db.exec(migrationSqlList[i]);
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`)
        .run(String(i + 1));
    }
  });

  transaction();
}
