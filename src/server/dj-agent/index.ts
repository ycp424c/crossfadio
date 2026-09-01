import { randomUUID } from 'node:crypto';
import { MusicAgent } from '../music-agent/index.js';
import {
  handleMusicAgentPickNextOutput,
  publishCommittedMusicAgentPickNextSuccess
} from '../dj/musicAgentPickNextResult.js';
import { buildDjMemorySnapshot } from '../dj-memory/snapshot.js';
import { createMusicAgentSelectionAdapter } from '../dj-memory/music-agent-adapter.js';
import { buildSelectionJourney } from '../dj/selection-journey.js';
import {
  createEmptySelectionTrace,
  createFailedSelectionTrace,
  createSelectionTraceFromDecisions,
  selectionTraceFactsHash,
  selectionTraceFromMusicAgentOutput
} from '../dj/selection-trace-from-output.js';
import { saveSelectionDebugTrace } from '../store/selection-debug-traces.js';
import { saveSelectionJourney } from '../store/selection-journeys.js';
import { enqueueSelectionNarration } from '../store/selection-narration-outbox.js';
import {
  finalizeSelectionPolicyReplayCases,
  recordSelectionReplayRun
} from '../store/selection-replay.js';
import { recordSelectionRotationRound } from '../store/selection-rotation.js';
import { consumeSourceReservoirTracks } from '../store/source-reservoir.js';
import { getDb } from '../store/db.js';
import type {
  SelectionDecisionTrace,
  SelectionJourneySnapshot,
  SelectionJourneyStage
} from '../../shared/selection.js';
import type { SelectionJourneyCandidateFact } from '../dj/selection-journey.js';
import type { PromptJsonStatus } from '../music-agent/schema.js';
import {
  appendMusicAgentSelectionEvents,
  appendSelectionStartedEvent
} from './events.js';
import type {
  DJAgentMusicAgentFactory,
  DJAgentPickNextInput,
  DJAgentPickNextResult
} from './ports.js';
import { defaultDJAgentQueuePort } from './ports.js';
import { generateSegue, type GenerateSegueInput, type GenerateSegueResult } from './segue.js';

export type DJAgentOptions = {
  musicAgentFactory?: DJAgentMusicAgentFactory;
};

export class DJAgent {
  private readonly musicAgentFactory: DJAgentMusicAgentFactory;

  constructor(options: DJAgentOptions = {}) {
    this.musicAgentFactory = options.musicAgentFactory ?? ((llmConfig) => new MusicAgent({ llmConfig }));
  }

