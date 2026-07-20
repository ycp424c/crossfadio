import {
  lyricsAwareDiagnosticsSchema,
  type MusicAgentRunOutput
} from '../music-agent/schema.js';
import { buildMusicTrackDedupeKey, isMusicTrackDedupeKeyExcluded } from '../music-agent/dedupe.js';
import type { DiscoveryMode } from '../../shared/dj.js';
import { defaultDJAgentQueuePort, type DJAgentQueuePort } from '../dj-agent/ports.js';
import type { QueueTrack } from '../store/queue.js';
import {
  evaluateFinalQueuePickWithContext as evaluateLiveFinalQueuePick,
  type FinalQueueEvaluation
} from '../music-agent/final-queue-policy.js';
import type { SelectionReasonCode } from '../music-agent/selection-policy/types.js';
import type { SelectionPhaseDecision } from '../music-agent/selection-policy/types.js';
import type { SelectionPolicyReplayContext } from '../music-agent/selection-policy/replay-case.js';
import { createSelectionTraceFromDecisions } from './selection-trace-from-output.js';
import { projectSelectionTraceForLog } from './selection-trace-projections.js';

export type DjPickNextFallbackPath =
  | 'music_agent_success'
  | 'music_agent_ranked_recovery'
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

export type SkippedPickReason =
  | 'id_excluded'
  | 'dedupe_excluded'
  | 'no_remaining_slots'
  | SelectionReasonCode;

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
  {
    status: 'handled';
    completion: 'applied' | 'superseded';
    finalQueueDecisions: FinalQueueDecision[];
    appendedCount: number;
    appendedTrackIds: string[];
    appendedTracks: QueueTrack[];
    successPublication?: MusicAgentPickNextSuccessPublication;
  };

export type MusicAgentPickNextSuccessPublication = {
  appendedTracks: QueueTrack[];
  appendedTrackIds: string[];
  appendedDedupeKeys: string[];
  pickReason: string;
  debugPayload: Record<string, unknown>;
  path: DjPickNextFallbackPath;
  metrics: DjPickNextRunMetrics;
  warning?: {
    payload: Record<string, unknown>;
    message: string;
  };
};

export type FinalQueueDecision = {
  candidateId: string;
  decision: SelectionPhaseDecision;
  replayContext?: SelectionPolicyReplayContext;
};

type Logger = {
  warn(payload: Record<string, unknown>, message: string): void;
};

type BroadcastAppended = (
  userId: string,
  tracks: QueueTrack[],
  targetPickCount: number,
  emit: DjEventSink,
  path?: DjPickNextFallbackPath,
  metrics?: DjPickNextRunMetrics
) => void;

