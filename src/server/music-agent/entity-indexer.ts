import type { NcmClient } from '../ncm/client.js';
import { listRecentListeningEpisodes } from '../store/listening-episodes.js';
import {
  upsertMusicEntity,
  upsertMusicEntityEmbedding,
  type UpsertMusicEntityInput
} from '../store/music-entities.js';
import {
  getMusicEntityIndexState,
  recordMusicEntityIndexError,
  recordMusicEntityIndexSuccess
} from '../store/music-entity-index-state.js';
import { getLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { EmbeddingClient, type EmbeddingResponse } from '../embedding/client.js';

export type EntityIndexSource = 'liked' | 'listening_episodes';

export type PlayedTrackInput = {
  songId: string;
  songName: string;
  artistName: string;
};

export type EntityIndexEmbeddingClient = {
  embed(input: string | string[], opts?: { signal?: AbortSignal }): Promise<EmbeddingResponse>;
};

export type EntityIndexNcmClient = Pick<NcmClient, 'getLikedSongIds' | 'getSongDetails'>;

export type MusicEntityIndexRunStatus = 'completed' | 'partial' | 'failed';

export type MusicEntityIndexRunResult = {
  status: MusicEntityIndexRunStatus;
  userId: string;
  sources: string[];
  sourceCounts: Record<string, number>;
  seenCount: number;
  upsertedCount: number;
  embeddedCount: number;
  skippedCount: number;
  errors: Record<string, string>;
  durationMs: number;
};

type LoggerLike = Pick<ReturnType<typeof getLogger>, 'debug' | 'info' | 'warn' | 'error'>;

type NcmTrackLike = {
  id?: string | number | null;
  name?: string | null;
  artists?: string[] | null;
};

type IndexedEntity = {
  source: EntityIndexSource | 'play_start';
  entity: UpsertMusicEntityInput;
};

type RunOptions = {
  userId: string;
  ncmClient: EntityIndexNcmClient;
  embeddingClient?: EntityIndexEmbeddingClient | null;
  sources?: EntityIndexSource[];
  limits?: {
    liked?: number;
    listeningEpisodes?: number;
  };
  logger?: LoggerLike;
};

type PlayedTrackOptions = {
  userId: string;
  track: PlayedTrackInput;
  embeddingClient?: EntityIndexEmbeddingClient | null;
  logger?: LoggerLike;
};

const DEFAULT_LIKED_LIMIT = 300;
const DEFAULT_LISTENING_EPISODES_LIMIT = 80;
const DEFAULT_INDEX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INDEX_ERROR_RETRY_MS = 30 * 60 * 1000;
const EMBEDDING_TIMEOUT_MS = 45_000;
const SCHEDULED_INDEX_SOURCES: EntityIndexSource[] = ['liked', 'listening_episodes'];

const inFlightIndex = new Set<string>();

export async function runMusicEntityIndex(options: RunOptions): Promise<MusicEntityIndexRunResult> {
  const logger = options.logger ?? getLogger();
  const userId = options.userId.trim();
  const sources = uniqueSources(options.sources ?? ['liked', 'listening_episodes']);
  const startedAtMs = Date.now();
  const sourceCounts: Record<string, number> = {};
  const errors: Record<string, string> = {};
  const entities: IndexedEntity[] = [];
  const loadedSources: LoadedSourceResult[] = [];

  logger.info({
    userId,
    sources,
    limits: {
      liked: resolveLimit(options.limits?.liked, DEFAULT_LIKED_LIMIT),
      listeningEpisodes: resolveLimit(
        options.limits?.listeningEpisodes,
        DEFAULT_LISTENING_EPISODES_LIMIT
      )
    }
  }, 'Music entity index run started');

  for (const source of sources) {
    const sourceStartedAtMs = Date.now();
    try {
      const sourceResult = source === 'liked'
        ? await loadLikedEntities({
          userId,
          ncmClient: options.ncmClient,
          limit: resolveLimit(options.limits?.liked, DEFAULT_LIKED_LIMIT)
        })
        : loadListeningEpisodeEntities({
          userId,
          limit: resolveLimit(
            options.limits?.listeningEpisodes,
            DEFAULT_LISTENING_EPISODES_LIMIT
          )
        });

      sourceCounts[source] = sourceResult.seenCount;
      entities.push(...sourceResult.entities);
      loadedSources.push({
        source,
        seenCount: sourceResult.seenCount,
        entityCount: sourceResult.entities.length,
        cursor: `${sourceResult.entities.length}/${sourceResult.seenCount}`,
        durationMs: Date.now() - sourceStartedAtMs
      });
      logger.info({
        userId,
        source,
        seenCount: sourceResult.seenCount,
        entityCount: sourceResult.entities.length,
        cursor: `${sourceResult.entities.length}/${sourceResult.seenCount}`,
        durationMs: Date.now() - sourceStartedAtMs
      }, 'Music entity index source loaded');
    } catch (err) {
      const message = errorMessage(err);
      errors[source] = message;
      recordMusicEntityIndexError({
        userId,
        source,
        error: message,
        ranAt: new Date().toISOString()
      });
      logger.error({
        err,
        userId,
        source,
        durationMs: Date.now() - sourceStartedAtMs
      }, 'Music entity index source failed');
    }
  }

  let persistResult: PersistResult;
  try {
    persistResult = await persistIndexedEntities({
      userId,
      entities,
      embeddingClient: resolveEmbeddingClient(options.embeddingClient),
      logger,
      logContext: { sources, sourceCounts },
      unavailableEmbeddingMessage: 'Music entity index embedding skipped: embedding client unavailable'
    });
  } catch (err) {
    const message = errorMessage(err);
    const ranAt = new Date().toISOString();
    for (const sourceResult of loadedSources) {
      errors[sourceResult.source] = message;
      recordMusicEntityIndexError({
        userId,
        source: sourceResult.source,
        error: message,
        ranAt
      });
    }
    logger.error({
      err,
      userId,
      sources: loadedSources.map((sourceResult) => sourceResult.source)
    }, 'Music entity index persistence failed');
    throw err;
  }
  const persistedAt = new Date().toISOString();
  for (const sourceResult of loadedSources) {
    recordMusicEntityIndexSuccess({
      userId,
      source: sourceResult.source,
      cursor: sourceResult.cursor,
      ranAt: persistedAt
    });
    logger.info({
      userId,
      source: sourceResult.source,
      seenCount: sourceResult.seenCount,
      entityCount: sourceResult.entityCount,
      cursor: sourceResult.cursor,
      durationMs: sourceResult.durationMs
    }, 'Music entity index source completed');
  }
  if (persistResult.embeddingError) {
    errors.embedding = persistResult.embeddingError;
  }

  const status = resolveRunStatus({
    requestedSourceCount: sources.length,
    errorCount: Object.keys(errors).length,
    upsertedCount: persistResult.upsertedCount
  });
  const result: MusicEntityIndexRunResult = {
    status,
    userId,
    sources,
    sourceCounts,
    seenCount: Object.values(sourceCounts).reduce((sum, count) => sum + count, 0),
    upsertedCount: persistResult.upsertedCount,
    embeddedCount: persistResult.embeddedCount,
    skippedCount: persistResult.skippedCount,
    errors,
    durationMs: Date.now() - startedAtMs
  };

  logger.info({
    ...result,
    embeddingModel: persistResult.embeddingModel
  }, 'Music entity index run completed');

  return result;
}

export function scheduleMusicEntityIndexIfDue(userId: string, ncmClient: EntityIndexNcmClient): void {
  const logger = getLogger();
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) return;

  if (inFlightIndex.has(normalizedUserId)) {
    logger.debug({ userId: normalizedUserId }, 'Music entity index schedule skipped: already in flight');
    return;
  }

  const sourceStates = SCHEDULED_INDEX_SOURCES.map((source) => ({
    source,
    state: getMusicEntityIndexState(normalizedUserId, source)
  }));
  const embeddingState = getMusicEntityIndexState(normalizedUserId, 'embedding');
  const intervalMs = getIndexRefreshIntervalMs();
  const errorRetryMs = getIndexErrorRetryMs();
  const dueSources = sourceStates
    .filter(({ state }) => !state || (!state.lastError && (!state.lastRunAt || isPastInterval(state.lastRunAt, intervalMs))))
    .map(({ source }) => source);
  const retryErrorSources = sourceStates
    .filter(({ state }) => state?.lastError && (!state.lastRunAt || isPastInterval(state.lastRunAt, errorRetryMs)))
    .map(({ source }) => source);
  const shouldRetryEmbeddingError = Boolean(
    embeddingState?.lastError && (!embeddingState.lastRunAt || isPastInterval(embeddingState.lastRunAt, errorRetryMs))
  );
  if (
    dueSources.length === 0
    && retryErrorSources.length === 0
    && !shouldRetryEmbeddingError
  ) {
    const recentErrorSources = sourceStates
      .filter(({ state }) => state?.lastError)
      .map(({ source }) => source);
    logger.debug({
      userId: normalizedUserId,
      sourceStates: sourceStates.map(({ source, state }) => ({
        source,
        lastRunAt: state?.lastRunAt ?? null,
        lastError: state?.lastError ?? null
      })),
      intervalMs,
      errorRetryMs,
      recentErrorSources
    }, recentErrorSources.length > 0
      ? 'Music entity index schedule skipped: recent source error'
      : 'Music entity index schedule skipped: not due');
    return;
  }

  inFlightIndex.add(normalizedUserId);
  logger.info({
    userId: normalizedUserId,
    sources: SCHEDULED_INDEX_SOURCES,
    intervalMs,
    errorRetryMs,
    reason: resolveScheduleReason({
      sourceStates,
      dueSources,
      retryErrorSources,
      embeddingState,
      shouldRetryEmbeddingError
    }),
    sourceStates: sourceStates.map(({ source, state }) => ({
      source,
      lastRunAt: state?.lastRunAt ?? null,
      lastError: state?.lastError ?? null
    })),
    lastEmbeddingError: embeddingState?.lastError ?? null
  }, 'Music entity index scheduled');

  void runMusicEntityIndex({
    userId: normalizedUserId,
    ncmClient,
    sources: SCHEDULED_INDEX_SOURCES,
    limits: {
      liked: getLikedIndexLimit(),
      listeningEpisodes: getListeningEpisodesIndexLimit()
    },
    logger
  }).catch((err) => {
    logger.error({ err, userId: normalizedUserId }, 'Music entity index scheduled run crashed');
  }).finally(() => {
    inFlightIndex.delete(normalizedUserId);
  });
}

