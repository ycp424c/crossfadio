import type { QueueTrackDto } from '@shared/schema';
import {
  parsePlayerPickNextSseEvent,
  type PlayerPickNextSseEvent
} from './playerSseEvents';
import {
  streamPickNext,
  type SseStreamEvent
} from './sse/client';

type PickNextStreamInput = {
  queue: QueueTrackDto[];
  currentIndex: number;
  revision: number;
  authToken?: string;
};

type PickNextStream = (input: PickNextStreamInput) => AsyncIterable<SseStreamEvent>;

export type PlayerPickNextDebugEvent = Extract<PlayerPickNextSseEvent, { type: 'dj.debug' }>;
export type PlayerPickNextDoneEvent = Extract<PlayerPickNextSseEvent, { type: 'dj.pick-next.done' }>;

export type PlayerAccountCapture = {
  token: string | null;
  isActive(): boolean;
};

export function createPlayerAccountScope(initialToken: string | null): {
  updateToken(token: string | null): boolean;
  capture(): PlayerAccountCapture;
} {
  let token = initialToken;
  let generation = 0;
  return {
    updateToken(nextToken) {
      if (nextToken === token) return false;
      token = nextToken;
      generation += 1;
      return true;
    },
    capture() {
      const capturedToken = token;
      const capturedGeneration = generation;
      return {
        token: capturedToken,
        isActive: () => token === capturedToken && generation === capturedGeneration
      };
    }
  };
}

export type ConsumePlayerPickNextStreamInput = PickNextStreamInput & {
  stream?: PickNextStream;
  isActive?(): boolean;
  onQueueReplaced(queue: QueueTrackDto[], currentIndex: number, revision: number | null): void;
  onDebug(event: PlayerPickNextDebugEvent): void;
  onJourney(snapshot: Extract<PlayerPickNextSseEvent, { type: 'selection.journey' }>['snapshot']): void;
  onDone(event: PlayerPickNextDoneEvent): void;
};

export async function consumePlayerPickNextStream(input: ConsumePlayerPickNextStreamInput): Promise<void> {
  const readStream = input.stream ?? streamPickNext;
  for await (const { type, data } of readStream({
    queue: input.queue,
    currentIndex: input.currentIndex,
    revision: input.revision,
    ...(input.authToken ? { authToken: input.authToken } : {})
  })) {
    if (input.isActive?.() === false) break;
    const event = parsePlayerPickNextSseEvent(type, data);
    if (!event) continue;
    if (event.type === 'queue-updated') {
      input.onQueueReplaced(event.queue, event.currentIndex, event.revision);
    } else if (event.type === 'dj.debug') {
      input.onDebug(event);
    } else if (event.type === 'selection.journey') {
      input.onJourney(event.snapshot);
    } else if (event.type === 'dj.pick-next.done') {
      input.onDone(event);
    }
  }
}