  async pickNext(input: DJAgentPickNextInput): Promise<DJAgentPickNextResult> {
    const runId = randomUUID();
    const startedAt = (input.now ?? new Date()).toISOString();
    const replayObservation: {
      candidateCount: number;
      eligibleCount: number;
      appendedCount: number;
      hardViolationCount: number;
      promptJsonStatus: PromptJsonStatus;
      journeyPublished: boolean;
    } = {
      candidateCount: 0,
      eligibleCount: 0,
      appendedCount: 0,
      hardViolationCount: 0,
      promptJsonStatus: 'not_observed',
      journeyPublished: false
    };
    let terminalReplayCommitted = false;
    recordSelectionReplayRun({
      userId: input.userId,
      runId,
      selectedTrackIds: [],
      candidateCount: 0,
      eligibleCount: 0,
      appendedCount: 0,
      latencyMs: 0,
      hardViolationCount: 0,
      promptJsonStatus: 'not_observed',
      journeyPublished: false,
      outcome: 'failed',
      reasonCodes: ['selection_run_started'],
      startedAt,
      completedAt: null
    });

    try {
    const queuePort = input.queuePort ?? defaultDJAgentQueuePort;
    const snapshot = await buildDjMemorySnapshot({
      userId: input.userId,
      now: input.now,
      selectionOptions: {
        discoveryMode: input.discoveryMode,
        includeDailyTheme: input.includeDailyTheme
      }
    });
    const selectionAdapter = createMusicAgentSelectionAdapter({
      snapshot,
      request: 'auto-fill',
      playedTrackIds: input.excludeState.ids,
      playedTrackKeys: input.excludeState.dedupeKeys
    });
    const runningTrace = createEmptySelectionTrace({ runId, mode: 'autonomous', createdAt: startedAt });
    let revision = 0;
    let latestProgressIndex = 0;
    publishJourney({
      input,
      trace: runningTrace,
      candidates: [],
      revision: 0,
      status: 'running',
      updatedAt: startedAt
    });
    replayObservation.journeyPublished = true;
    const selectionStartedEvent = appendSelectionStartedEvent({
      userId: input.userId,
      runId,
      targetPickCount: input.targetPickCount,
      snapshot
    });

    let output;
    try {
      output = await this.musicAgentFactory(input.llmConfig).pickNext({
        userId: input.userId,
        replayRunId: runId,
        ncmClient: input.ncmClient,
        signal: input.signal,
        includeDailyTheme: input.includeDailyTheme,
        excludeTrackIds: input.excludeState.ids,
        excludeTrackDedupeKeys: input.excludeState.dedupeKeys,
        targetPickCount: input.targetPickCount,
        now: input.now,
        selectionAdapter,
        onReplayObservation: (observation) => {
          replayObservation.candidateCount = Math.max(
            replayObservation.candidateCount,
            observation.candidateCount
          );
          replayObservation.promptJsonStatus = observation.promptJsonStatus;
        },
        onProgress: (progress) => {
          const progressIndex = progressStageIndex(progress.stage);
          if (progressIndex <= latestProgressIndex) return;
          latestProgressIndex = progressIndex;
          revision += 1;
          publishJourney({
            input,
            trace: createSelectionTraceFromDecisions({
              runId,
              mode: 'autonomous',
              createdAt: startedAt,
              decisions: progress.selectionDecisions
            }),
            candidates: progress.candidates,
            revision,
            status: 'running',
            updatedAt: completionTime(startedAt),
            activeStage: progress.stage
          });
          replayObservation.journeyPublished = true;
        }
      });
      replayObservation.promptJsonStatus = output.promptJsonStatus ?? 'not_observed';
      replayObservation.candidateCount = Math.max(
        replayObservation.candidateCount,
        output.candidateScoreTable.length
      );
    } catch (error) {
      const failedTrace = createFailedSelectionTrace({ runId, mode: 'autonomous', createdAt: startedAt });
      const completedAt = completionTime(startedAt);
      saveSelectionDebugTrace({ userId: input.userId, trace: failedTrace });
      publishJourney({
        input,
        trace: failedTrace,
        candidates: [],
        status: 'failed',
        revision: revision + 1,
        updatedAt: completedAt,
        finalReplayRun: {
          userId: input.userId,
          runId,
          selectedTrackIds: [],
          candidateCount: replayObservation.candidateCount,
          eligibleCount: replayObservation.eligibleCount,
          appendedCount: replayObservation.appendedCount,
          latencyMs: Math.max(0, Date.now() - input.startedAt),
          hardViolationCount: replayObservation.hardViolationCount,
          promptJsonStatus: replayObservation.promptJsonStatus,
          journeyPublished: true,
          outcome: 'failed',
          reasonCodes: ['selection_run_failed'],
          startedAt,
          completedAt
        }
      });
      replayObservation.journeyPublished = true;
      terminalReplayCommitted = true;
      throw error;
    }

    if (output.status !== 'ok') {
      const projected = selectionTraceFromMusicAgentOutput({ runId, createdAt: startedAt, output });
      saveSelectionDebugTrace({ userId: input.userId, trace: projected.trace });
      const completedAt = completionTime(startedAt);
      publishJourney({
        input,
        ...projected,
        revision: revision + 1,
        status: 'failed',
        updatedAt: completedAt,
        finalReplayRun: {
          userId: input.userId,
          runId,
          selectedTrackIds: [],
          candidateCount: replayObservation.candidateCount,
          eligibleCount: 0,
          appendedCount: 0,
          latencyMs: Math.max(0, Date.now() - input.startedAt),
          hardViolationCount: 0,
          promptJsonStatus: replayObservation.promptJsonStatus,
          journeyPublished: true,
          outcome: output.status === 'empty_pool' ? 'empty' : 'failed',
          reasonCodes: projected.trace.decisions.map((decision) => decision.reasonCode),
          startedAt,
          completedAt
        }
      });
      replayObservation.journeyPublished = true;
      return {
        status: 'aborted',
        debugBroadcastSent: false,
        output,
        runId,
        selectionStartedEventId: selectionStartedEvent.id
      };
    }

    const handled = handleMusicAgentPickNextOutput({
      userId: input.userId,
      output,
      excludeState: input.excludeState,
      initialQueueRevision: input.initialQueueRevision,
      targetPickCount: input.targetPickCount,
      startedAt: input.startedAt,
      discoveryMode: input.discoveryMode,
      emit: input.emit,
      logger: input.logger,
      queuePort,
      recordRouteOutcome: input.recordRouteOutcome,
      fallbackStatsSnapshot: input.fallbackStatsSnapshot,
      runId
    });
    const projected = selectionTraceFromMusicAgentOutput({
      runId,
      createdAt: startedAt,
      output,
      finalQueueDecisions: handled.finalQueueDecisions
    });

    const completedAt = completionTime(startedAt);
    const selectedDecisionIds = new Set(handled.finalQueueDecisions
      .filter((item) => item.decision.action === 'select')
      .map((item) => item.candidateId));
    replayObservation.eligibleCount = selectedDecisionIds.size;
    replayObservation.appendedCount = handled.appendedCount;
    replayObservation.hardViolationCount = handled.appendedTrackIds
      .filter((id) => !selectedDecisionIds.has(id)).length;
    const preparedQueue = handled.appendedCount > 0
      ? queuePort.prepareAppend(input.userId, handled.appendedTracks)
      : undefined;
    if (handled.appendedCount > 0 && !handled.successPublication) {
      throw new Error('successful queue plan is missing publication metadata');
    }
    const terminalSnapshot = commitJourney({
      input,
      ...projected,
      revision: revision + 1,
      status: handled.completion === 'superseded'
        ? 'superseded'
        : handled.appendedCount > 0
          ? 'completed'
          : 'failed',
      updatedAt: completedAt,
      finalReplayRun: {
        userId: input.userId,
        runId,
        selectedTrackIds: handled.appendedTrackIds,
        candidateCount: replayObservation.candidateCount,
        eligibleCount: selectedDecisionIds.size,
        appendedCount: handled.appendedCount,
        latencyMs: Math.max(0, Date.now() - input.startedAt),
        hardViolationCount: replayObservation.hardViolationCount,
        promptJsonStatus: replayObservation.promptJsonStatus,
        journeyPublished: true,
        outcome: handled.completion === 'superseded'
          ? 'superseded'
          : handled.appendedCount > 0
            ? 'succeeded'
            : 'empty',
        reasonCodes: handled.finalQueueDecisions.flatMap((item) => item.decision.reasonCodes),
        startedAt,
        completedAt
      },
      transactionalWrite: () => {
        preparedQueue?.persist();
        saveSelectionDebugTrace({ userId: input.userId, trace: projected.trace });
        finalizeSelectionPolicyReplayCases({
          userId: input.userId,
          runId,
          decisions: handled.finalQueueDecisions
        });
        if (preparedQueue) {
          consumeSourceReservoirTracks({
            userId: input.userId,
            runId,
            trackIds: handled.appendedTrackIds,
            consumedAt: completedAt
          });
          appendMusicAgentSelectionEvents({
            userId: input.userId,
            runId,
            output,
            appendedTracks: handled.appendedTracks,
            queueAfter: preparedQueue.snapshot.queue,
            selectionStartedEventId: selectionStartedEvent.id
          });
          recordSelectionRotationRound({
            userId: input.userId,
            runId,
            selectedAt: completedAt,
            tracks: handled.appendedTracks.map((track) => ({
              id: track.ncmId,
              name: track.name ?? track.ncmId,
              artists: track.artists ?? []
            }))
          });
        }
      }
    });
    terminalReplayCommitted = true;
    preparedQueue?.commitCache();
    replayObservation.journeyPublished = true;
    input.emit({ type: 'selection.journey', snapshot: terminalSnapshot });
    if (handled.successPublication) {
      publishCommittedMusicAgentPickNextSuccess({
        userId: input.userId,
        publication: handled.successPublication,
        excludeState: input.excludeState,
        targetPickCount: input.targetPickCount,
        emit: input.emit,
        broadcastAppended: input.broadcastAppended,
        logger: input.logger,
        setPickReason: input.setPickReason
      });
    }

    return {
      status: handled.status,
      completion: handled.completion,
      debugBroadcastSent: true,
      appendedCount: handled.appendedCount,
      appendedTrackIds: handled.appendedTrackIds,
      output,
      runId,
      selectionStartedEventId: selectionStartedEvent.id
    };
    } catch (error) {
      if (!terminalReplayCommitted) {
        recordSelectionReplayRun({
          userId: input.userId,
          runId,
          selectedTrackIds: [],
          candidateCount: replayObservation.candidateCount,
          eligibleCount: replayObservation.eligibleCount,
          appendedCount: replayObservation.appendedCount,
          latencyMs: Math.max(0, Date.now() - input.startedAt),
          hardViolationCount: replayObservation.hardViolationCount,
          promptJsonStatus: replayObservation.promptJsonStatus,
          journeyPublished: replayObservation.journeyPublished,
          outcome: 'failed',
          reasonCodes: ['selection_run_failed'],
          startedAt,
          completedAt: completionTime(startedAt)
        });
      }
      throw error;
    }
  }