export async function indexPlayedTrack(options: PlayedTrackOptions): Promise<MusicEntityIndexRunResult> {
  const logger = options.logger ?? getLogger();
  const startedAtMs = Date.now();
  const userId = options.userId.trim();
  const entity = buildEntityFromPlayedTrack(userId, options.track);

  logger.info({
    userId,
    songId: options.track.songId,
    songName: options.track.songName,
    hasArtistName: Boolean(options.track.artistName.trim())
  }, 'Music entity played-track index started');

  if (!entity) {
    const result = emptyResult({
      status: 'completed',
      userId,
      sources: ['play_start'],
      durationMs: Date.now() - startedAtMs
    });
    logger.warn({
      userId,
      songId: options.track.songId,
      songName: options.track.songName,
      durationMs: result.durationMs
    }, 'Music entity played-track index skipped: invalid track');
    return result;
  }

  const errors: Record<string, string> = {};
  let persistResult: PersistResult;
  try {
    persistResult = await persistIndexedEntities({
      userId,
      entities: [entity],
      embeddingClient: resolveEmbeddingClient(options.embeddingClient),
      logger,
      logContext: { sources: ['play_start'] },
      unavailableEmbeddingMessage: 'Music entity played-track embedding skipped: embedding client unavailable'
    });
    if (persistResult.embeddingError) {
      errors.embedding = persistResult.embeddingError;
    }
    recordMusicEntityIndexSuccess({
      userId,
      source: 'play_start',
      cursor: entity.entity.providerId ?? entity.entity.id,
      ranAt: new Date().toISOString()
    });
  } catch (err) {
    const message = errorMessage(err);
    errors.play_start = message;
    recordMusicEntityIndexError({
      userId,
      source: 'play_start',
      error: message,
      ranAt: new Date().toISOString()
    });
    logger.error({ err, userId, songId: options.track.songId }, 'Music entity played-track index failed');
    persistResult = {
      upsertedCount: 0,
      embeddedCount: 0,
      skippedCount: 1,
      embeddingModel: null
    };
  }

  const result: MusicEntityIndexRunResult = {
    status: resolveRunStatus({
      requestedSourceCount: 1,
      errorCount: Object.keys(errors).length,
      upsertedCount: persistResult.upsertedCount
    }),
    userId,
    sources: ['play_start'],
    sourceCounts: { play_start: 1 },
    seenCount: 1,
    upsertedCount: persistResult.upsertedCount,
    embeddedCount: persistResult.embeddedCount,
    skippedCount: persistResult.skippedCount,
    errors,
    durationMs: Date.now() - startedAtMs
  };
  logger.info({
    ...result,
    songId: options.track.songId,
    embeddingModel: persistResult.embeddingModel
  }, 'Music entity played-track index completed');
  return result;
}

