import type { MusicAgentRunOutput } from '../music-agent/schema.js';
import { buildMusicTrackDedupeKey, isMusicTrackDedupeKeyExcluded } from '../music-agent/dedupe.js';
import type { DiscoveryMode } from '../../shared/dj.js';
import { defaultDJAgentQueuePort, type DJAgentQueuePort } from '../dj-agent/ports.js';
import { getRemainingPickSlots, hasReachedPickTarget } from './pickNextQueueProgress.js';

export type DjPickNextFallbackPath =
  | 'music_agent_success'
  | 'music_agent_ranked_fallback'
  | 'music_agent_legacy_fallback'
  | 'legacy_llm_success'
  | 'legacy_random_fallback'
  | 'no_candidates';

export type DjEventSink = (payload: Record<string, unknown>) => void;

export type DjPickNextRunMetrics = {
  agentPickCount?: number;
  rankedBackfillCount?: number;
  finalPickDiagnostics?: MusicAgentRunOutput['finalPickDiagnostics'];
  queryFunnel?: MusicAgentRunOutput['queryFunnel'];
  candidateCount?: number;
  nonLikedCandidateCount?: number;
  candidateSourceCounts?: Record<string, number>;
  candidateProvenanceCounts?: Record<string, number>;
  elapsedMs?: number;
  fallbackPath?: DjPickNextFallbackPath;
  discoveryMode?: DiscoveryMode;
};

export type TrackDedupeInput = {
  id?: string | null;
  name?: string | null;
  artist?: string | null;
  artists?: string[] | null;
};

export type SkippedPickReason = 'id_excluded' | 'dedupe_excluded' | 'no_remaining_slots';

export type SkippedPickLog = {
  id?: string;
  name?: string;
  artist?: string;
  reason: SkippedPickReason;
  dedupeKey?: string;
};

export type DedupeState = {
  ids: Set<string>;
  dedupeKeys: Set<string>;
};

export type MusicAgentPickNextHandlingResult =
  | { status: 'handled'; debugBroadcastSent: true }
  | { status: 'legacy-fallback'; legacyFallbackPath: 'music_agent_legacy_fallback'; debugBroadcastSent: false };

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