export function handleMusicAgentPickNextOutput(input: {
  userId: string;
  output: MusicAgentRunOutput;
  excludeState: DedupeState;
  initialQueueRevision?: number;
  targetPickCount: number;
  startedAt: number;
  discoveryMode: DiscoveryMode;
  emit: DjEventSink;
  logger: Logger;
  queuePort?: DJAgentQueuePort;
  recordRouteOutcome?(path: DjPickNextFallbackPath): unknown;
  fallbackStatsSnapshot(): unknown;
  evaluateFinalQueuePick?(input: {
    userId: string;
    pick: MusicAgentRunOutput['picks'][number];
    mode: 'autonomous';
    runId?: string;
    playedTrackIds?: ReadonlySet<string>;
    playedTrackKeys?: ReadonlySet<string>;
  }): SelectionPhaseDecision | FinalQueueEvaluation;
  runId?: string;
}): MusicAgentPickNextHandlingResult {
  const {
    userId,
    output,
    excludeState,
    initialQueueRevision,
    targetPickCount,
    startedAt,
    discoveryMode,
    emit,
    logger,
    queuePort = defaultDJAgentQueuePort,
    recordRouteOutcome,
    fallbackStatsSnapshot,
    runId,
    evaluateFinalQueuePick = evaluateLiveFinalQueuePick
  } = input;
  const finalQueueDecisions: FinalQueueDecision[] = [];
  const plannedExcludeState: DedupeState = {
    ids: new Set(excludeState.ids),
    dedupeKeys: new Set(excludeState.dedupeKeys)
  };

  if (initialQueueRevision !== undefined && queuePort.getRevision(userId) !== initialQueueRevision) {
    emit(buildMusicAgentDebugPayload({ output, appendedPicks: [], excludeState }));
    emit({
      type: 'dj.pick-next.done',
      added: false,
      addedCount: 0,
      reason: 'queue-changed',
      targetCount: targetPickCount
    });
    return {
      status: 'handled', completion: 'superseded',
      finalQueueDecisions, appendedCount: 0, appendedTrackIds: [], appendedTracks: []
    };
  }

  if (output.status !== 'ok') {
    emit({
      type: 'dj.pick-next.done',
      added: false,
      addedCount: 0,
      reason: output.status,
      targetCount: targetPickCount
    });
    recordRouteOutcome?.('no_candidates');
    return {
      status: 'handled', completion: 'applied',
      finalQueueDecisions, appendedCount: 0, appendedTrackIds: [], appendedTracks: []
    };
  }

  if (hasRankedRecoveryPicks(output)) {
    logger.warn(
      {
        targetCount: targetPickCount,
        requestedPickCount: output.picks.length,
        ...getMusicAgentShortfallDiagnostics(output, [], runId, startedAt),
        fallbackPath: 'music_agent_ranked_recovery',
        fallbackStats: fallbackStatsSnapshot()
      },
      'DJ pick-next: accepting policy-governed ranked recovery picks'
    );
  }

  const appendedPicks: typeof output.picks = [];
  const appendedTracks: QueueTrack[] = [];
  const appendedDedupeKeys: string[] = [];
  const musicAgentSkippedPicks: SkippedPickLog[] = [];

  for (const pick of output.picks) {
    if (appendedPicks.length >= targetPickCount) {
      musicAgentSkippedPicks.push(createSkippedPickLog(pick, 'no_remaining_slots', buildTrackDedupeKey(pick)));
      finalQueueDecisions.push({
        candidateId: pick.id,
        decision: finalQueueRejection('queue_target_reached')
      });
      continue;
    }
    const evaluatedFinal = evaluateFinalQueuePick({
      userId,
      pick,
      mode: 'autonomous',
      runId,
      playedTrackIds: plannedExcludeState.ids,
      playedTrackKeys: plannedExcludeState.dedupeKeys
    });
    const finalDecision = 'decision' in evaluatedFinal ? evaluatedFinal.decision : evaluatedFinal;
    finalQueueDecisions.push({
      candidateId: pick.id,
      decision: finalDecision,
      ...('decision' in evaluatedFinal ? { replayContext: evaluatedFinal.replayContext } : {})
    });
    if (finalDecision.action === 'reject') {
      musicAgentSkippedPicks.push(createSkippedPickLog(
        pick,
        finalDecision.reasonCodes[0] ?? 'invalid_track_identity',
        buildTrackDedupeKey(pick)
      ));
      continue;
    }
    const dedupeKey = buildTrackDedupeKey(pick);
    if (plannedExcludeState.ids.has(pick.id)) {
      musicAgentSkippedPicks.push(createSkippedPickLog(pick, 'id_excluded', dedupeKey));
      finalQueueDecisions.push({
        candidateId: pick.id,
        decision: finalQueueRejection('queue_track_idempotency')
      });
      continue;
    }
    if (isTrackDedupeKeyExcluded(dedupeKey, plannedExcludeState.dedupeKeys)) {
      musicAgentSkippedPicks.push(createSkippedPickLog(pick, 'dedupe_excluded', dedupeKey));
      finalQueueDecisions.push({
        candidateId: pick.id,
        decision: finalQueueRejection('queue_track_idempotency')
      });
      continue;
    }
    const appendedTrack = {
      ncmId: pick.id,
      name: pick.name,
      artists: pick.artist ? [pick.artist] : []
    };
    appendedPicks.push(pick);
    appendedTracks.push(appendedTrack);
    plannedExcludeState.ids.add(pick.id);
    if (dedupeKey) {
      plannedExcludeState.dedupeKeys.add(dedupeKey);
      appendedDedupeKeys.push(dedupeKey);
    }
  }

  const pickReason = output.say.trim();

  if (appendedPicks.length >= targetPickCount) {
    const appendedTrackIds = appendedPicks.map((pick) => pick.id);
    return {
      status: 'handled', completion: 'applied', finalQueueDecisions,
      appendedCount: appendedPicks.length,
      appendedTrackIds,
      appendedTracks,
      successPublication: {
        appendedTracks,
        appendedTrackIds,
        appendedDedupeKeys,
        pickReason,
        debugPayload: buildMusicAgentDebugPayload({
          output,
          appendedPicks,
          excludeState: plannedExcludeState
        }),
        path: getMusicAgentRoutePath(output),
        metrics: musicAgentRunMetrics(output, appendedPicks, startedAt, discoveryMode)
      }
    };
  }

  const appendedCount = appendedPicks.length;
  if (appendedCount > 0) {
    const appendedTrackIds = appendedPicks.map((pick) => pick.id);
    return {
      status: 'handled', completion: 'applied', finalQueueDecisions,
      appendedCount,
      appendedTrackIds,
      appendedTracks,
      successPublication: {
        appendedTracks,
        appendedTrackIds,
        appendedDedupeKeys,
        pickReason,
        debugPayload: buildMusicAgentDebugPayload({
          output,
          appendedPicks,
          excludeState: plannedExcludeState,
          partial: true,
          targetCount: targetPickCount,
          appendedCount,
          requestedPickCount: output.picks.length,
          skippedPicks: musicAgentSkippedPicks
        }),
        path: getMusicAgentRoutePath(output),
        metrics: musicAgentRunMetrics(output, appendedPicks, startedAt, discoveryMode),
        warning: {
          payload: {
            targetCount: targetPickCount,
            appendedCount,
            requestedPickCount: output.picks.length,
            skippedPickReasonCounts: countSkippedPickReasons(musicAgentSkippedPicks),
            ...getMusicAgentShortfallDiagnostics(output, appendedPicks, runId, startedAt),
            fallbackPath: getMusicAgentRoutePath(output),
            fallbackStats: fallbackStatsSnapshot()
          },
          message: 'DJ pick-next: MusicAgent appended fewer than target'
        }
      }
    };
  }

  logger.warn(
    {
      targetCount: targetPickCount,
      appendedCount,
      requestedPickCount: output.picks.length,
      skippedPickReasonCounts: countSkippedPickReasons(musicAgentSkippedPicks),
      fallbackPath: 'no_candidates',
      fallbackStats: fallbackStatsSnapshot(),
      ...selectionTraceLogProjection(output, runId, startedAt)
    },
    'DJ pick-next: no policy-eligible picks changed the queue'
  );
  emit(buildMusicAgentDebugPayload({ output, appendedPicks, excludeState }));
  emit({
    type: 'dj.pick-next.done',
    added: false,
    addedCount: 0,
    reason: 'no-candidates',
    targetCount: targetPickCount
  });
  recordRouteOutcome?.('no_candidates');
  return {
    status: 'handled', completion: 'applied',
    finalQueueDecisions, appendedCount: 0, appendedTrackIds: [], appendedTracks: []
  };
}