export function _resetMusicEntityIndexSchedulerForTest(): void {
  inFlightIndex.clear();
}

type SourceLoadResult = {
  seenCount: number;
  entities: IndexedEntity[];
};

type LoadedSourceResult = {
  source: EntityIndexSource;
  seenCount: number;
  entityCount: number;
  cursor: string;
  durationMs: number;
};

async function loadLikedEntities(input: {
  userId: string;
  ncmClient: EntityIndexNcmClient;
  limit: number;
}): Promise<SourceLoadResult> {
  const likedIds = (await input.ncmClient.getLikedSongIds()).map(String);
  const selectedIds = likedIds.slice(0, input.limit);
  if (selectedIds.length === 0) {
    return { seenCount: 0, entities: [] };
  }

  const details = await input.ncmClient.getSongDetails(selectedIds);
  return {
    seenCount: selectedIds.length,
    entities: details
      .map((track) => buildEntityFromNcmTrack(input.userId, track, 'liked'))
      .filter((entity): entity is IndexedEntity => entity !== null)
  };
}

function loadListeningEpisodeEntities(input: {
  userId: string;
  limit: number;
}): SourceLoadResult {
  const episodes = listRecentListeningEpisodes(input.userId, input.limit);
  return {
    seenCount: episodes.length,
    entities: episodes
      .map((episode) => buildEntityFromPlayedTrack(input.userId, {
        songId: episode.track.id,
        songName: episode.track.name,
        artistName: episode.track.artists.join(' / ')
      }, 'listening_episodes'))
      .filter((entity): entity is IndexedEntity => entity !== null)
  };
}

