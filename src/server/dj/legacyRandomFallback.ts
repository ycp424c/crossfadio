import { addToQueue, getQueue } from '../store/queue.js';
import {
  buildTrackDedupeKey,
  isTrackDedupeKeyExcluded
} from './musicAgentPickNextResult.js';
import {
  appendQueueAppendEvents,
  ensureSelectionStartedEvent,
  queueTrackArtist,
  type DjSelectionEventContext
} from './eventLogging.js';
import { getAddedTrackCount, getRemainingPickSlots } from './pickNextQueueProgress.js';
import type { DiscoveryMode } from '../../shared/dj.js';
import type {
  DedupeState,
  DjEventSink,
  DjPickNextFallbackPath,
  DjPickNextRunMetrics
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
    recordFallbackStats,
    sampleIds,
    fetchSongDetails,
    signal
  } = input;

  const fallbackIds = allLikedIds.filter((id) => !excludeState.ids.has(id));

  if (fallbackIds.length === 0) {
    const appendedCount = getAddedTrackCount(userId, initialQueueLength);
    logger.warn(
      {
        targetCount: targetPickCount,
        appendedCount,
        fallbackStats: recordFallbackStats('no_candidates')
      },
      'DJ pick-next fallback: no candidates'
    );
    if (appendedCount > 0) {
      broadcastAppended(userId, initialQueueLength, targetPickCount, emit, undefined, {
        agentPickCount: 0,
        rankedBackfillCount: 0,
        candidateCount: fallbackIds.length,
        elapsedMs: Date.now() - startedAt,
        fallbackPath: 'no_candidates',
        discoveryMode
      });
    } else {
      emit({ type: 'dj.pick-next.done', added: false, reason: 'no-candidates' });
    }
    return;
  }

  if (!debugBroadcastSent) {
    emit({
      type: 'dj.debug',
      likedSample: [],
      sqRaw: '',
      searchQueries: [],
      searchedTracks: [],
      excludedIds: Array.from(excludeState.ids),
      excludedDedupeKeys: Array.from(excludeState.dedupeKeys),
      totalCandidates: fallbackIds.length,
      selectedSay: '随机 fallback（LLM 未配置或选歌失败）'
    });
  }

  const fallbackSampleSize = Math.min(
    Math.max(targetPickCount, getRemainingPickSlots(userId, initialQueueLength, targetPickCount) * 4),
    fallbackIds.length
  );
  const pickedIds = sampleIds(fallbackIds, fallbackSampleSize);
  const pickedDetails = (await fetchSongDetails(pickedIds)).filter((track) => {
    if (track.artists.length === 0) return false;
    return !isTrackDedupeKeyExcluded(buildTrackDedupeKey({
      id: String(track.id),
      name: track.name,
      artist: track.artists.join(' / ')
    }), excludeState.dedupeKeys);
  });
  if (signal?.aborted) return;

  if (pickedDetails.length === 0) {
    const appendedCount = getQueue(userId).length - initialQueueLength;
    logger.warn(
      {
        targetCount: targetPickCount,
        appendedCount,
        fallbackStats: recordFallbackStats('legacy_random_fallback')
      },
      'DJ pick-next fallback: failed to fetch track details'
    );
    if (appendedCount > 0) {
      broadcastAppended(userId, initialQueueLength, targetPickCount, emit, undefined, {
        agentPickCount: 0,
        rankedBackfillCount: 0,
        candidateCount: fallbackIds.length,
        elapsedMs: Date.now() - startedAt,
        fallbackPath: 'legacy_random_fallback',
        discoveryMode
      });
    } else {
      emit({ type: 'dj.pick-next.done', added: false, reason: 'no-candidates' });
    }
    return;
  }

  const pathQueueLength = getQueue(userId).length;
  for (const pick of pickedDetails) {
    if (getRemainingPickSlots(userId, initialQueueLength, targetPickCount) <= 0) break;
    const dedupeKey = buildTrackDedupeKey({
      id: String(pick.id),
      name: pick.name,
      artists: pick.artists
    });
    if (isTrackDedupeKeyExcluded(dedupeKey, excludeState.dedupeKeys)) continue;
    addToQueue(userId, {
      ncmId: String(pick.id),
      name: pick.name,
      artists: pick.artists,
      coverImgUrl: pick.coverImgUrl
    }, 'end');
    excludeState.ids.add(String(pick.id));
    if (dedupeKey) excludeState.dedupeKeys.add(dedupeKey);
  }
  const pathNewTracks = getQueue(userId).slice(pathQueueLength);
  if (pathNewTracks.length > 0) {
    const fallbackRationale = '随机 fallback（LLM 未配置或选歌失败）';
    const eventContext = ensureSelectionStartedEvent({
      userId,
      targetPickCount,
      context: djEventContext,
      batchRationale: fallbackRationale
    });
    appendQueueAppendEvents({
      userId,
      context: eventContext,
      tracks: pathNewTracks.map((track, index) => ({
        id: track.ncmId,
        name: track.name,
        artist: queueTrackArtist(track),
        selectionRationale: 'Selected by legacy random fallback from liked tracks.',
        batchRationale: fallbackRationale,
        source: 'legacy_random_fallback',
        pickOrder: index + 1
      }))
    });
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
    agentPickCount: 0,
    rankedBackfillCount: 0,
    candidateCount: fallbackIds.length,
    elapsedMs: Date.now() - startedAt,
    fallbackPath: 'legacy_random_fallback',
    discoveryMode
  });
}