export function publishCommittedMusicAgentPickNextSuccess(input: {
  userId: string;
  publication: MusicAgentPickNextSuccessPublication;
  excludeState: DedupeState;
  targetPickCount: number;
  emit: DjEventSink;
  broadcastAppended: BroadcastAppended;
  logger: Logger;
  setPickReason(trackId: string, reason: string): void;
}): void {
  for (const trackId of input.publication.appendedTrackIds) input.excludeState.ids.add(trackId);
  for (const dedupeKey of input.publication.appendedDedupeKeys) {
    input.excludeState.dedupeKeys.add(dedupeKey);
  }
  if (input.publication.pickReason) {
    for (const track of input.publication.appendedTracks) {
      input.setPickReason(track.ncmId, input.publication.pickReason);
    }
  }
  input.emit(input.publication.debugPayload);
  if (input.publication.warning) {
    input.logger.warn(input.publication.warning.payload, input.publication.warning.message);
  }
  input.broadcastAppended(
    input.userId,
    input.publication.appendedTracks,
    input.targetPickCount,
    input.emit,
    input.publication.path,
    input.publication.metrics
  );
}

function finalQueueRejection(reasonCode: SelectionReasonCode): SelectionPhaseDecision {
  return { phase: 'final', action: 'reject', reasonCodes: [reasonCode] };
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
  const lyricsAwareDiagnostics = compactLyricsAwareDiagnostics(output);

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
    selectedSay: buildMusicAgentSelectedSay(output, appendedPicks),
    ...(lyricsAwareDiagnostics
      ? { lyricsAwareDiagnostics }
      : {}),
    ...(input.partial !== undefined ? { partial: input.partial } : {}),
    ...(input.targetCount !== undefined ? { targetCount: input.targetCount } : {}),
    ...(input.appendedCount !== undefined ? { appendedCount: input.appendedCount } : {}),
    ...(input.requestedPickCount !== undefined ? { requestedPickCount: input.requestedPickCount } : {}),
    ...(input.skippedPicks !== undefined ? { skippedPicks: input.skippedPicks } : {})
  };
}