function buildEntityFromNcmTrack(userId: string, track: NcmTrackLike, source: EntityIndexSource): IndexedEntity | null {
  const providerId = normalizeTrackId(track.id);
  const title = track.name?.trim() ?? '';
  const artist = normalizeArtists(track.artists);
  if (!userId || !providerId || !title) return null;

  return {
    source,
    entity: {
      userId,
      id: `ncm:track:${providerId}`,
      type: 'track',
      provider: 'ncm',
      providerId,
      title,
      artist,
      description: buildTrackDescription({ title, artist, source }),
      sourceSignals: source === 'liked'
        ? ['liked', 'verified_track', 'ncm', 'entity_indexer']
        : ['listening_episode', 'verified_play', 'ncm', 'entity_indexer'],
      lastVerifiedAt: new Date().toISOString()
    }
  };
}

function buildEntityFromPlayedTrack(
  userId: string,
  track: PlayedTrackInput,
  source: 'play_start' | 'listening_episodes' = 'play_start'
): IndexedEntity | null {
  const providerId = track.songId.trim();
  const title = track.songName.trim();
  const artist = track.artistName.trim() || null;
  if (!userId || !providerId || !title) return null;

  return {
    source,
    entity: {
      userId,
      id: `ncm:track:${providerId}`,
      type: 'track',
      provider: 'ncm',
      providerId,
      title,
      artist,
      description: buildTrackDescription({ title, artist, source }),
      sourceSignals: source === 'play_start'
        ? ['play_start', 'verified_play', 'ncm', 'entity_indexer']
        : ['listening_episode', 'verified_play', 'ncm', 'entity_indexer'],
      lastVerifiedAt: new Date().toISOString()
    }
  };
}

