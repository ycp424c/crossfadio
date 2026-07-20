import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { LISTENING_EPISODE_DAILY_LIMIT } from '../../shared/listening.js';

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
  evidence_json           TEXT,
  extraction_summary_json TEXT NOT NULL DEFAULT '{}',
  analysis_model          TEXT,
  last_lyric_refresh_at   TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, track_id)
);
  `,
  `
ALTER TABLE music_track_analysis_cache ADD COLUMN confidence_json TEXT;
  `,
  `
CREATE TABLE IF NOT EXISTS listening_episodes (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  client_episode_id        TEXT NOT NULL,
  player_instance_id       TEXT NOT NULL,
  deck_id                  TEXT NOT NULL,
  provider                 TEXT NOT NULL DEFAULT 'ncm',
  track_id                 TEXT NOT NULL,
  track_name               TEXT NOT NULL,
  artists_json             TEXT NOT NULL DEFAULT '[]',
  primary_artist           TEXT,
  duration_ms              INTEGER,
  position_ms              INTEGER NOT NULL DEFAULT 0,
  listened_ms              INTEGER NOT NULL DEFAULT 0,
  checkpoint_seq           INTEGER NOT NULL DEFAULT 0,
  outcome                  TEXT,
  started_at               TEXT NOT NULL,
  last_checkpoint_at       TEXT NOT NULL,
  ended_at                 TEXT,
  protocol_version         INTEGER NOT NULL DEFAULT 2,
  legacy_exposure_override REAL,
  UNIQUE (user_id, client_episode_id),
  CHECK (duration_ms IS NULL OR duration_ms > 0),
  CHECK (position_ms >= 0),
  CHECK (listened_ms >= 0),
  CHECK (checkpoint_seq >= 0),
  CHECK (outcome IS NULL OR outcome IN ('completed', 'skipped', 'failed', 'interrupted')),
  CHECK (legacy_exposure_override IS NULL OR (
    legacy_exposure_override >= 0 AND legacy_exposure_override <= 1
  ))
);

