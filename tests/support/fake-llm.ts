import type { LlmClientLike } from '../../src/server/agent/compute';
import type { LlmMessage, LlmResponse } from '../../src/server/llm/client';

type CallRecord = { messages: LlmMessage[] };

/**
 * FakeLlmClient — test double for LlmClient.
 *
 * Usage:
 *   const fake = new FakeLlmClient();
 *   fake.queueResponse('{"mode":"chat",...}');      // for complete()
 *   fake.queueStreamDeltas(['hello', ' world']);     // for stream()
 */
export class FakeLlmClient implements LlmClientLike {
  private responseQueue: string[] = [];
  private streamQueue: string[][] = [];
  readonly completeCalls: CallRecord[] = [];
  readonly streamCalls: CallRecord[] = [];

  /** Enqueue a response string for the next complete() call. */
  queueResponse(content: string): this {
    this.responseQueue.push(content);
    return this;
  }

  /** Enqueue a list of delta strings for the next stream() call. */
  queueStreamDeltas(deltas: string[]): this {
    this.streamQueue.push(deltas);
    return this;
  }

  async complete(messages: LlmMessage[]): Promise<LlmResponse> {
    this.completeCalls.push({ messages: [...messages] });
    const content = this.responseQueue.shift() ?? '{}';
    return { content, model: 'fake-model' };
  }

  async *stream(messages: LlmMessage[]): AsyncIterable<string> {
    this.streamCalls.push({ messages: [...messages] });
    const deltas = this.streamQueue.shift() ?? [];
    for (const delta of deltas) {
      yield delta;
    }
  }
}
