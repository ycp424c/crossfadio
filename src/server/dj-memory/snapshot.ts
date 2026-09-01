import { randomUUID } from 'node:crypto';
import { getCurrentIndex, getQueue, type QueueTrack } from '../store/queue.js';
import { listListeningEpisodesInWindow } from '../store/listening-episodes.js';
import { getEffectivePreferenceSignals } from '../store/preference-evidence.js';
import { getCurrentTasteProfile } from '../store/taste-profiles.js';
import { getPref } from '../store/prefs.js';
import { listActiveExplicitExclusions } from '../store/explicit-exclusions.js';
import { getActiveTemporaryQueueBans } from '../store/temporary-bans.js';
import { getCurrentPersonalDjContext } from '../store/personal-dj-context.js';
import { listRecentRetrievalAttempts } from '../store/retrieval-attempts.js';
import { listDjConfigurationEntries } from '../store/dj-configuration.js';
import { getRecentDjEvents } from '../store/dj-events.js';
import { getSelectionRotationSnapshot } from '../store/selection-rotation.js';
import { listSourceReservoir } from '../store/source-reservoir.js';
import { fetchWeather } from '../weather.js';
import { getDailyTheme } from '../daily-theme.js';
import { getDaypart, getShanghaiTimeParts } from '../timezone.js';
import { parseDiscoveryMode } from '../../shared/dj.js';
import { deriveListeningSignals } from '../listening/listening-signals.js';
import { primaryArtistKey } from '../music-agent/artists.js';
import { buildMusicTrackDedupeKey } from '../music-agent/dedupe.js';
import {
  SELECTION_PRESSURE_HALF_LIFE_DAYS,
  SELECTION_PRESSURE_WINDOW_DAYS
} from '../music-agent/selection-pressure.js';
import { buildDjSessionContinuity, type DjSessionEventInput } from './session-continuity.js';
import {
  DJ_MEMORY_LISTENING_EPISODE_LIMIT,
  DJ_MEMORY_SELECTION_PRESSURE_LIMIT,
  DJ_MEMORY_UPCOMING_TRACK_LIMIT,
  djMemorySnapshotSchema,
  type DjMemorySnapshot
} from './schema.js';

type ActiveDirective = { text: string; expiresAt: string };
type SnapshotDeps = {
  loadQueue: (userId: string) => Promise<{ queue: QueueTrack[]; currentIndex: number }>;
  loadEpisodes: (userId: string, now: Date) => Promise<DjMemorySnapshot['listeningEpisodes']>;
  loadRotation: (userId: string) => Promise<DjMemorySnapshot['rotation']>;
  loadPreferenceEvidence: (userId: string, now: Date) => Promise<DjMemorySnapshot['preferences']>;
  loadTasteProfile: (userId: string) => Promise<DjMemorySnapshot['tasteProfile']>;
  loadActiveDirective: (userId: string, now: Date) => Promise<ActiveDirective | null>;
  loadExclusions: (userId: string, now: Date) => Promise<{
    explicit: DjMemorySnapshot['explicitExclusions'];
    temporary: DjMemorySnapshot['temporaryExclusions'];
  }>;
  loadPersonalContext: (userId: string, now: Date) => Promise<DjMemorySnapshot['personalContext']>;
  loadRetrievalHistory: (userId: string, now: Date) => Promise<DjMemorySnapshot['retrievalHistory']>;
  loadSourceReservoir: (userId: string, now: Date) => Promise<DjMemorySnapshot['sourceReservoir']>;
  loadConfiguration: (userId: string) => Promise<DjMemorySnapshot['configuration']>;
  loadSelectionContext: (userId: string) => Promise<DjMemorySnapshot['selectionContext']>;
  loadSessionEvents: (userId: string) => Promise<DjSessionEventInput[]>;
  loadWeather: (userId: string) => Promise<DjMemorySnapshot['weather']>;
};