export function handleMusicAgentPickNextOutput(input: {
  userId: string;
  output: MusicAgentRunOutput;
  excludeState: DedupeState;
  initialQueueLength: number;
  targetPickCount: number;
  startedAt: number;
  discoveryMode: DiscoveryMode;
  emit: DjEventSink;
  broadcastAppended: BroadcastAppended;
  logger: Logger;
  queuePort?: DJAgentQueuePort;
  setPickReason(trackId: string, reason: string): void;
  fallbackStatsSnapshot(): unknown;
}): MusicAgentPickNextHandlingResult {
  const {
    userId,
    output,
    excludeState,
    initialQueueLength,
    targetPickCount,
    startedAt,
    discoveryMode,
    emit,
    broadcastAppended,
    logger,
    queuePort = defaultDJAgentQueuePort,
    setPickReason,
    fallbackStatsSnapshot
  } = input;

  if (isLyricsAwareSafetyBlock(output)) {
    const lyricsAwareDiagnostics = compactLyricsAwareDiagnostics(output);
    logger.warn(
      {
        routeOutcome: 'lyrics_safety_block',
        legacyFallbackSuppressed: true,
        lyricsAwareDiagnostics,
        fallbackStats: fallbackStatsSnapshot()
      },
      'DJ pick-next: lyrics-aware safety block suppressed legacy fallback'
    );
    emit({
      ...buildMusicAgentDebugPayload({ output, appendedPicks: [], excludeState }),
      routeOutcome: 'lyrics_safety_block',
      legacyFallbackSuppressed: true,
      lyricsAwareDiagnostics
    });
    emit({
      type: 'dj.pick-next.done',
      added: false,
      addedCount: 0,
      reason: 'lyrics-safety-block',
      targetCount: targetPickCount
    });
    return { status: 'handled', debugBroadcastSent: true };
  }

  if (output.status !== 'ok') {
    return {
      status: 'legacy-fallback',
      legacyFallbackPath: 'music_agent_legacy_fallback',
      debugBroadcastSent: false
    };
  }

  if (shouldRouteRankedRecoveryToLegacy(output)) {
    const legacyFallbackPath = 'music_agent_legacy_fallback';
    logger.warn(
      {
        targetCount: targetPickCount,
        requestedPickCount: output.picks.length,
        rankedFallbackPicks: createMusicAgentSelectedTrackDebug(output.picks),
        ...getMusicAgentShortfallDiagnostics(output, []),
        fallbackPath: legacyFallbackPath,
        fallbackStats: fallbackStatsSnapshot()
      },
      'DJ pick-next: MusicAgent returned ranked fallback picks, using legacy fallback'
    );
    return { status: 'legacy-fallback', legacyFallbackPath, debugBroadcastSent: false };
  }

  if (hasSafeAssessedRankedPicks(output)) {
    logger.warn(
      {
        routeOutcome: 'accepted_assessed_ranked',
        rankedPicks: createMusicAgentSelectedTrackDebug(output.picks),
        lyricsAwareDiagnostics: compactLyricsAwareDiagnostics(output)
      },
      'DJ pick-next: accepting assessed and eligible MusicAgent ranked picks'
    );
  }

  const pathQueueLength = queuePort.getQueue(userId).length;
  const appendedPicks: typeof output.picks = [];
  const musicAgentSkippedPicks: SkippedPickLog[] = [];

  for (const pick of output.picks) {
    if (getRemainingPickSlots(userId, initialQueueLength, targetPickCount, queuePort) <= 0) {
      musicAgentSkippedPicks.push(createSkippedPickLog(pick, 'no_remaining_slots', buildTrackDedupeKey(pick)));
      break;
    }
    const dedupeKey = buildTrackDedupeKey(pick);
    if (excludeState.ids.has(pick.id)) {
      musicAgentSkippedPicks.push(createSkippedPickLog(pick, 'id_excluded', dedupeKey));
      continue;
    }
    if (isTrackDedupeKeyExcluded(dedupeKey, excludeState.dedupeKeys)) {
      musicAgentSkippedPicks.push(createSkippedPickLog(pick, 'dedupe_excluded', dedupeKey));
      continue;
    }
    queuePort.addToQueue(userId, {
      ncmId: pick.id,
      name: pick.name,
      artists: pick.artist ? [pick.artist] : []
    }, 'end');
    appendedPicks.push(pick);
    excludeState.ids.add(pick.id);
    if (dedupeKey) excludeState.dedupeKeys.add(dedupeKey);
  }

  if (queuePort.getQueue(userId).length > pathQueueLength) {
    const pathNewTracks = queuePort.getQueue(userId).slice(pathQueueLength);
    const pickReason = output.say.trim();
    if (pickReason) {
      for (const track of pathNewTracks) {
        setPickReason(track.ncmId, pickReason);
      }
    }
  }

  if (hasReachedPickTarget(userId, initialQueueLength, targetPickCount, queuePort)) {
    emit(buildMusicAgentDebugPayload({ output, appendedPicks, excludeState }));
    broadcastAppended(
      userId,
      initialQueueLength,
      targetPickCount,
      emit,
      getMusicAgentRoutePath(output),
      musicAgentRunMetrics(output, appendedPicks, startedAt, discoveryMode)
    );
    return { status: 'handled', debugBroadcastSent: true };
  }

  const appendedCount = queuePort.getQueue(userId).length - initialQueueLength;
  if (appendedCount > 0) {
    emit(buildMusicAgentDebugPayload({
      output,
      appendedPicks,
      excludeState,
      partial: true,
      targetCount: targetPickCount,
      appendedCount,
      requestedPickCount: output.picks.length,
      skippedPicks: musicAgentSkippedPicks
    }));
    logger.warn(
      {
        targetCount: targetPickCount,
        appendedCount,
        requestedPickCount: output.picks.length,
        skippedPicks: musicAgentSkippedPicks,
        ...getMusicAgentShortfallDiagnostics(output, appendedPicks),
        fallbackPath: getMusicAgentRoutePath(output),
        fallbackStats: fallbackStatsSnapshot()
      },
      'DJ pick-next: MusicAgent appended fewer than target'
    );
    broadcastAppended(
      userId,
      initialQueueLength,
      targetPickCount,
      emit,
      getMusicAgentRoutePath(output),
      musicAgentRunMetrics(output, appendedPicks, startedAt, discoveryMode)
    );
    return { status: 'handled', debugBroadcastSent: true };
  }

  const legacyFallbackPath = 'music_agent_legacy_fallback';
  logger.warn(
    {
      targetCount: targetPickCount,
      appendedCount,
      requestedPickCount: output.picks.length,
      skippedPicks: musicAgentSkippedPicks,
      fallbackPath: legacyFallbackPath,
      fallbackStats: fallbackStatsSnapshot()
    },
    'DJ pick-next: MusicAgent picks did not change queue, using legacy fallback'
  );
  return { status: 'legacy-fallback', legacyFallbackPath, debugBroadcastSent: false };
}

function getMusicAgentDebugCandidateCount(output: MusicAgentRunOutput): number {
  return Math.max(output.picks.length, ...output.trace.map((step) => step.candidateCount));
}