function buildMusicAgentSelectedSay(
  output: MusicAgentRunOutput,
  appendedPicks: MusicAgentRunOutput['picks']
): string {
  const rawPickCount = output.finalPickDiagnostics?.rawPickCount ?? output.picks.length;
  const selectionChanged = rawPickCount !== appendedPicks.length
    || output.picks.length !== appendedPicks.length
    || output.picks.some((pick, index) => pick.id !== appendedPicks[index]?.id);
  if (!selectionChanged) return output.say;

  const trackNames = appendedPicks.map((pick) => pick.name?.trim() || pick.id);
  return `本次实际选入 ${appendedPicks.length} 首${trackNames.length > 0 ? `：${trackNames.join('、')}` : ''}。`;
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
  appendedPicks: MusicAgentRunOutput['picks'],
  runId: string | undefined,
  startedAt: number
): Record<string, unknown> {
  return {
    selectedTrackCount: appendedPicks.length,
    rejectedPickCount: output.rejected.length,
    finalPickDiagnostics: output.finalPickDiagnostics,
    queryCount: output.queryFunnel.length,
    traceStepCount: output.trace.length,
    candidateScoreTableCount: output.candidateScoreTable.length,
    ...getMusicAgentCandidateSourceDiagnostics(output),
    ...selectionTraceLogProjection(output, runId, startedAt)
  };
}

function selectionTraceLogProjection(
  output: MusicAgentRunOutput,
  runId: string | undefined,
  startedAt: number
): Record<string, unknown> {
  if (!runId) return {};
  const trace = createSelectionTraceFromDecisions({
    runId,
    mode: output.mode === 'chat_recommend' ? 'explicit_request' : 'autonomous',
    createdAt: new Date(startedAt).toISOString(),
    decisions: output.selectionDecisions ?? []
  });
  return {
    selectionTrace: projectSelectionTraceForLog(trace, {
      timingMs: Math.max(0, Date.now() - startedAt)
    })
  };
}

function countSkippedPickReasons(
  skipped: SkippedPickLog[]
): Partial<Record<SkippedPickReason, number>> {
  const counts: Partial<Record<SkippedPickReason, number>> = {};
  for (const pick of skipped) counts[pick.reason] = (counts[pick.reason] ?? 0) + 1;
  return counts;
}

function getMusicAgentRoutePath(output: MusicAgentRunOutput): DjPickNextFallbackPath {
  return output.picks.some((pick) => pick.reason === 'ranked fallback')
    ? 'music_agent_ranked_recovery'
    : 'music_agent_success';
}

function hasRankedRecoveryPicks(output: MusicAgentRunOutput): boolean {
  return output.picks.some(
    (pick) => pick.reason === 'ranked fallback' || pick.reason === 'ranked convergence'
  );
}

function compactLyricsAwareDiagnostics(output: MusicAgentRunOutput): Record<string, unknown> | undefined {
  const parsedDiagnostics = lyricsAwareDiagnosticsSchema.safeParse(output.lyricsAwareDiagnostics);
  if (!parsedDiagnostics.success) return undefined;
  const diagnostics = parsedDiagnostics.data;
  return {
    mode: diagnostics.mode,
    assessmentCoverageValid: diagnostics.assessmentCoverageValid,
    assessmentValidationProblemCount: diagnostics.assessmentValidationProblems.length,
    allReturnedPicksAssessed: diagnostics.allReturnedPicksAssessed,
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