export async function buildDjMemorySnapshot(input: {
  userId: string;
  now?: Date;
  selectionOptions?: {
    discoveryMode: DjMemorySnapshot['selectionContext']['discoveryMode'];
    includeDailyTheme: boolean;
  };
  deps?: SnapshotDeps;
}): Promise<DjMemorySnapshot> {
  const now = input.now ?? new Date();
  const loadedAt = now.toISOString();
  const deps = input.deps ?? defaultDeps;
  const [
    queueState,
    loadedListeningEpisodes,
    rotation,
    preferences,
    tasteProfile,
    activeDirective,
    exclusions,
    personalContext,
    retrievalHistory,
    sourceReservoir,
    configuration,
    loadedSelectionContext,
    events,
    weather
  ] = await Promise.all([
    deps.loadQueue(input.userId),
    deps.loadEpisodes(input.userId, now),
    deps.loadRotation(input.userId),
    deps.loadPreferenceEvidence(input.userId, now),
    deps.loadTasteProfile(input.userId),
    deps.loadActiveDirective(input.userId, now),
    deps.loadExclusions(input.userId, now),
    deps.loadPersonalContext(input.userId, now),
    deps.loadRetrievalHistory(input.userId, now),
    deps.loadSourceReservoir(input.userId, now),
    deps.loadConfiguration(input.userId),
    deps.loadSelectionContext(input.userId),
    deps.loadSessionEvents(input.userId),
    deps.loadWeather(input.userId)
  ]);

  const currentTrack = queueState.queue[queueState.currentIndex]
    ? mapTrack(queueState.queue[queueState.currentIndex])
    : null;
  const upcoming = queueState.queue
    .slice(
      queueState.currentIndex + 1,
      queueState.currentIndex + 1 + DJ_MEMORY_UPCOMING_TRACK_LIMIT
    )
    .map(mapTrack);
  const sessionLog = mergeContinuity(events, now);
  const pressureEpisodes = loadedListeningEpisodes.filter((episode) =>
    isEpisodeInSnapshotWindow(episode, now)
  );
  if (pressureEpisodes.length > DJ_MEMORY_SELECTION_PRESSURE_LIMIT) {
    throw new Error(
      `DJ Memory pressure episode limit exceeded: ${pressureEpisodes.length}`
    );
  }
  const listeningEpisodes = pressureEpisodes.slice(0, DJ_MEMORY_LISTENING_EPISODE_LIMIT);
  const selectionPressure = aggregateSelectionPressure(pressureEpisodes, now);
  const temporaryExclusions = mergeTemporaryExclusions([
    ...exclusions.temporary,
    ...temporaryExclusionsFromEpisodes(pressureEpisodes, now)
  ]);
  const selectionContext = input.selectionOptions ? {
    discoveryMode: input.selectionOptions.discoveryMode,
    dailyTheme: input.selectionOptions.includeDailyTheme
      ? loadedSelectionContext.dailyTheme
      : null
  } : loadedSelectionContext;

  return djMemorySnapshotSchema.parse({
    metadata: {
      schemaVersion: 1,
      snapshotId: randomUUID(),
      userId: input.userId,
      assembledAt: loadedAt,
      sources: [
        source('queue', 'authoritative', count(currentTrack) + upcoming.length, loadedAt),
        source('listening_episodes', 'authoritative', pressureEpisodes.length, loadedAt),
        source('selection_rotation', 'authoritative', rotation.picks.length, loadedAt),
        source('preference_evidence', 'derived', preferences.length, loadedAt),
        source('active_directive', 'authoritative', count(activeDirective), loadedAt, activeDirective?.expiresAt),
        source('explicit_exclusions', 'authoritative', exclusions.explicit.length, loadedAt),
        source('temporary_queue_exclusions', 'derived', temporaryExclusions.length, loadedAt),
        source('personal_dj_context', 'advisory', count(personalContext), loadedAt, personalContext?.expiresAt),
        source('taste_profile', 'derived', count(tasteProfile), loadedAt),
        source('retrieval_history', 'operational', retrievalHistory.length, loadedAt),
        source(
          'source_reservoir',
          'operational',
          sourceReservoir.reduce((count, item) => count + item.tracks.length, 0),
          loadedAt,
          sourceReservoir.map((item) => item.expiresAt).sort()[0]
        ),
        source('dj_configuration', 'authoritative', configuration.length + 1, loadedAt),
        source('dj_session_log', 'continuity', sessionLog.length, loadedAt),
        source('current_moment', 'authoritative', 1, loadedAt),
        source('daily_theme', 'advisory', count(selectionContext.dailyTheme), loadedAt),
        source('weather', 'advisory', count(weather), loadedAt)
      ]
    },
    queue: { currentTrack, upcoming },
    listeningEpisodes,
    selectionPressure,
    rotation,
    preferences,
    tasteProfile,
    activeDirective,
    explicitExclusions: exclusions.explicit,
    temporaryExclusions,
    personalContext,
    retrievalHistory,
    sourceReservoir,
    configuration,
    selectionContext,
    sessionLog,
    currentMoment: currentMoment(now),
    weather
  });
}