type PersistResult = {
  upsertedCount: number;
  embeddedCount: number;
  skippedCount: number;
  embeddingModel: string | null;
  embeddingError?: string;
};

async function persistIndexedEntities(input: {
  userId: string;
  entities: IndexedEntity[];
  embeddingClient: EntityIndexEmbeddingClient | null;
  logger: LoggerLike;
  logContext: Record<string, unknown>;
  unavailableEmbeddingMessage: string;
}): Promise<PersistResult> {
  const uniqueEntities = uniqueByEntityId(input.entities);
  let upsertedCount = 0;
  let skippedCount = 0;

  for (const item of uniqueEntities) {
    if (!item.entity.userId || !item.entity.id || !item.entity.description) {
      skippedCount += 1;
      continue;
    }
    upsertMusicEntity(item.entity);
    upsertedCount += 1;
  }

  if (upsertedCount === 0) {
    return {
      upsertedCount,
      embeddedCount: 0,
      skippedCount,
      embeddingModel: null
    };
  }

  if (!input.embeddingClient) {
    input.logger.warn({
      userId: input.userId,
      entityCount: upsertedCount,
      ...input.logContext
    }, input.unavailableEmbeddingMessage);
    return {
      upsertedCount,
      embeddedCount: 0,
      skippedCount,
      embeddingModel: null
    };
  }

  const embeddableEntities = uniqueEntities.filter((item) => item.entity.description.trim().length > 0);
  const descriptions = embeddableEntities.map((item) => item.entity.description);
  let embeddingResponse: EmbeddingResponse;
  try {
    embeddingResponse = await input.embeddingClient.embed(descriptions, {
      signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS)
    });
  } catch (err) {
    const message = errorMessage(err);
    recordMusicEntityIndexError({
      userId: input.userId,
      source: 'embedding',
      error: message,
      ranAt: new Date().toISOString()
    });
    input.logger.error({
      err,
      userId: input.userId,
      entityCount: embeddableEntities.length,
      ...input.logContext
    }, 'Music entity index embedding failed');
    return {
      upsertedCount,
      embeddedCount: 0,
      skippedCount: skippedCount + embeddableEntities.length,
      embeddingModel: null,
      embeddingError: message
    };
  }

  let embeddedCount = 0;
  for (const [index, item] of embeddableEntities.entries()) {
    const vector = embeddingResponse.vectors[index];
    if (!vector || vector.length === 0) {
      skippedCount += 1;
      continue;
    }
    upsertMusicEntityEmbedding({
      userId: input.userId,
      entityId: item.entity.id,
      model: embeddingResponse.model,
      vector
    });
    embeddedCount += 1;
  }
  recordMusicEntityIndexSuccess({
    userId: input.userId,
    source: 'embedding',
    cursor: `${embeddedCount}/${embeddableEntities.length}`,
    ranAt: new Date().toISOString()
  });

  input.logger.info({
    userId: input.userId,
    entityCount: upsertedCount,
    embeddedCount,
    embeddingModel: embeddingResponse.model,
    embeddingDimensions: embeddingResponse.dimensions,
    ...input.logContext
  }, 'Music entity index embedding completed');

  return {
    upsertedCount,
    embeddedCount,
    skippedCount,
    embeddingModel: embeddingResponse.model
  };
}

function resolveEmbeddingClient(input: EntityIndexEmbeddingClient | null | undefined): EntityIndexEmbeddingClient | null {
  if (input !== undefined) return input;
  try {
    const embeddingConfig = getConfig().embedding;
    return embeddingConfig ? new EmbeddingClient(embeddingConfig) : null;
  } catch {
    return null;
  }
}

function resolveRunStatus(input: {
  requestedSourceCount: number;
  errorCount: number;
  upsertedCount: number;
}): MusicEntityIndexRunStatus {
  if (input.errorCount === 0) return 'completed';
  if (input.errorCount >= input.requestedSourceCount && input.upsertedCount === 0) return 'failed';
  return 'partial';
}

