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

  it('passes response_format through for structured JSON completions', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"type":"final"}' } }], model: 'gpt-4o'
      }), { status: 200 });
    });

    const client = new LlmClient(config);
    await client.complete([{ role: 'user', content: 'hi' }], {
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          name: 'music_agent_final_pick',
          strict: true,
          schema: {
            type: 'object',
            required: ['type'],
            properties: { type: { const: 'final' } }
          }
        }
      }
    });

    expect(capturedBody?.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'music_agent_final_pick',
        strict: true,
        schema: {
          type: 'object',
          required: ['type'],
          properties: { type: { const: 'final' } }
        }
      }
    });
  });

  it('downgrades json_schema to json_object for DeepSeek Chat Completions', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"type":"final"}' } }], model: 'deepseek-v4-flash'
      }), { status: 200 });
    });

    const client = new LlmClient({
      ...config,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash'
    });
    await client.complete([{ role: 'user', content: 'json' }], {
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          name: 'music_agent_final_pick',
          strict: true,
          schema: {
            type: 'object',
            required: ['type'],
            properties: { type: { const: 'final' } }
          }
        }
      }
    });

    expect(capturedBody?.response_format).toEqual({ type: 'json_object' });
  });

  it('passes thinking control for DeepSeek and TokenHub Hy3 but omits it for unsupported models', async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    mockFetch(async (_url, init) => {
      capturedBodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
        model: 'test-model'
      }), { status: 200 });
    });

    await new LlmClient({
      ...config,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash'
    }).complete([{ role: 'user', content: 'json' }], {
      thinking: { type: 'disabled' }
    });

    await new LlmClient(config).complete([{ role: 'user', content: 'json' }], {
      thinking: { type: 'disabled' }
    });

    await new LlmClient({
      ...config,
      baseUrl: 'https://tokenhub.tencentmaas.com/v1',
      model: 'hy3',
      thinking: { type: 'enabled' }
    }).complete([{ role: 'user', content: 'json' }]);

    expect(capturedBodies[0]?.thinking).toEqual({ type: 'disabled' });
    expect(capturedBodies[1]).not.toHaveProperty('thinking');
    expect(capturedBodies[2]?.thinking).toEqual({ type: 'enabled' });
  });

  it('raises the TokenHub Hy3 output budget when thinking is enabled', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
        model: 'hy3'
      }), { status: 200 });
    });

    await new LlmClient({
      ...config,
      baseUrl: 'https://tokenhub.tencentmaas.com/v1',
      model: 'hy3',
      thinking: { type: 'enabled' }
    }).complete([{ role: 'user', content: 'json' }], { maxTokens: 1_400 });

    expect(capturedBody?.max_tokens).toBe(128_000);
  });

  it('keeps the requested TokenHub Hy3 output budget when thinking is disabled', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
        model: 'hy3'
      }), { status: 200 });
    });

    await new LlmClient({
      ...config,
      baseUrl: 'https://tokenhub.tencentmaas.com/v1',
      model: 'hy3',
      thinking: { type: 'disabled' }
    }).complete([{ role: 'user', content: 'json' }], { maxTokens: 1_400 });

    expect(capturedBody?.max_tokens).toBe(1_400);
  });

  it('throws LlmError on non-2xx response', async () => {
    mockFetch(async () => new Response('Bad Request', { status: 400 }));
    const client = new LlmClient(config);
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      name: 'LlmError'
    });
  });

  it('includes provider response body in non-2xx errors', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ error: { message: 'model does not exist' } }), {
        status: 400,
        statusText: 'Bad Request'
      })
    );
    const client = new LlmClient(config);

    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      name: 'LlmError',
      status: 400,
      responseBody: '{"error":{"message":"model does not exist"}}',
      message: 'LLM request failed: 400 Bad Request; response body: {"error":{"message":"model does not exist"}}'
    });
  });

  it('retries 429 responses before returning a completion', async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Retry-After': '0' }
        });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'retry ok' } }],
        model: 'gpt-4o'
      }), { status: 200 });
    });

    const client = new LlmClient(config);
    const result = await client.complete([{ role: 'user', content: 'hi' }]);

    expect(result.content).toBe('retry ok');
    expect(calls).toBe(2);
  });

  it('throws the final 429 response after exhausting completion retries', async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      return new Response(`rate limited ${calls}`, {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '0' }
      });
    });

    const client = new LlmClient(config);

    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      name: 'LlmError',
      status: 429,
      responseBody: 'rate limited 3',
      message: 'LLM request failed: 429 Too Many Requests; response body: rate limited 3'
    });
    expect(calls).toBe(3);
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

  it('uses the configured TokenHub Hy3 thinking preference for stream requests', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(makeSSEStream(['data: [DONE]\n\n']), { status: 200 });
    });

    const client = new LlmClient({
      ...config,
      baseUrl: 'https://tokenhub.tencentmaas.com/v1',
      model: 'hy3',
      thinking: { type: 'enabled' }
    });
    for await (const _ of client.stream([{ role: 'user', content: 'hi' }])) { /* noop */ }

    expect(capturedBody?.thinking).toEqual({ type: 'enabled' });
    expect(capturedBody?.max_tokens).toBe(128_000);
  });

  it('retries 429 responses before yielding a stream', async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Retry-After': '0' }
        });
      }
      return new Response(makeSSEStream([
        'data: {"choices":[{"delta":{"content":"retry"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" ok"}}]}\n\n',
        'data: [DONE]\n\n'
      ]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    });

    const client = new LlmClient(config);
    const deltas: string[] = [];
    for await (const delta of client.stream([{ role: 'user', content: 'hi' }])) {
      deltas.push(delta);
    }

    expect(deltas.join('')).toBe('retry ok');
    expect(calls).toBe(2);
  });

  it('throws LlmError on non-2xx response', async () => {
    mockFetch(async () => new Response('Unauthorized', { status: 401 }));
    const client = new LlmClient(config);
    const gen = client.stream([{ role: 'user', content: 'hi' }]);
    await expect(gen.next()).rejects.toMatchObject({ name: 'LlmError' });
  });

  it('includes provider response body in non-2xx stream errors', async () => {
    mockFetch(async () =>
      new Response('invalid stream option', {
        status: 400,
        statusText: 'Bad Request'
      })
    );
    const client = new LlmClient(config);
    const gen = client.stream([{ role: 'user', content: 'hi' }]);

    await expect(gen.next()).rejects.toMatchObject({
      name: 'LlmError',
      status: 400,
      responseBody: 'invalid stream option',
      message: 'LLM stream request failed: 400 Bad Request; response body: invalid stream option'
    });
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
