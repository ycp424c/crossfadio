import type { FinalSelectionResult } from '../dj/finalSelectionResult.js';
import { appendFinalSelectionEvents } from '../dj/eventLogging.js';
import {
  appendDjEvent,
  type DjEventRecord
} from '../store/dj-events.js';
import type { DjContextSnapshot } from './context.js';
import { defaultDJAgentQueuePort, type DJAgentQueuePort } from './ports.js';

export function appendSelectionStartedEvent(input: {
  userId: string;
  runId: string;
  targetPickCount: number;
  snapshot: DjContextSnapshot;
}): DjEventRecord {
  return appendDjEvent({
    userId: input.userId,
    type: 'selection_started',
    correlationId: input.runId,
    runId: input.runId,
    payload: {
      trigger: 'auto_fill',
      targetCount: input.targetPickCount,
      activeDirective: truncate(input.snapshot.musicSelectionContext.activeDirective, 800) || undefined
    }
  });
}

export function appendMusicAgentSelectionEvents(input: {
  userId: string;
  runId: string;
  finalSelection: FinalSelectionResult;
  selectionStartedEventId: string;
  queuePort?: DJAgentQueuePort;
}): void {
  const queuePort = input.queuePort ?? defaultDJAgentQueuePort;
  appendFinalSelectionEvents({
    userId: input.userId,
    context: {
      runId: input.runId,
      selectionStartedEventId: input.selectionStartedEventId
    },
    finalSelection: input.finalSelection,
    queue: queuePort.getQueue(input.userId)
  });
}

function truncate(value: string | undefined, maxLength: number): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength);
}
