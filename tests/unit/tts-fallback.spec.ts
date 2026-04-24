import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TtsConfig } from '../../src/server/tts/client';
import {
  buildFallbackTemplateText,
  ensureFallbackTtsCached,
  getCachedFallbackTts,
  saveFallbackTtsToCache,
  synthesizeTtsWithFallback
} from '../../src/server/tts/fallback';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;

let dataDir: string;

const baseConfig: TtsConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'tts-key',
  model: 'tts-1',
  voice: 'alloy',
  speed: 1.0,
  format: 'mp3'
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-tts-fallback-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.CROSSFADIO_DATA_DIR;
  } else {
    process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  }
});

describe('buildFallbackTemplateText', () => {
  it('uses the target track title in a short reusable segue line', () => {
    const text = buildFallbackTemplateText({ id: '1', name: 'Holocene' });

    expect(text).toContain('Holocene');
    expect(text.length).toBeLessThanOrEqual(60);
  });
});

describe('fallback TTS cache', () => {
  it('returns null when the template has not been cached', () => {
    const text = buildFallbackTemplateText({ id: '1', name: 'Holocene' });

    expect(getCachedFallbackTts(baseConfig, text)).toBeNull();
  });

  it('stores fallback template audio under cache/tts/fallback/<voice>', () => {
    const text = buildFallbackTemplateText({ id: '1', name: 'Holocene' });
    const audio = Buffer.from('fallback-audio');

    const saved = saveFallbackTtsToCache(baseConfig, text, audio);
    const cached = getCachedFallbackTts(baseConfig, text);

    expect(fs.readFileSync(saved.filePath)).toEqual(audio);
    expect(cached).toEqual({ filePath: saved.filePath, cached: true });
    expect(saved.filePath).toContain(path.join('cache', 'tts', 'fallback', 'alloy'));
  });

  it('returns cached fallback audio without synthesizing again', async () => {
    const text = buildFallbackTemplateText({ id: '1', name: 'Holocene' });
    const saved = saveFallbackTtsToCache(baseConfig, text, Buffer.from('cached-fallback'));
    let synthesizeCalls = 0;

    const result = await ensureFallbackTtsCached(baseConfig, text, async () => {
      synthesizeCalls++;
      return { filePath: '/tmp/unused.mp3', cached: false };
    });

    expect(result).toEqual({ filePath: saved.filePath, cached: true });
    expect(synthesizeCalls).toBe(0);
  });

  it('synthesizes and copies template audio into fallback cache on miss', async () => {
    const text = buildFallbackTemplateText({ id: '1', name: 'Holocene' });
    const synthesizedPath = path.join(dataDir, 'normal-cache.mp3');
    fs.writeFileSync(synthesizedPath, Buffer.from('synthesized-template'));

    const result = await ensureFallbackTtsCached(baseConfig, text, async (input) => {
      expect(input).toBe(text);
      return { filePath: synthesizedPath, cached: false };
    });

    expect(result.cached).toBe(false);
    expect(result.filePath).toContain(path.join('cache', 'tts', 'fallback', 'alloy'));
    expect(fs.readFileSync(result.filePath)).toEqual(Buffer.from('synthesized-template'));
  });

  it('returns main TTS result when synthesis succeeds', async () => {
    const result = await synthesizeTtsWithFallback(
      baseConfig,
      'main segue line',
      'template line',
      async () => ({ filePath: '/tmp/main.mp3', cached: false })
    );

    expect(result).toEqual({ filePath: '/tmp/main.mp3', cached: false, fallback: false });
  });

  it('returns cached fallback template when main synthesis fails', async () => {
    const fallbackText = buildFallbackTemplateText({ id: '1', name: 'Holocene' });
    const saved = saveFallbackTtsToCache(baseConfig, fallbackText, Buffer.from('fallback-audio'));

    const result = await synthesizeTtsWithFallback(baseConfig, 'main segue line', fallbackText, async () => {
      throw new Error('tts timeout');
    });

    expect(result).toEqual({ filePath: saved.filePath, cached: true, fallback: true });
  });

  it('rethrows synthesis failure when no fallback template is cached', async () => {
    await expect(
      synthesizeTtsWithFallback(baseConfig, 'main segue line', 'template line', async () => {
        throw new Error('tts timeout');
      })
    ).rejects.toThrow('tts timeout');
  });
});
