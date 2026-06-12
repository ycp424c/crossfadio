import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EmbeddingClient', () => {
  it('calls an OpenAI-compatible embeddings endpoint and returns vectors', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(JSON.stringify({
        model: 'text-embedding-v4',
        data: [
          { embedding: [0.1, 0.2, 0.3] }
        ],
        usage: { prompt_tokens: 3, total_tokens: 3 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { EmbeddingClient } = await import('../../src/server/embedding/client.js');
    const client = new EmbeddingClient({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'embedding-key',
      model: 'text-embedding-v4',
      dimensions: 1024
    });

    const result = await client.embed('city pop relaxed afternoon');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer embedding-key' }),
        body: JSON.stringify({
          model: 'text-embedding-v4',
          input: 'city pop relaxed afternoon',
          dimensions: 1024
        })
      })
    );
    expect(result.model).toBe('text-embedding-v4');
    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0][0]).toBeCloseTo(0.1);
    expect(result.vectors[0][1]).toBeCloseTo(0.2);
    expect(result.vectors[0][2]).toBeCloseTo(0.3);
    expect(result.dimensions).toBe(3);
  });

  it('throws readable HTTP errors with response body snippets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('bad embedding request', { status: 400, statusText: 'Bad Request' })
    ));
    const { EmbeddingClient } = await import('../../src/server/embedding/client.js');
    const client = new EmbeddingClient({
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'embedding-key',
      model: 'text-embedding-v4',
      dimensions: 1024
    });

    await expect(client.embed('x')).rejects.toMatchObject({
      message: 'Embedding request failed: 400 Bad Request; response body: bad embedding request'
    });
  });

  it('health check fails softly instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('embedding unavailable', { status: 503, statusText: 'Unavailable' })
    ));
    const { EmbeddingClient } = await import('../../src/server/embedding/client.js');
    const client = new EmbeddingClient({
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'embedding-key',
      model: 'text-embedding-v4',
      dimensions: 1024
    });

    const health = await client.health();

    expect(health.ok).toBe(false);
    expect(health.error).toContain('Embedding request failed: 503 Unavailable');
  });
});