function isEpisodeInSnapshotWindow(
  episode: DjMemorySnapshot['listeningEpisodes'][number],
  now: Date
): boolean {
  const nowMs = now.getTime();
  const startedAtMs = Date.parse(episode.startedAt);
  if (
    !Number.isFinite(startedAtMs)
    || startedAtMs > nowMs
    || startedAtMs < nowMs - SELECTION_PRESSURE_WINDOW_DAYS * 86_400_000
  ) {
    return false;
  }
  if (!episode.endedAt) return true;
  const endedAtMs = Date.parse(episode.endedAt);
  return Number.isFinite(endedAtMs) && endedAtMs <= nowMs;
}

const defaultDeps: SnapshotDeps = {
  loadQueue: async (userId) => ({ queue: getQueue(userId), currentIndex: getCurrentIndex(userId) }),
  loadEpisodes: async (userId, now) => loadRecentEpisodes(userId, now),
  loadRotation: async (userId) => getSelectionRotationSnapshot(userId),
  loadPreferenceEvidence: async (userId, now) => loadEffectivePreferences(userId, now),
  loadTasteProfile: async (userId) => {
    const item = getCurrentTasteProfile(userId);
    return item ? {
      id: item.id,
      version: item.version,
      summary: item.profile.summary,
      generatedAt: item.generatedAt
    } : null;
  },
  loadActiveDirective: async (userId, now) => {
    const directive = getPref<Partial<ActiveDirective>>(userId, 'queue.activeDirective');
    if (!directive?.text?.trim() || !directive.expiresAt) return null;
    if (Date.parse(directive.expiresAt) <= now.getTime()) return null;
    return { text: directive.text.trim(), expiresAt: new Date(directive.expiresAt).toISOString() };
  },
  loadExclusions: async (userId, now) => ({
    explicit: listActiveExplicitExclusions(userId).map((item) => ({
      id: item.id,
      entityType: item.entityType,
      entityKey: item.entityKey,
      provider: item.provider,
      providerId: item.providerId,
      displayName: item.displayName
    })),
    temporary: getActiveTemporaryQueueBans(userId, now).map((item) => ({
      id: item.id,
      name: item.name ?? '',
      artists: item.artists ?? [],
      expiresAt: item.expiresAt
    }))
  }),
  loadPersonalContext: async (userId, now) => {
    const item = getCurrentPersonalDjContext(userId, now);
    return item ? {
      id: item.id,
      expiresAt: item.expiresAt,
      summary: item.payload.summary,
      currentState: item.payload.currentState,
      musicGuidance: item.payload.musicGuidance,
      musicHints: item.payload.musicHints,
      segueGuidance: item.payload.segueGuidance
    } : null;
  },
  loadRetrievalHistory: async (userId, now) => listRecentRetrievalAttempts({ userId, now }).map((item) => ({
    query: item.displayQuery,
    source: item.source,
    selectedCount: item.selectedCount,
    attemptedAt: item.attemptedAt
  })),
  loadSourceReservoir: async (userId, now) => listSourceReservoir({ userId, now }),
  loadConfiguration: async (userId) => listDjConfigurationEntries(userId).map((item) => ({
    id: item.id,
    kind: item.kind,
    key: item.entryKey,
    value: item.value
  })),
  loadSelectionContext: async (userId) => {
    const dailyThemeEnabled = getPref<boolean>(userId, 'dailyTheme.enabled') !== false;
    const theme = dailyThemeEnabled ? getDailyTheme() : null;
    return {
      discoveryMode: parseDiscoveryMode(getPref(userId, 'discovery.mode')),
      dailyTheme: theme ? { theme: theme.theme, keywords: theme.keywords } : null
    };
  },
  loadSessionEvents: async (userId) => getRecentDjEvents(userId, 100).map((item) => ({
    id: item.id,
    type: item.type,
    createdAt: item.createdAt,
    payload: item.payload
  })),
  loadWeather: async (userId) => fetchWeather(userId)
};

