import { addToQueue, getQueue } from '../store/queue.js';
import {
  buildTrackDedupeKey,
  isTrackDedupeKeyExcluded
} from './musicAgentPickNextResult.js';
import {
  appendQueueAppendEvents,
  ensureSelectionStartedEventSafely,
  queueTrackArtist,
  type DjSelectionEventContext
} from './eventLogging.js';
import { buildFinalSelectionResult } from './finalSelectionResult.js';
import { getRemainingPickSlots } from './pickNextQueueProgress.js';
import type { DiscoveryMode } from '../../shared/dj.js';
import type {
  DedupeState,
  DjEventSink,
  DjPickNextFallbackPath,
  DjPickNextRunMetrics,
  SkippedPickLog
} from './musicAgentPickNextResult.js';

type LegacyRandomFallbackTrackDetail = {
  id: string | number;
  name: string;
  artists: string[];
  coverImgUrl?: string | null;
};

type Logger = {
  warn(payload: Record<string, unknown>, message: string): void;
  info(payload: Record<string, unknown>, message: string): void;
};

type BroadcastAppended = (
  userId: string,
  prevQueueLength: number,
  targetPickCount: number,
  emit: DjEventSink,
  path?: DjPickNextFallbackPath,
  metrics?: DjPickNextRunMetrics
) => void;