export function getMusicAgentCandidateSourceDiagnostics(
  output: Pick<MusicAgentRunOutput, 'candidateScoreTable'>
): {
  nonLikedCandidateCount: number;
  candidateSourceCounts: Record<string, number>;
  candidateProvenanceCounts: Record<string, number>;
} {
  const candidateSourceCounts: Record<string, number> = {};
  const candidateProvenanceCounts: Record<string, number> = {};
  let nonLikedCandidateCount = 0;

  for (const row of output.candidateScoreTable) {
    const sources = row.sources
      .split(',')
      .map((source) => source.trim())
      .filter(Boolean);
    if (sources.some((source) => source !== 'liked')) {
      nonLikedCandidateCount += 1;
    }
    for (const source of sources) {
      candidateSourceCounts[source] = (candidateSourceCounts[source] ?? 0) + 1;
    }
    const provenance = (row.provenance ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    for (const entry of provenance) {
      candidateProvenanceCounts[entry] = (candidateProvenanceCounts[entry] ?? 0) + 1;
    }
  }

  return { nonLikedCandidateCount, candidateSourceCounts, candidateProvenanceCounts };
}

function buildMusicAgentDebugPayload(input: {
  output: MusicAgentRunOutput;
  appendedPicks: MusicAgentRunOutput['picks'];
  excludeState: DedupeState;
  partial?: boolean;
  targetCount?: number;
  appendedCount?: number;
  requestedPickCount?: number;
  skippedPicks?: SkippedPickLog[];
}): Record<string, unknown> {
  const { output, appendedPicks, excludeState } = input;
  const candidateSourceDiagnostics = getMusicAgentCandidateSourceDiagnostics(output);

  return {
    type: 'dj.debug',
    likedSample: [],
    sqRaw: JSON.stringify(output.trace),
    searchQueries: output.queryFunnel.map((entry) => entry.query),
    queryFunnel: output.queryFunnel,
    searchedTracks: output.picks.map((pick) => ({
      id: pick.id,
      name: pick.name,
      artist: pick.artist
    })),
    selectedTracks: createMusicAgentSelectedTrackDebug(appendedPicks),
    excludedIds: Array.from(excludeState.ids),
    excludedDedupeKeys: Array.from(excludeState.dedupeKeys),
    totalCandidates: getMusicAgentDebugCandidateCount(output),
    ...candidateSourceDiagnostics,
    candidateScoreTable: output.candidateScoreTable,
    selectedSay: output.say,
    ...(output.lyricsAwareDiagnostics
      ? { lyricsAwareDiagnostics: compactLyricsAwareDiagnostics(output) }
      : {}),
    ...(input.partial !== undefined ? { partial: input.partial } : {}),
    ...(input.targetCount !== undefined ? { targetCount: input.targetCount } : {}),
    ...(input.appendedCount !== undefined ? { appendedCount: input.appendedCount } : {}),
    ...(input.requestedPickCount !== undefined ? { requestedPickCount: input.requestedPickCount } : {}),
    ...(input.skippedPicks !== undefined ? { skippedPicks: input.skippedPicks } : {})
  };
}

function createMusicAgentSelectedTrackDebug(
  picks: MusicAgentRunOutput['picks']
): Array<{ id: string; name: string; artist: string; reason: string; source: string }> {
  return picks.map((pick) => ({
    id: pick.id,
    name: pick.name ?? pick.id,
    artist: pick.artist ?? '未知艺人',
    reason: pick.reason,
    source: pick.source
  }));
}

function getMusicAgentShortfallDiagnostics(
  output: MusicAgentRunOutput,
  appendedPicks: MusicAgentRunOutput['picks']
): Record<string, unknown> {
  return {
    selectedTracks: createMusicAgentSelectedTrackDebug(appendedPicks),
    selectedSay: output.say,
    rejected: output.rejected,
    finalPickDiagnostics: output.finalPickDiagnostics,
    queryFunnel: output.queryFunnel,
    traceLastSteps: output.trace.slice(-3),
    candidateScoreTableCount: output.candidateScoreTable.length,
    candidateScoreTablePreview: output.candidateScoreTable.slice(0, 20),
    ...getMusicAgentCandidateSourceDiagnostics(output)
  };
}

function getMusicAgentRoutePath(output: MusicAgentRunOutput): DjPickNextFallbackPath {
  return output.picks.some((pick) => pick.reason === 'ranked fallback')
    ? 'music_agent_ranked_fallback'
    : 'music_agent_success';
}

function hasRankedRecoveryPicks(output: MusicAgentRunOutput): boolean {
  return output.picks.some(
    (pick) => pick.reason === 'ranked fallback' || pick.reason === 'ranked convergence'
  );
}

function shouldRouteRankedRecoveryToLegacy(output: MusicAgentRunOutput): boolean {
  return hasRankedRecoveryPicks(output) && !hasSafeAssessedRankedPicks(output);
}

function hasSafeAssessedRankedPicks(output: MusicAgentRunOutput): boolean {
  if (!hasRankedRecoveryPicks(output)) return false;
  const diagnostics = output.lyricsAwareDiagnostics;
  if (
    !diagnostics
    || !isLyricsEnforcementMode(diagnostics.mode)
    || diagnostics.enforcementApplied !== true
    || diagnostics.assessmentCoverageValid !== true
    || diagnostics.allReturnedPicksAssessed !== true
  ) {
    return false;
  }

  const decisionsById = new Map<string, typeof diagnostics.decisions>();
  for (const decision of diagnostics.decisions) {
    const existing = decisionsById.get(decision.id) ?? [];
    existing.push(decision);
    decisionsById.set(decision.id, existing);
  }
  return output.picks.every((pick) => {
    const decisions = decisionsById.get(pick.id);
    return decisions?.length === 1 && decisions[0]?.eligible === true;
  });
}

export function isLyricsAwareSafetyBlock(output: MusicAgentRunOutput): boolean {
  const diagnostics = output.lyricsAwareDiagnostics;
  return output.picks.length === 0
    && diagnostics !== undefined
    && isLyricsEnforcementMode(diagnostics.mode)
    && diagnostics.enforcementApplied === true
    && diagnostics.fallbackSuppressed === true
    && diagnostics.allReturnedPicksAssessed === true
    && Array.isArray(diagnostics.assessmentValidationProblems)
    && Array.isArray(diagnostics.decisions)
    && typeof diagnostics.promptChars === 'number'
    && diagnostics.enrichment !== undefined;
}

function isLyricsEnforcementMode(mode: string): mode is 'enforce_fit' | 'enforce_all' {
  return mode === 'enforce_fit' || mode === 'enforce_all';
}

function compactLyricsAwareDiagnostics(output: MusicAgentRunOutput): Record<string, unknown> | undefined {
  const diagnostics = output.lyricsAwareDiagnostics;
  if (!diagnostics) return undefined;
  return {
    mode: diagnostics.mode,
    assessmentCoverageValid: diagnostics.assessmentCoverageValid,
    assessmentValidationProblemCount: diagnostics.assessmentValidationProblems.length,
    allReturnedPicksAssessed: diagnostics.allReturnedPicksAssessed,
    enforcementApplied: diagnostics.enforcementApplied,
    fallbackSuppressed: diagnostics.fallbackSuppressed,
    eligibleDecisionCount: diagnostics.decisions.filter((decision) => decision.eligible).length,
    decisionCount: diagnostics.decisions.length,
    promptChars: diagnostics.promptChars,
    enrichment: {
      shortlistCount: diagnostics.enrichment.shortlistCount,
      cacheHits: diagnostics.enrichment.cacheHits,
      lyricSuccess: diagnostics.enrichment.lyricSuccess,
      lyricMissing: diagnostics.enrichment.lyricMissing,
      lyricFail: diagnostics.enrichment.lyricFail,
      lyricTimeout: diagnostics.enrichment.lyricTimeout,
      elapsedMs: diagnostics.enrichment.elapsedMs,
      deadlineReached: diagnostics.enrichment.deadlineReached
    }
  };
}

function musicAgentRunMetrics(
  output: MusicAgentRunOutput,
  appendedPicks: MusicAgentRunOutput['picks'],
  startedAt: number,
  discoveryMode: DiscoveryMode
): DjPickNextRunMetrics {
  return {
    agentPickCount: appendedPicks.filter((pick) => pick.reason !== 'ranked backfill').length,
    rankedBackfillCount: appendedPicks.filter((pick) => pick.reason === 'ranked backfill').length,
    finalPickDiagnostics: output.finalPickDiagnostics,
    queryFunnel: output.queryFunnel,
    candidateCount: getMusicAgentDebugCandidateCount(output),
    ...getMusicAgentCandidateSourceDiagnostics(output),
    elapsedMs: Date.now() - startedAt,
    discoveryMode
  };
}

export function buildTrackDedupeKey(track: TrackDedupeInput): string {
  return buildMusicTrackDedupeKey(track);
}

export function isTrackDedupeKeyExcluded(dedupeKey: string, excludedKeys: Set<string>): boolean {
  return isMusicTrackDedupeKeyExcluded(dedupeKey, excludedKeys);
}

export function createSkippedPickLog(
  track: TrackDedupeInput,
  reason: SkippedPickReason,
  dedupeKey: string
): SkippedPickLog {
  const artists = track.artist ?? track.artists?.filter(Boolean).join(' / ') ?? undefined;
  return {
    id: track.id ? String(track.id) : undefined,
    name: track.name ?? undefined,
    artist: artists || undefined,
    reason,
    dedupeKey: dedupeKey || undefined
  };
}
