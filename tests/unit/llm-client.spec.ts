import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmClient, LlmError } from '../../src/server/llm/client';

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    return handler(String(input), init);
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const config = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o'
};

describe('LlmClient.complete', () => {
  it('returns content from choices[0].message.content', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: 'Hello world' } }],
        model: 'gpt-4o',
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }), { status: 200 })
    );

    const client = new LlmClient(config);
    const result = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('Hello world');
    expect(result.model).toBe('gpt-4o');
    expect(result.usage?.total_tokens).toBe(15);
  });

  it('sends Authorization header with Bearer token', async () => {
    let capturedHeaders: HeadersInit | undefined;
    mockFetch(async (_url, init) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '' } }], model: 'gpt-4o'
      }), { status: 200 });
    });

    const client = new LlmClient(config);
    await client.complete([{ role: 'user', content: 'hi' }]);
    expect((capturedHeaders as Record<string, string>)?.Authorization).toBe('Bearer test-key');
  });

  it('does not include stream:true in body for complete()', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '' } }], model: 'gpt-4o'
      }), { status: 200 });
    });

    const client = new LlmClient(config);
    await client.complete([{ role: 'user', content: 'hi' }]);
    expect(capturedBody?.stream).toBeUndefined();
  });

  it('throws LlmError on non-2xx response', async () => {
    mockFetch(async () => new Response('Bad Request', { status: 400 }));
    const client = new LlmClient(config);
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      name: 'LlmError'
    });
  });

  it('propagates AbortSignal', async () => {
    mockFetch(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError'))
      );
    }));

    const ac = new AbortController();
    const client = new LlmClient(config);
    const promise = client.complete([{ role: 'user', content: 'hi' }], { signal: ac.signal });
    ac.abort();
    await expect(promise).rejects.toThrow();
  });
});

describe('LlmClient.stream', () => {
  function makeSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }
    });
  }

  it('yields delta content from SSE stream', async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n'
    ];

    mockFetch(async () =>
      new Response(makeSSEStream(sseChunks), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      })
    );

    const client = new LlmClient(config);
    const deltas: string[] = [];
    for await (const delta of client.stream([{ role: 'user', content: 'hi' }])) {
      deltas.push(delta);
    }
    expect(deltas.join('')).toBe('Hello world');
  });

  it('sends stream:true in body for stream()', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200 });
    });

    const client = new LlmClient(config);
    // consume the stream
    for await (const _ of client.stream([{ role: 'user', content: 'hi' }])) { /* noop */ }
    expect(capturedBody?.stream).toBe(true);
  });

  it('throws LlmError on non-2xx response', async () => {
    mockFetch(async () => new Response('Unauthorized', { status: 401 }));
    const client = new LlmClient(config);
    const gen = client.stream([{ role: 'user', content: 'hi' }]);
    await expect(gen.next()).rejects.toMatchObject({ name: 'LlmError' });
  });

  it('skips malformed SSE lines without throwing', async () => {
    const sseChunks = [
      'data: not-json\n\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: [DONE]\n\n'
    ];

    mockFetch(async () =>
      new Response(makeSSEStream(sseChunks), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      })
    );

    const client = new LlmClient(config);
    const deltas: string[] = [];
    for await (const delta of client.stream([{ role: 'user', content: 'hi' }])) {
      deltas.push(delta);
    }
    expect(deltas).toEqual(['ok']);
  });
});

describe('LlmError', () => {
  it('has name LlmError', () => {
    const err = new LlmError('test');
    expect(err.name).toBe('LlmError');
    expect(err.message).toBe('test');
    expect(err).toBeInstanceOf(Error);
  });
});
