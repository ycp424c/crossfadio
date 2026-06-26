import type { Track } from '../agent/schema.js';
import { addToQueue, getQueue } from '../store/queue.js';
import {
  buildTrackDedupeKey,
  createSkippedPickLog,
  isTrackDedupeKeyExcluded
} from './musicAgentPickNextResult.js';
import { getRemainingPickSlots, hasReachedPickTarget } from './pickNextQueueProgress.js';
import type {
  DedupeState,
  DiscoveryMode,
  DjEventSink,
  DjPickNextFallbackPath,
  DjPickNextRunMetrics,
  SkippedPickLog
} from './musicAgentPickNextResult.js';

type LegacyTrackDetail = {
  id: string | number;
  name: string;
  artists: string[];
  coverImgUrl?: string | null;
};

type Logger = {
  warn(payload: Record<string, unknown>, message: string): void;
};

type BroadcastAppended = (
  userId: string,
  prevQueueLength: number,
  targetPickCount: number,
  emit: DjEventSink,
  path?: DjPickNextFallbackPath,
  metrics?: DjPickNextRunMetrics
) => void;

export type LegacyPickNextHandlingResult =
  | { status: 'handled'; debugBroadcastSent: true }
  | { status: 'random-fallback'; debugBroadcastSent: false };

export function handleLegacyPickNextOutput(input: {
  userId: string;
  pickedTracks: Track[];
  pickedDetailMap: Map<string, LegacyTrackDetail>;
  pickSay: string;
  pickReasonsById: Record<string, string>;
  phase3Debug: Record<string, unknown>;
  excludeState: DedupeState;
  initialQueueLength: number;
  targetPickCount: number;
  startedAt: number;
  discoveryMode: DiscoveryMode;
  legacyFallbackPath?: DjPickNextFallbackPath;
  emit: DjEventSink;
  broadcastAppended: BroadcastAppended;
  logger: Logger;
  markDebugBroadcastSent(): void;
  setPickReason(trackId: string, reason: string): void;
  fallbackStatsSnapshot(): unknown;
  searchedCount: number;
  totalCandidates: number;
  searchQueries: string[];
}): LegacyPickNextHandlingResult {
  const {
    userId,
    pickedTracks,
    pickedDetailMap,
    pickSay,
    pickReasonsById,
    phase3Debug,
    excludeState,
    initialQueueLength,
    targetPickCount,
    startedAt,
    discoveryMode,
    legacyFallbackPath,
    emit,
    broadcastAppended,
    logger,
    markDebugBroadcastSent,
    setPickReason,
    fallbackStatsSnapshot,
    searchedCount,
    totalCandidates,
    searchQueries
  } = input;
  const successPath = legacyFallbackPath ?? 'legacy_llm_success';

  const pathQueueLength = getQueue(userId).length;
  const whitelistedSkippedPicks: SkippedPickLog[] = [];
  const appendedWhitelistedTracks: Track[] = [];

  for (const track of pickedTracks) {
    if (getRemainingPickSlots(userId, initialQueueLength, targetPickCount) <= 0) {
      whitelistedSkippedPicks.push(createSkippedPickLog(track, 'no_remaining_slots', buildTrackDedupeKey(track)));
      break;
    }
    const dedupeKey = buildTrackDedupeKey(track);
    if (excludeState.ids.has(track.id)) {
      whitelistedSkippedPicks.push(createSkippedPickLog(track, 'id_excluded', dedupeKey));
      continue;
    }
    if (isTrackDedupeKeyExcluded(dedupeKey, excludeState.dedupeKeys)) {
      whitelistedSkippedPicks.push(createSkippedPickLog(track, 'dedupe_excluded', dedupeKey));
      continue;
    }
    const detail = pickedDetailMap.get(track.id);
    const appendedTrack = {
      id: track.id,
      name: detail?.name ?? track.name,
      artist: detail?.artists?.join(' / ') || track.artist
    };
    addToQueue(userId, {
      ncmId: appendedTrack.id,
      name: appendedTrack.name,
      artists: detail?.artists ?? (track.artist ? track.artist.split(' / ').filter(Boolean) : []),
      coverImgUrl: detail?.coverImgUrl
    }, 'end');
    appendedWhitelistedTracks.push(appendedTrack);
    excludeState.ids.add(track.id);
    excludeState.dedupeKeys.add(dedupeKey);
  }

  if (getQueue(userId).length > pathQueueLength) {
    const pathNewTracks = getQueue(userId).slice(pathQueueLength);
    for (const track of pathNewTracks) {
      const trackReason = pickReasonsById[track.ncmId]?.trim() || pickSay.trim();
      if (trackReason) setPickReason(track.ncmId, trackReason);
    }
  }

  if (hasReachedPickTarget(userId, initialQueueLength, targetPickCount)) {
    emit(buildLegacyDebugPayload({
      phase3Debug,
      selectedTracks: createLegacySelectedTrackDebug(appendedWhitelistedTracks, pickSay, pickReasonsById),
      selectedSay: pickSay,
      targetCount: targetPickCount,
      appendedCount: getQueue(userId).length - initialQueueLength,
      pickedCount: pickedTracks.length,
      skippedPicks: whitelistedSkippedPicks
    }));
    markDebugBroadcastSent();
    broadcastAppended(
      userId,
      initialQueueLength,
      targetPickCount,
      emit,
      successPath,
      legacyRunMetrics(pickedTracks.length, totalCandidates, startedAt, discoveryMode)
    );
    return { status: 'handled', debugBroadcastSent: true };
  }

  const appendedCount = getQueue(userId).length - initialQueueLength;
  if (appendedCount > 0) {
    const selectedTracks = createLegacySelectedTrackDebug(appendedWhitelistedTracks, pickSay, pickReasonsById);
    emit(buildLegacyDebugPayload({
      phase3Debug,
      selectedTracks,
      selectedSay: pickSay,
      partial: true,
      targetCount: targetPickCount,
      appendedCount,
      pickedCount: pickedTracks.length,
      skippedPicks: whitelistedSkippedPicks
    }));
    markDebugBroadcastSent();
    logger.warn(
      {
        targetCount: targetPickCount,
        appendedCount,
        pickedCount: pickedTracks.length,
        skippedPicks: whitelistedSkippedPicks,
        selectedTracks,
        selectedSay: pickSay,
        searchedCount,
        totalCandidates,
        searchQueries,
        fallbackPath: successPath,
        fallbackStats: fallbackStatsSnapshot()
      },
      'DJ pick-next: whitelisted picks appended fewer than target'
    );
    broadcastAppended(
      userId,
      initialQueueLength,
      targetPickCount,
      emit,
      successPath,
      legacyRunMetrics(pickedTracks.length, totalCandidates, startedAt, discoveryMode)
    );
    return { status: 'handled', debugBroadcastSent: true };
  }

  logger.warn(
    {
      targetCount: targetPickCount,
      appendedCount,
      pickedCount: pickedTracks.length,
      skippedPicks: whitelistedSkippedPicks,
      fallbackPath: 'legacy_random_fallback',
      fallbackStats: fallbackStatsSnapshot()
    },
    'DJ pick-next: whitelisted picks did not change queue, using random fallback'
  );
  return { status: 'random-fallback', debugBroadcastSent: false };
}