export function loadEffectivePreferences(
  userId: string,
  now: Date
): DjMemorySnapshot['preferences'] {
  return getEffectivePreferenceSignals(userId, { now }).slice(0, 100).map((item) => ({
    id: item.evidenceIds[0] ?? `${item.subjectType}:${item.subjectKey}:${item.polarity}`,
    kind: item.evidenceKind,
    subjectType: item.subjectType,
    subjectKey: item.subjectKey,
    polarity: item.polarity,
    score: item.score,
    observedAt: item.observedAt,
    evidenceIds: item.evidenceIds
  }));
}

function loadRecentEpisodes(userId: string, now: Date): DjMemorySnapshot['listeningEpisodes'] {
  const cutoff = new Date(now.getTime() - SELECTION_PRESSURE_WINDOW_DAYS * 86_400_000);
  return listListeningEpisodesInWindow(userId, {
    since: cutoff,
    until: now,
    limit: DJ_MEMORY_SELECTION_PRESSURE_LIMIT + 1
  }).map((episode) => ({
    id: episode.id,
    trackId: episode.track.id,
    trackName: episode.track.name,
    primaryArtist: episode.track.primaryArtist,
    positionMs: episode.positionMs,
    listenedMs: episode.listenedMs,
    durationMs: episode.durationMs,
    outcome: episode.outcome,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt,
    legacyExposureOverride: episode.legacyExposureOverride
  }));
}

function aggregateSelectionPressure(
  episodes: DjMemorySnapshot['listeningEpisodes'],
  now: Date
): DjMemorySnapshot['selectionPressure'] {
  type TrackAggregate = DjMemorySnapshot['selectionPressure']['tracks'][number];
  type ArtistAggregate = DjMemorySnapshot['selectionPressure']['artists'][number] & {
    earlySkipWeightsByTrack: Map<string, number>;
  };
  const tracks = new Map<string, TrackAggregate>();
  const artists = new Map<string, ArtistAggregate>();

  for (const episode of episodes) {
    if (!episode.outcome) continue;
    const occurredAt = Date.parse(episode.startedAt);
    if (!Number.isFinite(occurredAt) || occurredAt > now.getTime()) continue;
    const ageDays = (now.getTime() - occurredAt) / 86_400_000;
    if (ageDays > SELECTION_PRESSURE_WINDOW_DAYS) continue;
    const primaryArtist = primaryArtistKey(episode.primaryArtist ?? '');
    const trackKey = buildMusicTrackDedupeKey({
      name: episode.trackName,
      artist: episode.primaryArtist ?? ''
    });
    if (!trackKey) continue;
    const weight = Math.pow(0.5, ageDays / SELECTION_PRESSURE_HALF_LIFE_DAYS);
    const signals = deriveListeningSignals({
      outcome: episode.outcome,
      durationMs: episode.durationMs,
      positionMs: episode.positionMs ?? episode.listenedMs,
      listenedMs: episode.listenedMs,
      legacyExposureOverride: episode.legacyExposureOverride
    });
    const track = tracks.get(trackKey) ?? {
      trackKey,
      primaryArtist,
      earlySkipObservationCount: 0,
      earlySkipEffectiveCount: 0,
      latestEarlySkipAt: null,
      exposureEffective: 0
    };
    const artist = artists.get(primaryArtist) ?? {
      primaryArtist,
      earlySkipDistinctTrackCount: 0,
      earlySkipEffectiveCount: 0,
      exposureEffective: 0,
      earlySkipWeightsByTrack: new Map<string, number>()
    };
    track.exposureEffective += weight * signals.exposure;
    artist.exposureEffective += weight * signals.exposure;
    if (signals.earlySkip) {
      track.earlySkipObservationCount += 1;
      track.earlySkipEffectiveCount += weight;
      if (!track.latestEarlySkipAt || occurredAt > Date.parse(track.latestEarlySkipAt)) {
        track.latestEarlySkipAt = episode.startedAt;
      }
      artist.earlySkipWeightsByTrack.set(
        trackKey,
        Math.max(artist.earlySkipWeightsByTrack.get(trackKey) ?? 0, weight)
      );
    }
    tracks.set(trackKey, track);
    artists.set(primaryArtist, artist);
  }

  return {
    tracks: [...tracks.values()].map((item) => ({
      ...item,
      earlySkipEffectiveCount: roundPressure(item.earlySkipEffectiveCount),
      exposureEffective: roundPressure(item.exposureEffective)
    })).sort((left, right) => left.trackKey.localeCompare(right.trackKey)),
    artists: [...artists.values()].map(({ earlySkipWeightsByTrack, ...item }) => ({
      ...item,
      earlySkipDistinctTrackCount: earlySkipWeightsByTrack.size,
      earlySkipEffectiveCount: roundPressure([...earlySkipWeightsByTrack.values()].reduce(
        (total, value) => total + value,
        0
      )),
      exposureEffective: roundPressure(item.exposureEffective)
    })).sort((left, right) => left.primaryArtist.localeCompare(right.primaryArtist))
  };
}

