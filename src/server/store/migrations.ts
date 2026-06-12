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
