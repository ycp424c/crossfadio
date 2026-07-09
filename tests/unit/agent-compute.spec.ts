import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeSync, computeStream, AgentError } from '../../src/server/agent/compute';
import type { Fragments } from '../../src/server/agent/schema';
import { FakeLlmClient } from '../support/fake-llm';

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    return handler(String(input), init);
  }));
}

afterEach(() => vi.unstubAllGlobals());

const llmConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o'
};

const baseFragments: Fragments = {
  mode: 'chat',
  system: 'You are a DJ.',
  corpus: { taste: 'indie', routines: 'morning', moodRules: 'chill', playlists: [] },
  env: { nowIso: '2026-04-24T09:00:00Z', localTime: '周四 09:00', weather: null, nowPlaying: null },
  memory: { recentPlays: [], recentChat: [] },
  input: { kind: 'chat', text: 'hi' },
  trace: { triggeredBy: 'user', lastDecision: null }
};

const validChatJson = JSON.stringify({
  mode: 'chat',
  intent: 'chitchat',
  say: '好的',
  actions: []
});

function makeLlmResponse(content: string) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], model: 'gpt-4o' }),
    { status: 200 }
  );
}

describe('computeSync', () => {
  it('returns validated chat output on success', async () => {
    mockFetch(async () => makeLlmResponse(validChatJson));

    const result = await computeSync(baseFragments, { llmConfig });
    expect(result.mode).toBe('chat');
    if (result.mode === 'chat') {
      expect(result.intent).toBe('chitchat');
      expect(result.say).toBe('好的');
    }
  });

  it('strips markdown code fences from LLM output', async () => {
    mockFetch(async () => makeLlmResponse(`\`\`\`json\n${validChatJson}\n\`\`\``));
    const result = await computeSync(baseFragments, { llmConfig });
    expect(result.mode).toBe('chat');
  });

  it('injects mode field when LLM omits it', async () => {
    const noMode = JSON.stringify({
      intent: 'chitchat',
      say: 'test',
      actions: []
    });
    mockFetch(async () => makeLlmResponse(noMode));
    const result = await computeSync(baseFragments, { llmConfig });
    expect(result.mode).toBe('chat');
  });

  it('retries once on schema failure and succeeds on second attempt', async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return makeLlmResponse('not-valid-json');
      }
      return makeLlmResponse(validChatJson);
    });

    const result = await computeSync(baseFragments, { llmConfig });
    expect(callCount).toBe(2);
    expect(result.mode).toBe('chat');
  });

  it('throws AgentError after two consecutive failures', async () => {
    mockFetch(async () => makeLlmResponse('still-invalid'));

    await expect(computeSync(baseFragments, { llmConfig })).rejects.toMatchObject({
      name: 'AgentError'
    });
  });

  it('handles chat mode output', async () => {
    const chatJson = JSON.stringify({
      mode: 'chat',
      intent: 'chitchat',
      say: '好的',
      actions: []
    });
    const chatFragments: Fragments = {
      ...baseFragments,
      mode: 'chat',
      input: { kind: 'chat', text: 'hi' },
      trace: { triggeredBy: 'user', lastDecision: null }
    };
    mockFetch(async () => makeLlmResponse(chatJson));
    const result = await computeSync(chatFragments, { llmConfig });
    expect(result.mode).toBe('chat');
  });

  it('normalizes legacy play chat action into swap_next', async () => {
    const chatFragments: Fragments = {
      ...baseFragments,
      mode: 'chat',
      input: { kind: 'chat', text: '来点舒缓的' },
      trace: { triggeredBy: 'user', lastDecision: null }
    };
    const llmClient = new FakeLlmClient().queueResponse(JSON.stringify({
      mode: 'chat',
      intent: 'adjust_queue',
      say: '给你换一首更缓的。',
      actions: [{ type: 'play', track: 'The A Team — Ed Sheeran' }]
    }));

    const result = await computeSync(chatFragments, { llmClient });
    expect(result.mode).toBe('chat');
    if (result.mode === 'chat') {
      expect(result.actions).toEqual([
        { type: 'swap_next', pick: { query: 'The A Team — Ed Sheeran' } }
      ]);
    }
  });
});

describe('computeStream', () => {
  function makeSSEStream(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      }
    });
  }

  it('yields delta events then done event with validated output', async () => {
    const segueJson = JSON.stringify({
      mode: 'segue',
      say: '下一首来自 Nils Frahm',
      duckingHintSec: 8,
      filterSweep: true,
      emotionTag: 'calm'
    });

    // Stream yields the JSON char by char, then done
    const sseLines = [
      ...segueJson.split('').map(c =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`
      ),
      'data: [DONE]\n\n'
    ];

    mockFetch(async () =>
      new Response(makeSSEStream(sseLines), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      })
    );

    const fragments: Fragments = {
      ...baseFragments,
      mode: 'segue',
      input: { kind: 'segueTrigger', from: { id: '1' }, to: { id: '2' } },
      trace: { triggeredBy: 'segue-hook', lastDecision: null }
    };

    const events: import('../../src/server/agent/schema').AgentEvent[] = [];
    for await (const evt of computeStream(fragments, { llmConfig })) {
      events.push(evt);
    }

    const doneEvents = events.filter(e => e.type === 'done');
    const deltaEvents = events.filter(e => e.type === 'delta');
    expect(doneEvents).toHaveLength(1);
    expect(deltaEvents.length).toBeGreaterThan(0);
    expect(doneEvents[0].type).toBe('done');
    if (doneEvents[0].type === 'done') {
      expect(doneEvents[0].output.mode).toBe('segue');
    }
  });

  it('retries non-streaming on schema failure and yields done', async () => {
    let callCount = 0;

    const validSegue = JSON.stringify({
      mode: 'segue',
      say: 'retry ok',
      emotionTag: 'calm'
    });

    mockFetch(async (_url, init) => {
      callCount++;
      const body = JSON.parse(init?.body as string) as { stream?: boolean };
      if (callCount === 1 && body.stream) {
        // First streaming call returns garbage
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"bad"}}]}\n\n'));
            c.enqueue(encoder.encode('data: [DONE]\n\n'));
            c.close();
          }
        });
        return new Response(stream, { status: 200 });
      }
      // Retry non-streaming call returns valid JSON
      return new Response(
        JSON.stringify({ choices: [{ message: { content: validSegue } }], model: 'gpt-4o' }),
        { status: 200 }
      );
    });

    const fragments: Fragments = {
      ...baseFragments,
      mode: 'segue',
      input: { kind: 'segueTrigger', from: { id: '1' }, to: { id: '2' } },
      trace: { triggeredBy: 'segue-hook', lastDecision: null }
    };

    const events: import('../../src/server/agent/schema').AgentEvent[] = [];
    for await (const evt of computeStream(fragments, { llmConfig })) {
      events.push(evt);
    }

    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
  });
});

describe('AgentError', () => {
  it('has name AgentError and extends Error', () => {
    const err = new AgentError('test');
    expect(err.name).toBe('AgentError');
    expect(err).toBeInstanceOf(Error);
  });
});