export async function handleLegacyRandomFallback(input: {
  userId: string;
  allLikedIds: string[];
  excludeState: DedupeState;
  initialQueueLength: number;
  targetPickCount: number;
  startedAt: number;
  discoveryMode: DiscoveryMode;
  debugBroadcastSent: boolean;
  djEventContext?: DjSelectionEventContext;
  emit: DjEventSink;
  broadcastAppended: BroadcastAppended;
  logger: Logger;
  setPickReason(trackId: string, reason: string): void;
  recordFallbackStats(path: DjPickNextFallbackPath): unknown;
  sampleIds(ids: string[], count: number): string[];
  fetchSongDetails(ids: string[]): Promise<LegacyRandomFallbackTrackDetail[]>;
  signal?: AbortSignal;
}): Promise<void> {
  const {
    userId,
    allLikedIds,
    excludeState,
    initialQueueLength,
    targetPickCount,
    startedAt,
    discoveryMode,
    debugBroadcastSent,
    djEventContext,
    emit,
    broadcastAppended,
    logger,
    setPickReason,
    recordFallbackStats,
    sampleIds,
    fetchSongDetails,
    signal
  } = input;

  const fallbackIds = allLikedIds.filter((id) => !excludeState.ids.has(id));
  const excludedIdsAtStart = Array.from(excludeState.ids);
  const excludedDedupeKeysAtStart = Array.from(excludeState.dedupeKeys);

  if (fallbackIds.length === 0) {
    const fallbackStats = recordFallbackStats('no_candidates');
    logger.warn(
      {
        targetCount: targetPickCount,
        appendedCount: 0,
        fallbackStats
      },
      'DJ pick-next fallback: no candidates'
    );
    broadcastAppended(userId, initialQueueLength, targetPickCount, emit, undefined, {
      appendedTracks: [],
      agentPickCount: 0,
      rankedBackfillCount: 0,
      candidateCount: fallbackIds.length,
      elapsedMs: Date.now() - startedAt,
      fallbackPath: 'no_candidates',
      discoveryMode
    });
    return;
  }

  const fallbackSampleSize = Math.min(
    Math.max(targetPickCount, getRemainingPickSlots(userId, initialQueueLength, targetPickCount) * 4),
    fallbackIds.length
  );
  const pickedIds = sampleIds(fallbackIds, fallbackSampleSize);
  const pickedDetails = (await fetchSongDetails(pickedIds)).filter((track) => track.artists.length > 0);
  if (signal?.aborted) return;

  if (pickedDetails.length === 0) {
    if (!debugBroadcastSent) {
      emit({
        type: 'dj.debug',
        likedSample: [],
        sqRaw: '',
        searchQueries: [],
        searchedTracks: [],
        excludedIds: excludedIdsAtStart,
        excludedDedupeKeys: excludedDedupeKeysAtStart,
        totalCandidates: fallbackIds.length,
        selectedTracks: [],
        selectedSay: '随机 fallback 未找到可追加歌曲。'
      });
    }
    const fallbackStats = recordFallbackStats('legacy_random_fallback');
    logger.warn(
      {
        targetCount: targetPickCount,
        appendedCount: 0,
        fallbackStats
      },
      'DJ pick-next fallback: failed to fetch track details'
    );
    broadcastAppended(userId, initialQueueLength, targetPickCount, emit, undefined, {
      appendedTracks: [],
      agentPickCount: 0,
      rankedBackfillCount: 0,
      candidateCount: fallbackIds.length,
      elapsedMs: Date.now() - startedAt,
      fallbackPath: 'legacy_random_fallback',
      discoveryMode
    });
    return;
  }

  const pathQueueLength = getQueue(userId).length;
  const randomSkippedPicks: SkippedPickLog[] = [];
  const appendedFallbackTracks: ReturnType<typeof getQueue> = [];
  for (const pick of pickedDetails) {
    const pickTrack = {
      id: String(pick.id),
      name: pick.name,
      artist: pick.artists.join(' / ')
    };
    const dedupeKey = buildTrackDedupeKey(pickTrack);
    if (getRemainingPickSlots(userId, initialQueueLength, targetPickCount) <= 0) {
      randomSkippedPicks.push({ ...pickTrack, reason: 'no_remaining_slots', dedupeKey });
      continue;
    }
    const currentQueue = getQueue(userId);
    if (currentQueue.some((track) => track.ncmId === pickTrack.id) || excludeState.ids.has(pickTrack.id)) {
      randomSkippedPicks.push({ ...pickTrack, reason: 'id_excluded', dedupeKey });
      continue;
    }
    const currentQueueDedupeKeys = new Set(currentQueue.map((track) => buildTrackDedupeKey({
      id: track.ncmId,
      name: track.name,
      artists: track.artists
    })));
    if (isTrackDedupeKeyExcluded(dedupeKey, currentQueueDedupeKeys)
      || isTrackDedupeKeyExcluded(dedupeKey, excludeState.dedupeKeys)) {
      randomSkippedPicks.push({ ...pickTrack, reason: 'dedupe_excluded', dedupeKey });
      continue;
    }
    addToQueue(userId, {
      ncmId: String(pick.id),
      name: pick.name,
      artists: pick.artists,
      coverImgUrl: pick.coverImgUrl
    }, 'end');
    const actuallyAppended = getQueue(userId).find((track) => track.ncmId === pickTrack.id);
    if (!actuallyAppended) {
      randomSkippedPicks.push({ ...pickTrack, reason: 'id_excluded', dedupeKey });
      continue;
    }
    appendedFallbackTracks.push({
      ...actuallyAppended,
      ...(actuallyAppended.artists ? { artists: [...actuallyAppended.artists] } : {})
    });
    excludeState.ids.add(pickTrack.id);
    if (dedupeKey) excludeState.dedupeKeys.add(dedupeKey);
  }
  if (appendedFallbackTracks.length > 0) {
    const fallbackRationale = '随机 fallback（LLM 未配置或选歌失败）';
    const finalSelection = buildFinalSelectionResult({
      tracks: appendedFallbackTracks.map((track) => ({
        id: track.ncmId,
        name: track.name,
        artist: queueTrackArtist(track),
        reason: 'Selected by legacy random fallback from liked tracks.',
        source: 'legacy_random_fallback'
      })),
      proposedRationale: fallbackRationale,
      diagnostics: {
        targetCount: targetPickCount,
        requestedPickCount: pickedDetails.length,
        skippedPicks: randomSkippedPicks
      }
    });
    for (const track of finalSelection.tracks) {
      setPickReason(track.id, track.reason);
    }
    emit({
      type: 'dj.debug',
      likedSample: [],
      sqRaw: '',
      searchQueries: [],
      searchedTracks: [],
      excludedIds: excludedIdsAtStart,
      excludedDedupeKeys: excludedDedupeKeysAtStart,
      totalCandidates: fallbackIds.length,
      selectedTracks: finalSelection.tracks,
      selectedSay: finalSelection.rationale
    });
    const eventContext = ensureSelectionStartedEventSafely({
      userId,
      targetPickCount,
      context: djEventContext
    }, logger);
    try {
      appendQueueAppendEvents({
        userId,
        context: eventContext,
        finalSelection
      });
    } catch (err) {
      logger.warn(
        { err, runId: eventContext.runId },
        'DJ pick-next: selection event persistence failed'
      );
    }
  }
  logger.info(
    {
      targetCount: targetPickCount,
      appendedCount: getQueue(userId).length - initialQueueLength,
      fallbackAppendedCount: getQueue(userId).length - pathQueueLength,
      sampledCount: pickedIds.length,
      fallbackStats: recordFallbackStats('legacy_random_fallback')
    },
    'DJ pick-next fallback: appended tracks'
  );
  broadcastAppended(userId, initialQueueLength, targetPickCount, emit, undefined, {
    appendedTracks: appendedFallbackTracks,
    agentPickCount: 0,
    rankedBackfillCount: 0,
    candidateCount: fallbackIds.length,
    elapsedMs: Date.now() - startedAt,
    fallbackPath: 'legacy_random_fallback',
    discoveryMode
  });
}
