import { randomUUID } from 'node:crypto';
import { MusicAgent } from '../music-agent/index.js';
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
};

export class DJAgent {
  private readonly musicAgentFactory: DJAgentMusicAgentFactory;

  constructor(options: DJAgentOptions = {}) {
    this.musicAgentFactory = options.musicAgentFactory ?? ((llmConfig) => new MusicAgent({ llmConfig }));
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
    const selectionStartedEvent = appendSelectionStartedEvent({
      userId: input.userId,
      runId,
      targetPickCount: input.targetPickCount,
      snapshot
    });

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
        runId
      };
    }

    const queueBeforeLength = queuePort.getQueue(input.userId).length;
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
      fallbackStatsSnapshot: input.fallbackStatsSnapshot
    });

    appendMusicAgentSelectionEvents({
      userId: input.userId,
      runId,
      output,
      queueBeforeLength,
      selectionStartedEventId: selectionStartedEvent.id,
      queuePort
    });

    return {
      ...handled,
      output,
      runId
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