  async generateSegue(input: GenerateSegueInput): Promise<GenerateSegueResult | null> {
    return generateSegue(input);
  }
}

type JourneyCommitInput = {
  input: DJAgentPickNextInput;
  trace: SelectionDecisionTrace;
  candidates: SelectionJourneyCandidateFact[];
  revision: number;
  status: SelectionJourneySnapshot['status'];
  updatedAt: string;
  activeStage?: SelectionJourneyStage;
  finalReplayRun?: Parameters<typeof recordSelectionReplayRun>[0];
  transactionalWrite?: () => void;
};

function commitJourney(input: JourneyCommitInput): SelectionJourneySnapshot {
  const snapshot = buildSelectionJourney({
    trace: input.trace,
    candidates: input.candidates,
    revision: input.revision,
    status: input.status,
    updatedAt: input.updatedAt,
    ...(input.activeStage ? { activeStage: input.activeStage } : {})
  });
  const factsHash = selectionTraceFactsHash({ trace: input.trace, candidates: input.candidates });
  getDb().transaction(() => {
    input.transactionalWrite?.();
    const journey = saveSelectionJourney({
      userId: input.input.userId,
      factsHash,
      snapshot
    });
    if (snapshot.status === 'completed' && snapshot.narration.status === 'pending') {
      enqueueSelectionNarration({
        journeyId: journey.id,
        userId: input.input.userId,
        runId: snapshot.runId,
        journeyVersion: snapshot.journeyVersion,
        factsHash
      });
    }
    if (input.finalReplayRun) recordSelectionReplayRun(input.finalReplayRun);
  }).immediate();
  return snapshot;
}

function publishJourney(input: JourneyCommitInput): void {
  const snapshot = commitJourney(input);
  input.input.emit({ type: 'selection.journey', snapshot });
}

function completionTime(startedAt: string): string {
  return new Date(Math.max(Date.now(), Date.parse(startedAt))).toISOString();
}

function progressStageIndex(stage: Exclude<SelectionJourneyStage, 'understanding'>): number {
  return ({ recall: 1, filtering: 2, balancing: 3, finalizing: 4 } as const)[stage];
}

export { generateSegue } from './segue.js';
export type {
  DJAgentPickNextInput,
  DJAgentPickNextResult
} from './ports.js';