function buildLegacyDebugPayload(input: {
  phase3Debug: Record<string, unknown>;
  selectedTracks: Array<{ id: string; name: string; artist: string; reason: string; source: string }>;
  selectedSay: string;
  partial?: boolean;
  targetCount?: number;
  appendedCount?: number;
  pickedCount?: number;
  skippedPicks?: SkippedPickLog[];
}): Record<string, unknown> {
  return {
    type: 'dj.debug',
    ...input.phase3Debug,
    selectedTracks: input.selectedTracks,
    selectedSay: input.selectedSay,
    ...(input.partial !== undefined ? { partial: input.partial } : {}),
    ...(input.targetCount !== undefined ? { targetCount: input.targetCount } : {}),
    ...(input.appendedCount !== undefined ? { appendedCount: input.appendedCount } : {}),
    ...(input.pickedCount !== undefined ? { pickedCount: input.pickedCount } : {}),
    ...(input.skippedPicks !== undefined ? { skippedPicks: input.skippedPicks } : {})
  };
}

function createLegacySelectedTrackDebug(
  tracks: Track[],
  pickSay: string,
  reasonsById: Record<string, string> = {}
): Array<{ id: string; name: string; artist: string; reason: string; source: string }> {
  const reason = pickSay.trim() || 'legacy LLM pick';
  return tracks.map((track) => ({
    id: track.id,
    name: track.name ?? track.id,
    artist: track.artist ?? '未知艺人',
    reason: reasonsById[track.id]?.trim() || reason,
    source: 'legacy_llm'
  }));
}

function legacyRunMetrics(
  pickedCount: number,
  totalCandidates: number,
  startedAt: number,
  discoveryMode: DiscoveryMode
): DjPickNextRunMetrics {
  return {
    agentPickCount: pickedCount,
    rankedBackfillCount: 0,
    candidateCount: totalCandidates,
    elapsedMs: Date.now() - startedAt,
    discoveryMode
  };
}