function roundPressure(value: number): number {
  return Number(value.toFixed(8));
}

function temporaryExclusionsFromEpisodes(
  episodes: DjMemorySnapshot['listeningEpisodes'],
  now: Date
): DjMemorySnapshot['temporaryExclusions'] {
  const ttlMs = 24 * 60 * 60 * 1_000;
  return episodes.flatMap((episode) => {
    if (episode.outcome !== 'skipped') return [];
    const signals = deriveListeningSignals({
      outcome: episode.outcome,
      durationMs: episode.durationMs,
      positionMs: episode.positionMs ?? episode.listenedMs,
      listenedMs: episode.listenedMs,
      legacyExposureOverride: episode.legacyExposureOverride
    });
    if (!signals.earlySkip) return [];
    const occurredAt = Date.parse(episode.endedAt ?? episode.startedAt);
    if (!Number.isFinite(occurredAt) || occurredAt > now.getTime()) return [];
    const expiresAtMs = occurredAt + ttlMs;
    if (expiresAtMs <= now.getTime()) return [];
    return [{
      id: episode.trackId,
      name: episode.trackName,
      artists: episode.primaryArtist ? [episode.primaryArtist] : [],
      expiresAt: new Date(expiresAtMs).toISOString()
    }];
  });
}

function mergeTemporaryExclusions(
  exclusions: DjMemorySnapshot['temporaryExclusions']
): DjMemorySnapshot['temporaryExclusions'] {
  const byTrackId = new Map<string, DjMemorySnapshot['temporaryExclusions'][number]>();
  for (const exclusion of exclusions) {
    const current = byTrackId.get(exclusion.id);
    if (!current || Date.parse(exclusion.expiresAt) > Date.parse(current.expiresAt)) {
      byTrackId.set(exclusion.id, exclusion);
    }
  }
  return [...byTrackId.values()]
    .sort((left, right) => Date.parse(right.expiresAt) - Date.parse(left.expiresAt))
    .slice(0, 100);
}

function mergeContinuity(events: DjSessionEventInput[], now: Date): DjMemorySnapshot['sessionLog'] {
  const merged = [
    ...buildDjSessionContinuity(events, 'selection', now),
    ...buildDjSessionContinuity(events, 'segue', now),
    ...buildDjSessionContinuity(events, 'chat', now).filter((item) => item.kind !== 'directive_history')
  ];
  const byIdKind = new Map(merged.map((item) => [`${item.id}:${item.kind}`, item]));
  return [...byIdKind.values()]
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
    .slice(0, 20);
}

function mapTrack(track: QueueTrack): DjMemorySnapshot['queue']['upcoming'][number] {
  return {
    id: track.ncmId,
    name: track.name ?? track.query ?? '',
    artists: track.artists ?? [],
    ...(track.durationMs !== undefined ? { durationMs: track.durationMs } : {}),
    ...(track.coverImgUrl !== undefined ? { coverImgUrl: track.coverImgUrl } : {})
  };
}

function currentMoment(now: Date): DjMemorySnapshot['currentMoment'] {
  const { hour, minute } = getShanghaiTimeParts(now);
  const localTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const daypart = getDaypart(hour);
  return { iso: now.toISOString(), localTime, daypart };
}

function source(
  kind: DjMemorySnapshot['metadata']['sources'][number]['kind'],
  authority: DjMemorySnapshot['metadata']['sources'][number]['authority'],
  recordCount: number,
  loadedAt: string,
  expiresAt?: string
): DjMemorySnapshot['metadata']['sources'][number] {
  return {
    id: `${kind}:${loadedAt}`,
    kind,
    authority,
    freshness: expiresAt && Date.parse(expiresAt) <= Date.parse(loadedAt) ? 'expired' : 'fresh',
    loadedAt,
    ...(expiresAt ? { expiresAt } : {}),
    recordCount
  };
}

function count(value: unknown): number {
  return value === null || value === undefined ? 0 : 1;
}