CREATE INDEX IF NOT EXISTS idx_listening_episodes_user_started
  ON listening_episodes (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_listening_episodes_user_track_started
  ON listening_episodes (user_id, track_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_listening_episodes_started_retention
  ON listening_episodes (started_at);

CREATE INDEX IF NOT EXISTS idx_listening_episodes_open
  ON listening_episodes (user_id, last_checkpoint_at)
  WHERE outcome IS NULL;

CREATE TABLE IF NOT EXISTS preference_evidence (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  evidence_kind      TEXT NOT NULL,
  subject_type       TEXT NOT NULL,
  subject_key        TEXT NOT NULL,
  polarity           TEXT NOT NULL,
  strength           TEXT NOT NULL,
  confidence         REAL NOT NULL,
  source_kind        TEXT NOT NULL,
  source_refs_json   TEXT NOT NULL DEFAULT '[]',
  observed_at        TEXT NOT NULL,
  expires_at         TEXT,
  extractor_version  TEXT,
  superseded_by_id   TEXT,
  payload_json       TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (evidence_kind IN ('expressed', 'inferred')),
  CHECK (polarity IN ('positive', 'negative')),
  CHECK (strength IN ('weak', 'medium', 'strong')),
  CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX IF NOT EXISTS idx_preference_evidence_user_subject_observed
  ON preference_evidence (user_id, subject_type, subject_key, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_preference_evidence_expires
  ON preference_evidence (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS preference_extraction_batches (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL,
  source_key         TEXT NOT NULL,
  message_ids_json   TEXT NOT NULL DEFAULT '[]',
  extractor_version  TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TEXT,
  lease_token        TEXT,
  lease_until        TEXT,
  error_code         TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at       TEXT,
  UNIQUE (user_id, source_key, extractor_version),
  CHECK (status IN ('pending', 'retryable', 'processing', 'succeeded', 'no_evidence', 'dead')),
  CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_preference_extraction_batches_retry
  ON preference_extraction_batches (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS explicit_exclusions (
  id                         TEXT PRIMARY KEY,
  user_id                    TEXT NOT NULL,
  entity_type                TEXT NOT NULL,
  entity_key                 TEXT NOT NULL,
  provider                   TEXT,
  provider_id                TEXT,
  display_name               TEXT,
  source_kind                TEXT NOT NULL,
  source_ref_json            TEXT NOT NULL DEFAULT '{}',
  aliases_json               TEXT NOT NULL DEFAULT '[]',
  created_at                 TEXT NOT NULL,
  revoked_at                 TEXT,
  revocation_source_ref_json TEXT,
  CHECK (entity_type IN ('track', 'artist'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_explicit_exclusions_active_unique
  ON explicit_exclusions (user_id, entity_type, entity_key)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_explicit_exclusions_user_entity_revoked
  ON explicit_exclusions (user_id, entity_type, entity_key, revoked_at);

CREATE TABLE IF NOT EXISTS taste_profiles (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  version             INTEGER NOT NULL,
  profile_json        TEXT NOT NULL,
  source_kind         TEXT NOT NULL,
  source_library_hash TEXT,
  generated_at        TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, version),
  CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS idx_taste_profiles_user_generated
  ON taste_profiles (user_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS retrieval_attempts (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  run_id           TEXT NOT NULL,
  source           TEXT NOT NULL,
  request_kind     TEXT NOT NULL,
  normalized_query TEXT NOT NULL,
  display_query    TEXT NOT NULL,
  searched_count   INTEGER NOT NULL DEFAULT 0,
  result_count     INTEGER NOT NULL DEFAULT 0,
  added_count      INTEGER NOT NULL DEFAULT 0,
  selected_count   INTEGER NOT NULL DEFAULT 0,
  attempted_at     TEXT NOT NULL,
  CHECK (request_kind IN ('autonomous', 'explicit_request')),
  CHECK (searched_count >= 0),
  CHECK (result_count >= 0),
  CHECK (added_count >= 0),
  CHECK (selected_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_retrieval_attempts_user_query_attempted
  ON retrieval_attempts (user_id, source, normalized_query, attempted_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_retrieval_attempts_run_query_unique
  ON retrieval_attempts (user_id, run_id, source, normalized_query);

CREATE INDEX IF NOT EXISTS idx_retrieval_attempts_attempted_retention
  ON retrieval_attempts (attempted_at);

CREATE TABLE IF NOT EXISTS dj_configuration_entries (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  entry_key   TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dj_configuration_entries_active_unique
  ON dj_configuration_entries (user_id, kind, entry_key)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS selection_debug_traces (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  trace_json     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  UNIQUE (user_id, run_id, schema_version)
);

CREATE INDEX IF NOT EXISTS idx_selection_debug_traces_expires
  ON selection_debug_traces (expires_at);

CREATE TABLE IF NOT EXISTS selection_journeys (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  run_id              TEXT NOT NULL,
  journey_version     INTEGER NOT NULL,
  revision            INTEGER NOT NULL DEFAULT 0,
  facts_hash          TEXT NOT NULL,
  status              TEXT NOT NULL,
  snapshot_json       TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  completed_at        TEXT,
  expires_at          TEXT NOT NULL,
  UNIQUE (user_id, run_id, journey_version),
  CHECK (journey_version > 0),
  CHECK (revision >= 0),
  CHECK (status IN ('running', 'completed', 'failed', 'superseded'))
);

CREATE INDEX IF NOT EXISTS idx_selection_journeys_user_updated
  ON selection_journeys (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_selection_journeys_expires
  ON selection_journeys (expires_at);

CREATE TABLE IF NOT EXISTS selection_narration_outbox (
  id              TEXT PRIMARY KEY,
  journey_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  journey_version INTEGER NOT NULL,
  facts_hash      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_until     TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  UNIQUE (user_id, run_id, journey_version, facts_hash),
  CHECK (status IN ('pending', 'processing', 'completed', 'dead')),
  CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_selection_narration_outbox_due
  ON selection_narration_outbox (status, next_attempt_at);

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

ALTER TABLE personal_dj_contexts ADD COLUMN generated_at TEXT;
ALTER TABLE personal_dj_contexts ADD COLUMN expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_personal_dj_contexts_user_expires
  ON personal_dj_contexts (user_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_dj_events_created_retention
  ON dj_events (created_at);
  `,
  `
CREATE TABLE selection_replay_runs (
  id                              TEXT PRIMARY KEY,
  user_id                         TEXT NOT NULL,
  run_id                          TEXT NOT NULL,
  selected_track_ids_json         TEXT NOT NULL DEFAULT '[]',
  candidate_count                 INTEGER NOT NULL,
  eligible_count                  INTEGER NOT NULL,
  appended_count                  INTEGER NOT NULL,
  latency_ms                      INTEGER NOT NULL,
  hard_violation_count            INTEGER NOT NULL DEFAULT 0,
  prompt_json_status              TEXT NOT NULL,
  journey_published               INTEGER NOT NULL,
  narration_status                TEXT NOT NULL DEFAULT 'not_applicable',
  narration_deadline_at           TEXT,
  outcome                         TEXT NOT NULL,
  reason_codes_json               TEXT NOT NULL DEFAULT '[]',
  started_at                      TEXT NOT NULL,
  completed_at                    TEXT,
  expires_at                      TEXT NOT NULL,
  UNIQUE (user_id, run_id),
  CHECK (outcome IN ('succeeded', 'failed', 'empty', 'superseded')),
  CHECK (prompt_json_status IN ('not_observed', 'valid', 'invalid')),
  CHECK (narration_status IN ('not_applicable', 'pending', 'succeeded', 'failed')),
  CHECK (candidate_count >= 0 AND eligible_count >= 0 AND appended_count >= 0),
  CHECK (latency_ms >= 0 AND hard_violation_count >= 0)
);

CREATE INDEX idx_selection_replay_runs_started
  ON selection_replay_runs (started_at DESC);
CREATE INDEX idx_selection_replay_runs_expires
  ON selection_replay_runs (expires_at);

CREATE TABLE selection_policy_replay_cases (
  id                         TEXT PRIMARY KEY,
  user_id                    TEXT NOT NULL,
  run_id                     TEXT NOT NULL,
  candidate_id               TEXT NOT NULL,
  candidate_track_key        TEXT NOT NULL,
  candidate_artist_key       TEXT NOT NULL,
  mode                       TEXT NOT NULL,
  identity_valid             INTEGER NOT NULL,
  source                     TEXT NOT NULL,
  quality_signals_json       TEXT NOT NULL DEFAULT '{}',
  title_motif_keys_json      TEXT NOT NULL DEFAULT '[]',
  base_score                 REAL NOT NULL,
  batch_index                INTEGER NOT NULL,
  batch_limit                INTEGER NOT NULL,
  context_json               TEXT NOT NULL,
  pressure_json              TEXT NOT NULL DEFAULT '[]',
  expected_json              TEXT NOT NULL,
  created_at                 TEXT NOT NULL,
  expires_at                 TEXT NOT NULL,
  UNIQUE (user_id, run_id, candidate_id),
  CHECK (mode IN ('autonomous', 'explicit_request')),
  CHECK (base_score >= 0),
  CHECK (batch_index >= 0 AND batch_limit >= 0)
);

CREATE INDEX idx_selection_policy_replay_cases_created
  ON selection_policy_replay_cases (created_at DESC);
CREATE INDEX idx_selection_policy_replay_cases_expires
  ON selection_policy_replay_cases (expires_at);
  `,
  `
CREATE TABLE explicit_exclusion_resolution_jobs (
  id                    TEXT PRIMARY KEY,
  exclusion_id          TEXT NOT NULL UNIQUE,
  resolved_exclusion_id TEXT,
  user_id               TEXT NOT NULL,
  query_title           TEXT NOT NULL,
  query_artist          TEXT,
  status                TEXT NOT NULL DEFAULT 'pending',
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at       TEXT NOT NULL,
  lease_token           TEXT,
  lease_until           TEXT,
  deadline_at           TEXT NOT NULL,
  last_error_code       TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  completed_at          TEXT,
  CHECK (status IN ('pending', 'retryable', 'processing', 'succeeded', 'dead')),
  CHECK (attempt_count >= 0)
);

CREATE INDEX idx_explicit_exclusion_resolution_due
  ON explicit_exclusion_resolution_jobs (status, next_attempt_at);
CREATE INDEX idx_explicit_exclusion_resolution_deadline
  ON explicit_exclusion_resolution_jobs (status, deadline_at);
  `,
  `
CREATE TABLE queue_state_mutations (
  user_id           TEXT NOT NULL,
  mutation_id       TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  resulting_revision INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, mutation_id),
  CHECK (resulting_revision >= 0)
);

CREATE INDEX idx_queue_state_mutations_created
  ON queue_state_mutations (created_at);
  `,
  `
CREATE TRIGGER listening_episodes_daily_quota
BEFORE INSERT ON listening_episodes
WHEN NEW.protocol_version >= 2 AND (
  SELECT COUNT(*)
  FROM listening_episodes
  WHERE user_id = NEW.user_id
    AND started_at >= date(NEW.started_at) || 'T00:00:00.000Z'
    AND started_at < date(NEW.started_at, '+1 day') || 'T00:00:00.000Z'
) >= ${LISTENING_EPISODE_DAILY_LIMIT}
BEGIN
  SELECT RAISE(ABORT, 'listening_episode_daily_quota_exceeded');
END;
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

type DataMigration = (db: Database.Database) => void;

const dataMigrationList: DataMigration[] = [
  backfillPersonalDjContextValidity,
  importLegacyPlaysAsListeningEpisodes,
  preserveRemovedLegacyDiscoveryModeForRollback,
  migrateLegacyPreferenceState,
  normalizeExplicitExclusionIdentities,
  normalizePreferenceEvidenceIdentities,
  backfillExplicitExclusionAliases
];

export function runDataMigrations(db: Database.Database): void {
  const row = db.prepare(
    `SELECT value FROM meta WHERE key = 'data_migration_version'`
  ).get() as { value?: string } | undefined;
  const currentVersion = Number(row?.value ?? '0');

  if (currentVersion >= dataMigrationList.length) return;

  db.transaction(() => {
    for (let index = currentVersion; index < dataMigrationList.length; index += 1) {
      dataMigrationList[index](db);
      db.prepare(
        `INSERT OR REPLACE INTO meta (key, value) VALUES ('data_migration_version', ?)`
      ).run(String(index + 1));
    }
  })();
}

function backfillPersonalDjContextValidity(db: Database.Database): void {
  const rows = db.prepare(
    `SELECT id, payload_json, uploaded_at, generated_at, expires_at
     FROM personal_dj_contexts
     WHERE generated_at IS NULL OR expires_at IS NULL`
  ).all() as Array<{
    id: string;
    payload_json: string;
    uploaded_at: string;
    generated_at: string | null;
    expires_at: string | null;
  }>;
  const update = db.prepare(
    `UPDATE personal_dj_contexts
     SET generated_at = COALESCE(generated_at, ?),
         expires_at = COALESCE(expires_at, ?)
     WHERE id = ?`
  );

  for (const row of rows) {
    const payload = parseObject(row.payload_json);
    const generatedAt = validIsoTimestamp(row.generated_at)
      ?? validIsoTimestamp(payload?.generatedAt)
      ?? validIsoTimestamp(row.uploaded_at);
    if (!generatedAt) continue;

    const maximumExpiryMs = Date.parse(generatedAt) + 24 * 60 * 60 * 1000;
    const declaredExpiry = validIsoTimestamp(payload?.validUntil);
    const declaredExpiryMs = declaredExpiry ? Date.parse(declaredExpiry) : Number.POSITIVE_INFINITY;
    const expiresAt = row.expires_at
      ?? new Date(Math.min(maximumExpiryMs, declaredExpiryMs)).toISOString();
    update.run(generatedAt, expiresAt, row.id);
  }
}

function importLegacyPlaysAsListeningEpisodes(db: Database.Database): void {
  if (!tableExists(db, 'plays')) return;

  db.prepare(`
    INSERT OR IGNORE INTO listening_episodes (
      id,
      user_id,
      client_episode_id,
      player_instance_id,
      deck_id,
      provider,
      track_id,
      track_name,
      artists_json,
      primary_artist,
      duration_ms,
      position_ms,
      listened_ms,
      checkpoint_seq,
      outcome,
      started_at,
      last_checkpoint_at,
      ended_at,
      protocol_version,
      legacy_exposure_override
    )
    SELECT
      'legacy-play-' || CAST(id AS TEXT),
      user_id,
      'legacy-play-' || CAST(id AS TEXT),
      'legacy-import',
      'legacy',
      'ncm',
      song_id,
      COALESCE(NULLIF(TRIM(song_name), ''), song_id),
      CASE
        WHEN artist_name IS NULL OR TRIM(artist_name) = '' THEN '[]'
        ELSE json_array(artist_name)
      END,
      NULLIF(TRIM(artist_name), ''),
      NULL,
      0,
      0,
      0,
      CASE end_reason
        WHEN 'completed' THEN 'completed'
        WHEN 'skip' THEN 'skipped'
        WHEN 'error' THEN 'failed'
        ELSE 'interrupted'
      END,
      started_at,
      COALESCE(ended_at, started_at),
      COALESCE(ended_at, started_at),
      0,
      CASE WHEN end_reason = 'completed' THEN 1.0 ELSE 0.25 END
    FROM plays
    WHERE song_id IS NOT NULL
      AND TRIM(song_id) <> ''
      AND started_at >= datetime('now', '-90 days')
  `).run();
}

function preserveRemovedLegacyDiscoveryModeForRollback(_db: Database.Database): void {
  // v2 maps unknown/legacy values to explore at read time. The stored value is
  // intentionally preserved so the pre-v2 rollback branch sees its old state.
}

function migrateLegacyPreferenceState(db: Database.Database): void {
  migrateLegacyBanPrefs(db);
  migrateLegacyChatPreferences(db);
}

function migrateLegacyBanPrefs(db: Database.Database): void {
  if (!tableExists(db, 'prefs')) return;
  const rows = db.prepare(`
    SELECT user_id, key, value_json, updated_at
    FROM prefs
    WHERE key LIKE 'ban.artist.%' OR key LIKE 'ban.track.%'
  `).all() as Array<{
    user_id: string;
    key: string;
    value_json: string;
    updated_at: string;
  }>;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO explicit_exclusions (
      id, user_id, entity_type, entity_key, provider, provider_id, display_name,
      source_kind, source_ref_json, created_at, revoked_at, revocation_source_ref_json
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'legacy_pref_migration', ?, ?, NULL, NULL)
  `);
  for (const row of rows) {
    if (parseJsonValue(row.value_json) !== true) continue;
    const artist = row.key.startsWith('ban.artist.');
    const rawKey = row.key.slice((artist ? 'ban.artist.' : 'ban.track.').length).trim();
    const entityKey = artist ? normalizeLegacyKey(rawKey) : normalizeLegacyTrackKey(rawKey);
    if (!entityKey) continue;
    insert.run(
      randomUUID(),
      row.user_id,
      artist ? 'artist' : 'track',
      entityKey,
      rawKey,
      JSON.stringify({ sourceId: `legacy-pref:${row.key}` }),
      sqliteTimestampToIso(row.updated_at)
    );
  }
}

function migrateLegacyChatPreferences(db: Database.Database): void {
  if (!tableExists(db, 'chat_preferences') || !tableExists(db, 'messages')) return;
  const rows = db.prepare(`
    SELECT id, user_id, summary, message_ids, created_at
    FROM chat_preferences
    ORDER BY id ASC
  `).all() as Array<{
    id: number;
    user_id: string;
    summary: string;
    message_ids: string;
    created_at: string;
  }>;
  const countMessages = db.prepare(`
    SELECT COUNT(*) AS count FROM messages
    WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))
  `);
  const insertBatch = db.prepare(`
    INSERT OR IGNORE INTO preference_extraction_batches (
      id, user_id, source_key, message_ids_json, extractor_version, status,
      attempt_count, next_attempt_at, error_code, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, 'preference-extractor-v1', 'pending', 0, NULL, NULL, ?, ?, NULL)
  `);
  const insertLegacySummary = db.prepare(`
    INSERT INTO preference_evidence (
      id, user_id, evidence_kind, subject_type, subject_key, polarity, strength,
      confidence, source_kind, source_refs_json, observed_at, expires_at,
      extractor_version, superseded_by_id, payload_json, created_at, updated_at
    ) VALUES (?, ?, 'inferred', 'legacy_summary', ?, 'positive', 'weak', 0.25,
      'legacy_summary', ?, ?, ?, 'legacy-summary-v1', NULL, ?, ?, ?)
  `);

  for (const row of rows) {
    const messageIds = parseLegacyMessageIds(row.message_ids);
    const observedAt = sqliteTimestampToIso(row.created_at);
    const locatedCount = messageIds.length > 0
      ? Number((countMessages.get(row.user_id, JSON.stringify(messageIds)) as { count: number }).count)
      : 0;
    if (messageIds.length > 0 && locatedCount === messageIds.length) {
      insertBatch.run(
        randomUUID(),
        row.user_id,
        `legacy-chat-preference:${row.id}`,
        JSON.stringify(messageIds),
        observedAt,
        observedAt
      );
      continue;
    }

    const summary = row.summary.trim().slice(0, 300);
    if (!summary) continue;
    const expiresAt = new Date(Date.parse(observedAt) + 60 * 24 * 60 * 60 * 1000).toISOString();
    insertLegacySummary.run(
      randomUUID(),
      row.user_id,
      summary,
      JSON.stringify([{ sourceId: `legacy-chat-preference:${row.id}` }]),
      observedAt,
      expiresAt,
      JSON.stringify({ legacySummary: summary }),
      observedAt,
      observedAt
    );
  }
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(
    `SELECT 1 AS found
     FROM sqlite_master
     WHERE type = 'table' AND name = ?
     LIMIT 1`
  ).get(tableName) as { found: number } | undefined;
  return Boolean(row);
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function validIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function sqliteTimestampToIso(value: string): string {
  const parsed = validIsoTimestamp(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return parsed ?? new Date(0).toISOString();
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseLegacyMessageIds(value: string): number[] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((id): id is number => Number.isInteger(id) && id > 0))]
    .sort((left, right) => left - right);
}

function normalizeLegacyKey(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function normalizeLegacyTrackKey(value: string): string {
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase();
  const separator = normalized.lastIndexOf('___');
  if (separator <= 0) return normalizeLegacyKey(normalized);
  return `${normalizeLegacyTrackToken(normalized.slice(0, separator))}___${
    normalizeLegacyTrackToken(normalized.slice(separator + 3))
  }`;
}

function normalizeLegacyTrackToken(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeExplicitExclusionIdentities(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT id, user_id, entity_type, entity_key, provider, provider_id, created_at, revoked_at
    FROM explicit_exclusions
  `).all() as Array<{
    id: string;
    user_id: string;
    entity_type: 'track' | 'artist';
    entity_key: string;
    provider: string | null;
    provider_id: string | null;
    created_at: string;
    revoked_at: string | null;
  }>;
  const activeByKey = db.prepare(`
    SELECT id FROM explicit_exclusions
    WHERE user_id = ? AND entity_type = ? AND entity_key = ?
      AND revoked_at IS NULL AND id <> ?
    LIMIT 1
  `);
  const updateKey = db.prepare('UPDATE explicit_exclusions SET entity_key = ? WHERE id = ?');
  const revokeDuplicate = db.prepare(`
    UPDATE explicit_exclusions
    SET revoked_at = ?, revocation_source_ref_json = ?
    WHERE id = ? AND revoked_at IS NULL
  `);

  for (const row of rows) {
    const normalizedKey = row.entity_type === 'artist'
      ? normalizeLegacyKey(row.entity_key)
      : row.provider && row.provider_id
        ? `${normalizeLegacyKey(row.provider)}:${normalizeLegacyKey(row.provider_id)}`
        : normalizeLegacyTrackKey(row.entity_key);
    if (!normalizedKey || normalizedKey === row.entity_key) continue;
    const duplicate = row.revoked_at === null
      ? activeByKey.get(row.user_id, row.entity_type, normalizedKey, row.id) as { id: string } | undefined
      : undefined;
    if (duplicate) {
      revokeDuplicate.run(
        row.created_at,
        JSON.stringify({ sourceId: `identity-normalization:${duplicate.id}` }),
        row.id
      );
      continue;
    }
    updateKey.run(normalizedKey, row.id);
  }
}

function normalizePreferenceEvidenceIdentities(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT id, user_id, evidence_kind, subject_type, subject_key, polarity,
           source_refs_json, observed_at, created_at, superseded_by_id
    FROM preference_evidence
  `).all() as Array<{
    id: string;
    user_id: string;
    evidence_kind: 'expressed' | 'inferred';
    subject_type: string;
    subject_key: string;
    polarity: 'positive' | 'negative';
    source_refs_json: string;
    observed_at: string;
    created_at: string;
    superseded_by_id: string | null;
  }>;
  const updateKey = db.prepare('UPDATE preference_evidence SET subject_key = ? WHERE id = ?');
  for (const row of rows) {
    const normalized = normalizeLegacyKey(row.subject_key);
    if (normalized !== row.subject_key) updateKey.run(normalized, row.id);
    row.subject_key = normalized;
  }

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.evidence_kind !== 'expressed' || row.superseded_by_id !== null) continue;
    const key = [row.user_id, row.subject_type, row.subject_key].join('\u0000');
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const supersede = db.prepare(`
    UPDATE preference_evidence
    SET superseded_by_id = ?, updated_at = ?
    WHERE id = ? AND superseded_by_id IS NULL
  `);
  for (const group of groups.values()) {
    const winner = [...group].sort(compareMigratedEvidenceOrder).at(-1);
    if (!winner) continue;
    for (const row of group) {
      if (row.id === winner.id || row.polarity === winner.polarity) continue;
      supersede.run(winner.id, new Date().toISOString(), row.id);
    }
  }
}

function backfillExplicitExclusionAliases(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT id, entity_key, display_name, aliases_json FROM explicit_exclusions
  `).all() as Array<{
    id: string;
    entity_key: string;
    display_name: string | null;
    aliases_json: string;
  }>;
  const update = db.prepare('UPDATE explicit_exclusions SET aliases_json = ? WHERE id = ?');
  for (const row of rows) {
    const existing = parseStringArray(row.aliases_json);
    const aliases = [...new Set([
      ...existing,
      normalizeLegacyKey(row.entity_key),
      ...(row.display_name ? [normalizeLegacyKey(row.display_name)] : [])
    ].filter(Boolean))];
    update.run(JSON.stringify(aliases), row.id);
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').map(normalizeLegacyKey)
      : [];
  } catch {
    return [];
  }
}

function compareMigratedEvidenceOrder(
  left: { observed_at: string; source_refs_json: string; created_at: string },
  right: { observed_at: string; source_refs_json: string; created_at: string }
): number {
  const observedDelta = Date.parse(left.observed_at) - Date.parse(right.observed_at);
  if (observedDelta !== 0) return observedDelta;
  const messageDelta = maximumSourceMessageId(left.source_refs_json)
    - maximumSourceMessageId(right.source_refs_json);
  if (messageDelta !== 0) return messageDelta;
  return Date.parse(left.created_at) - Date.parse(right.created_at);
}

function maximumSourceMessageId(value: string): number {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return -1;
  const ids = parsed.flatMap((ref) => (
    ref && typeof ref === 'object' && Number.isInteger((ref as { messageId?: unknown }).messageId)
      ? [Number((ref as { messageId: number }).messageId)]
      : []
  ));
  return ids.length > 0 ? Math.max(...ids) : -1;
}
