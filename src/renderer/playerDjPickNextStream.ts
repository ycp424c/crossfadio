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
};

type PickNextStream = (input: PickNextStreamInput) => AsyncIterable<SseStreamEvent>;

export type PlayerPickNextDebugEvent = Extract<PlayerPickNextSseEvent, { type: 'dj.debug' }>;
export type PlayerPickNextDoneEvent = Extract<PlayerPickNextSseEvent, { type: 'dj.pick-next.done' }>;

export type ConsumePlayerPickNextStreamInput = PickNextStreamInput & {
  stream?: PickNextStream;
  onQueueAppended(track: QueueTrackDto): void;
  onDebug(event: PlayerPickNextDebugEvent): void;
  onDone(event: PlayerPickNextDoneEvent): void;
};

export async function consumePlayerPickNextStream(input: ConsumePlayerPickNextStreamInput): Promise<void> {
  const readStream = input.stream ?? streamPickNext;
  for await (const { type, data } of readStream({ queue: input.queue, currentIndex: input.currentIndex })) {
    const event = parsePlayerPickNextSseEvent(type, data);
    if (!event) continue;
    if (event.type === 'queue-appended') {
      input.onQueueAppended(event.track);
    } else if (event.type === 'dj.debug') {
      input.onDebug(event);
    } else if (event.type === 'dj.pick-next.done') {
      input.onDone(event);
    }
  }
}
