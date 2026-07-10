import { randomUUID } from 'node:crypto';
import { MusicAgent } from '../music-agent/index.js';
import type { FinalSelectionResult } from '../dj/finalSelectionResult.js';
import { handleMusicAgentPickNextOutput } from '../dj/musicAgentPickNextResult.js';
import { buildDjContextSnapshot } from './context.js';
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
  selectionStartedEventRecorder?: typeof appendSelectionStartedEvent;
  selectionEventRecorder?: typeof appendMusicAgentSelectionEvents;
};

export class DJAgent {
  private readonly musicAgentFactory: DJAgentMusicAgentFactory;
  private readonly selectionStartedEventRecorder: typeof appendSelectionStartedEvent;
  private readonly selectionEventRecorder: typeof appendMusicAgentSelectionEvents;

  constructor(options: DJAgentOptions = {}) {
    this.musicAgentFactory = options.musicAgentFactory ?? ((llmConfig) => new MusicAgent({ llmConfig }));
    this.selectionStartedEventRecorder = options.selectionStartedEventRecorder ?? appendSelectionStartedEvent;
    this.selectionEventRecorder = options.selectionEventRecorder ?? appendMusicAgentSelectionEvents;
  }

  async pickNext(input: DJAgentPickNextInput): Promise<DJAgentPickNextResult> {
    const runId = randomUUID();
    const queuePort = input.queuePort ?? defaultDJAgentQueuePort;
    const snapshot = await buildDjContextSnapshot({
      userId: input.userId,
      ncmClient: input.ncmClient,
      includeDailyTheme: input.includeDailyTheme,
      now: input.now
    });
    // dj_events has no foreign key on causation_event_id. If persisting the start event
    // fails, the run id is a stable sentinel used only to preserve correlation downstream.
    let selectionStartedEventId: string = runId;
    try {
      selectionStartedEventId = this.selectionStartedEventRecorder({
        userId: input.userId,
        runId,
        targetPickCount: input.targetPickCount,
        snapshot
      }).id;
    } catch (err) {
      input.logger.warn(
        { err, runId },
        'DJ pick-next: selection started event persistence failed'
      );
    }

    const output = await this.musicAgentFactory(input.llmConfig).pickNext({
      userId: input.userId,
      ncmClient: input.ncmClient,
      signal: input.signal,
      includeDailyTheme: input.includeDailyTheme,
      excludeTrackIds: input.excludeState.ids,
      excludeTrackDedupeKeys: input.excludeState.dedupeKeys,
      targetPickCount: input.targetPickCount,
      context: snapshot.musicSelectionContext
    });

    if (output.status !== 'ok') {
      return {
        status: 'aborted',
        debugBroadcastSent: false,
        output,
        runId,
        selectionStartedEventId
      };
    }

    let finalSelection: FinalSelectionResult | undefined;
    const handled = handleMusicAgentPickNextOutput({
      userId: input.userId,
      output,
      excludeState: input.excludeState,
      initialQueueLength: input.initialQueueLength,
      targetPickCount: input.targetPickCount,
      startedAt: input.startedAt,
      discoveryMode: input.discoveryMode,
      emit: input.emit,
      broadcastAppended: input.broadcastAppended,
      logger: input.logger,
      queuePort,
      setPickReason: input.setPickReason,
      onFinalSelection: (result) => {
        finalSelection = result;
      },
      recordRouteOutcome: input.recordRouteOutcome,
      fallbackStatsSnapshot: input.fallbackStatsSnapshot
    });

    if (finalSelection) {
      try {
        this.selectionEventRecorder({
          userId: input.userId,
          runId,
          finalSelection,
          selectionStartedEventId,
          queuePort
        });
      } catch (err) {
        input.logger.warn(
          { err, runId },
          'DJ pick-next: selection event persistence failed'
        );
      }
    }

    return {
      ...handled,
      output,
      runId,
      selectionStartedEventId
    };
  }

  async generateSegue(input: GenerateSegueInput): Promise<GenerateSegueResult | null> {
    return generateSegue(input);
  }
}

export { buildDjContextSnapshot } from './context.js';
export { generateSegue } from './segue.js';
export type { DjContextSnapshot } from './context.js';
export type {
  DJAgentPickNextInput,
  DJAgentPickNextResult
} from './ports.js';