function emptyResult(input: {
  status: MusicEntityIndexRunStatus;
  userId: string;
  sources: string[];
  durationMs: number;
}): MusicEntityIndexRunResult {
  return {
    status: input.status,
    userId: input.userId,
    sources: input.sources,
    sourceCounts: {},
    seenCount: 0,
    upsertedCount: 0,
    embeddedCount: 0,
    skippedCount: 0,
    errors: {},
    durationMs: input.durationMs
  };
}

function buildTrackDescription(input: {
  title: string;
  artist: string | null;
  source: EntityIndexSource | 'play_start';
}): string {
  const lines = [
    `track: ${input.title}`,
    input.artist ? `artist: ${input.artist}` : '',
    `source: ${input.source}`,
    'signals: verified_track, user_history'
  ];
  return lines.filter(Boolean).join('\n');
}

function normalizeTrackId(value: string | number | null | undefined): string {
  return String(value ?? '').trim();
}

function normalizeArtists(artists: string[] | null | undefined): string | null {
  const normalized = (artists ?? [])
    .map((artist) => artist.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized.join(' / ') : null;
}

function uniqueSources(sources: EntityIndexSource[]): EntityIndexSource[] {
  const result: EntityIndexSource[] = [];
  for (const source of sources) {
    if ((source === 'liked' || source === 'listening_episodes') && !result.includes(source)) {
      result.push(source);
    }
  }
  return result.length > 0 ? result : ['liked', 'listening_episodes'];
}

function uniqueByEntityId(entities: IndexedEntity[]): IndexedEntity[] {
  const seen = new Set<string>();
  const result: IndexedEntity[] = [];
  for (const entity of entities) {
    const key = `${entity.entity.userId}:${entity.entity.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entity);
  }
  return result;
}

function resolveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value && value > 0
    ? Math.max(1, Math.min(1_000, Math.floor(value)))
    : fallback;
}

function getIndexRefreshIntervalMs(): number {
  return resolveEnvPositiveInt('CROSSFADIO_MUSIC_ENTITY_INDEX_INTERVAL_MS', DEFAULT_INDEX_INTERVAL_MS);
}

function getIndexErrorRetryMs(): number {
  return resolveEnvPositiveInt('CROSSFADIO_MUSIC_ENTITY_INDEX_ERROR_RETRY_MS', DEFAULT_INDEX_ERROR_RETRY_MS);
}

function getLikedIndexLimit(): number {
  return resolveEnvPositiveInt('CROSSFADIO_MUSIC_ENTITY_INDEX_LIKED_LIMIT', DEFAULT_LIKED_LIMIT);
}

function getListeningEpisodesIndexLimit(): number {
  return resolveEnvPositiveInt(
    'CROSSFADIO_MUSIC_ENTITY_INDEX_LISTENING_EPISODES_LIMIT',
    DEFAULT_LISTENING_EPISODES_LIMIT
  );
}

function resolveEnvPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isPastInterval(lastRunAt: string, intervalMs: number): boolean {
  const lastRunMs = new Date(lastRunAt).getTime();
  return !Number.isFinite(lastRunMs) || Date.now() - lastRunMs >= intervalMs;
}

function resolveScheduleReason(input: {
  sourceStates: Array<{ source: EntityIndexSource; state: ReturnType<typeof getMusicEntityIndexState> }>;
  dueSources: EntityIndexSource[];
  retryErrorSources: EntityIndexSource[];
  embeddingState: ReturnType<typeof getMusicEntityIndexState>;
  shouldRetryEmbeddingError: boolean;
}): string {
  if (input.sourceStates.some(({ state }) => !state)) return 'first_run';
  if (input.retryErrorSources.length > 0) return `retry_source_error:${input.retryErrorSources.join(',')}`;
  if (input.shouldRetryEmbeddingError) return 'retry_embedding_error';
  if (input.embeddingState?.lastError) return 'embedding_error_pending';
  if (input.dueSources.length > 0) return `interval_due:${input.dueSources.join(',')}`;
  return 'interval_due';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
