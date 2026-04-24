import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCacheHash } from '../../src/server/tts/cache';
import { TtsClient, TtsError } from '../../src/server/tts/client';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-tts-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalDataDir === undefined) {
    delete process.env.CROSSFADIO_DATA_DIR;
  } else {
    process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  }
});

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    return handler(String(input), init);
  }));
}

const baseConfig = {
  provider: 'openai-compatible' as const,
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'tts-key',
  model: 'tts-1',
  voice: 'alloy',
  speed: 1.0,
  format: 'mp3' as const
};

describe('buildCacheHash', () => {
  it('produces consistent hash for identical keys', () => {
    const key = { endpoint: 'https://a.com', model: 'm', voice: 'v', speed: 1.0, format: 'mp3', text: 'hello' };
    expect(buildCacheHash(key)).toBe(buildCacheHash(key));
  });

  it('produces different hash for different text', () => {
    const base = { endpoint: 'https://a.com', model: 'm', voice: 'v', speed: 1.0, format: 'mp3' };
    expect(buildCacheHash({ ...base, text: 'hello' })).not.toBe(buildCacheHash({ ...base, text: 'world' }));
  });

  it('produces different hash for different voice', () => {
    const base = { endpoint: 'https://a.com', model: 'm', speed: 1.0, format: 'mp3', text: 'hello' };
    expect(buildCacheHash({ ...base, voice: 'alloy' })).not.toBe(buildCacheHash({ ...base, voice: 'echo' }));
  });
});

describe('TtsClient.synthesize', () => {
  it('calls TTS API and saves file when cache miss', async () => {
    const fakeAudio = Buffer.from('fakemp3data');
    mockFetch(async () =>
      new Response(fakeAudio, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
    );

    const client = new TtsClient(baseConfig);
    const result = await client.synthesize('Hello DJ');

    expect(result.cached).toBe(false);
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.readFileSync(result.filePath)).toEqual(fakeAudio);
  });

  it('returns cached file on second call without fetching again', async () => {
    const fakeAudio = Buffer.from('cachedaudio');
    let fetchCalls = 0;
    mockFetch(async () => {
      fetchCalls++;
      return new Response(fakeAudio, { status: 200 });
    });

    const client = new TtsClient(baseConfig);
    const first = await client.synthesize('Cached text');
    const second = await client.synthesize('Cached text');

    expect(fetchCalls).toBe(1);
    expect(second.cached).toBe(true);
    expect(second.filePath).toBe(first.filePath);
  });

  it('sends correct request body to TTS endpoint', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    mockFetch(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(Buffer.from('audio'), { status: 200 });
    });

    const client = new TtsClient({ ...baseConfig, voice: 'echo', speed: 1.2 });
    await client.synthesize('Test input');

    expect(capturedBody?.input).toBe('Test input');
    expect(capturedBody?.voice).toBe('echo');
    expect(capturedBody?.speed).toBe(1.2);
    expect(capturedBody?.response_format).toBe('mp3');
  });

  it('throws TtsError on non-2xx response', async () => {
    mockFetch(async () => new Response('Bad Gateway', { status: 502 }));
    const client = new TtsClient(baseConfig);
    await expect(client.synthesize('fail')).rejects.toMatchObject({ name: 'TtsError' });
  });

  it('file is saved under cache/tts directory', async () => {
    mockFetch(async () => new Response(Buffer.from('audio'), { status: 200 }));
    const client = new TtsClient(baseConfig);
    const result = await client.synthesize('path check');
    expect(result.filePath).toContain(path.join('cache', 'tts'));
  });

  it('calls Alibaba Qwen TTS endpoint and downloads returned audio URL', async () => {
    const fakeAudio = Buffer.from('aliyun-audio');
    const urls: string[] = [];
    let capturedBody: Record<string, unknown> | undefined;
    mockFetch(async (url, init) => {
      urls.push(url);
      if (url.includes('/services/aigc/multimodal-generation/generation')) {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return Response.json({
          output: {
            audio: {
              url: 'https://dashscope-result.example/audio.wav'
            }
          }
        });
      }
      return new Response(fakeAudio, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
    });

    const client = new TtsClient({
      provider: 'aliyun-qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      apiKey: 'dashscope-key',
      model: 'qwen-tts',
      voice: 'Cherry',
      speed: 1,
      format: 'mp3'
    });
    const result = await client.synthesize('你好，欢迎回来');

    expect(urls).toEqual([
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
      'https://dashscope-result.example/audio.wav'
    ]);
    expect(capturedBody).toEqual({
      model: 'qwen-tts',
      input: {
        text: '你好，欢迎回来',
        voice: 'Cherry',
        language_type: 'Auto'
      }
    });
    expect(fs.readFileSync(result.filePath)).toEqual(fakeAudio);
  });
});

describe('TtsError', () => {
  it('has name TtsError and extends Error', () => {
    const err = new TtsError('fail');
    expect(err.name).toBe('TtsError');
    expect(err).toBeInstanceOf(Error);
  });
});
