import type { Track } from '../agent/schema.js';
import { addToQueue, getQueue, type QueueTrack } from '../store/queue.js';
import {
  buildTrackDedupeKey,
  createSkippedPickLog,
  isTrackDedupeKeyExcluded
} from './musicAgentPickNextResult.js';
import {
  appendQueueAppendEvents,
  ensureSelectionStartedEventSafely,
  queueTrackArtist,
  type DjSelectionEventContext
} from './eventLogging.js';
import { buildFinalSelectionResult } from './finalSelectionResult.js';
import { getRemainingPickSlots, hasReachedPickTarget } from './pickNextQueueProgress.js';
import type { DiscoveryMode } from '../../shared/dj.js';
import type {
  DedupeState,
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
  | { status: 'handled'; debugBroadcastSent: false }
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
  djEventContext?: DjSelectionEventContext;
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
    djEventContext,
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

  const whitelistedSkippedPicks: SkippedPickLog[] = [];
  const appendedWhitelistedTracks: QueueTrack[] = [];

  for (const track of pickedTracks) {
    if (getRemainingPickSlots(userId, initialQueueLength, targetPickCount) <= 0) {
      whitelistedSkippedPicks.push(createSkippedPickLog(track, 'no_remaining_slots', buildTrackDedupeKey(track)));
      continue;
    }
    const dedupeKey = buildTrackDedupeKey(track);
    const currentQueue = getQueue(userId);
    if (currentQueue.some((queuedTrack) => queuedTrack.ncmId === track.id)) {
      whitelistedSkippedPicks.push(createSkippedPickLog(track, 'id_excluded', dedupeKey));
      continue;
    }
    if (isTrackDedupeKeyExcluded(dedupeKey, new Set(
      currentQueue.map((queuedTrack) => buildTrackDedupeKey({
        id: queuedTrack.ncmId,
        name: queuedTrack.name,
        artists: queuedTrack.artists
      }))
    ))) {
      whitelistedSkippedPicks.push(createSkippedPickLog(track, 'dedupe_excluded', dedupeKey));
      continue;
    }
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
      ncmId: track.id,
      name: detail?.name ?? track.name,
      artists: detail?.artists ?? (track.artist ? track.artist.split(' / ').filter(Boolean) : []),
      coverImgUrl: detail?.coverImgUrl
    };
    addToQueue(userId, {
      ncmId: appendedTrack.ncmId,
      name: appendedTrack.name,
      artists: appendedTrack.artists,
      coverImgUrl: appendedTrack.coverImgUrl
    }, 'end');
    const actuallyAppended = getQueue(userId).find((queuedTrack) => queuedTrack.ncmId === track.id);
    if (!actuallyAppended) {
      whitelistedSkippedPicks.push(createSkippedPickLog(track, 'id_excluded', dedupeKey));
      continue;
    }
    appendedWhitelistedTracks.push(cloneQueueTrack(actuallyAppended));
    excludeState.ids.add(track.id);
    excludeState.dedupeKeys.add(dedupeKey);
  }

  if (appendedWhitelistedTracks.length === 0) {
    if (hasReachedPickTarget(userId, initialQueueLength, targetPickCount)) {
      return { status: 'handled', debugBroadcastSent: false };
    }
    logger.warn(
      {
        targetCount: targetPickCount,
        appendedCount: 0,
        pickedCount: pickedTracks.length,
        skippedPicks: whitelistedSkippedPicks,
        fallbackPath: 'legacy_random_fallback',
        fallbackStats: fallbackStatsSnapshot()
      },
      'DJ pick-next: whitelisted picks did not change queue, using random fallback'
    );
    return { status: 'random-fallback', debugBroadcastSent: false };
  }

  const finalSelection = buildFinalSelectionResult({
    tracks: appendedWhitelistedTracks.map((track) => ({
      id: track.ncmId,
      name: track.name,
      artist: queueTrackArtist(track),
      reason: pickReasonsById[track.ncmId]?.trim()
        || pickSay.trim()
        || 'Selected by legacy DJ fallback.',
      source: successPath
    })),
    proposedRationale: pickSay,
    diagnostics: {
      targetCount: targetPickCount,
      requestedPickCount: pickedTracks.length,
      skippedPicks: whitelistedSkippedPicks
    }
  });

  for (const track of finalSelection.tracks) {
    setPickReason(track.id, track.reason);
  }

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

  if (hasReachedPickTarget(userId, initialQueueLength, targetPickCount)) {
    emit(buildLegacyDebugPayload({
      phase3Debug,
      selectedTracks: createFinalSelectionDebugTracks(finalSelection.tracks),
      selectedSay: finalSelection.rationale,
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
      legacyRunMetrics(
        pickedTracks.length,
        totalCandidates,
        startedAt,
        discoveryMode,
        appendedWhitelistedTracks
      )
    );
    return { status: 'handled', debugBroadcastSent: true };
  }

  const appendedCount = getQueue(userId).length - initialQueueLength;
  if (appendedCount > 0) {
    const selectedTracks = createFinalSelectionDebugTracks(finalSelection.tracks);
    emit(buildLegacyDebugPayload({
      phase3Debug,
      selectedTracks,
      selectedSay: finalSelection.rationale,
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
        selectedSay: finalSelection.rationale,
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
      legacyRunMetrics(
        pickedTracks.length,
        totalCandidates,
        startedAt,
        discoveryMode,
        appendedWhitelistedTracks
      )
    );
    return { status: 'handled', debugBroadcastSent: true };
  }

  return { status: 'handled', debugBroadcastSent: true };
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

function createFinalSelectionDebugTracks(
  tracks: Array<{ id: string; name?: string; artist?: string; reason: string; source: string }>
): Array<{ id: string; name: string; artist: string; reason: string; source: string }> {
  return tracks.map((track) => ({
    id: track.id,
    name: track.name ?? track.id,
    artist: track.artist ?? '未知艺人',
    reason: track.reason,
    source: track.source
  }));
}

function legacyRunMetrics(
  pickedCount: number,
  totalCandidates: number,
  startedAt: number,
  discoveryMode: DiscoveryMode,
  appendedTracks: QueueTrack[]
): DjPickNextRunMetrics {
  return {
    appendedTracks,
    agentPickCount: pickedCount,
    rankedBackfillCount: 0,
    candidateCount: totalCandidates,
    elapsedMs: Date.now() - startedAt,
    discoveryMode
  };
}

function cloneQueueTrack(track: QueueTrack): QueueTrack {
  return {
    ...track,
    ...(track.artists ? { artists: [...track.artists] } : {})
  };
}
