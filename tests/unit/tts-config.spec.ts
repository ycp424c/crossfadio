import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../../src/server/store/db';
import { getPref, setPref } from '../../src/server/store/prefs';
import { DEFAULT_TTS_CONFIG, resolveTtsConfig } from '../../src/server/tts/config';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;

let dataDir: string;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-tts-config-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.CROSSFADIO_DATA_DIR;
  } else {
    process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  }
});

describe('resolveTtsConfig', () => {
  it('defaults to Alibaba Cloud Qwen TTS when only an API key is configured', () => {
    const secrets = { get: (key: string) => (key === 'tts.apiKey' ? 'dashscope-key' : null) };

    expect(resolveTtsConfig(secrets as never)).toEqual({
      ...DEFAULT_TTS_CONFIG,
      apiKey: 'dashscope-key'
    });
  });

  it('keeps stored overrides while preserving Alibaba provider defaults', () => {
    setPref('__legacy__', 'tts.config', { voice: 'Ethan', speed: 1.1 });
    const secrets = { get: (key: string) => (key === 'tts.apiKey' ? 'dashscope-key' : null) };

    expect(resolveTtsConfig(secrets as never)).toMatchObject({
      provider: 'aliyun-qwen',
      model: DEFAULT_TTS_CONFIG.model,
      voice: 'Ethan',
      speed: 1.1,
      apiKey: 'dashscope-key'
    });
    expect(getPref('__legacy__', 'tts.config')).toEqual({ voice: 'Ethan', speed: 1.1 });
  });

  it('treats legacy OpenAI-compatible stored configs as OpenAI-compatible', () => {
    setPref('__legacy__', 'tts.config', {
      baseUrl: 'https://api.openai.com/v1',
      model: 'tts-1',
      voice: 'alloy',
      speed: 1,
      format: 'mp3'
    });
    const secrets = { get: (key: string) => (key === 'tts.apiKey' ? 'openai-key' : null) };

    expect(resolveTtsConfig(secrets as never)).toMatchObject({
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'tts-1',
      voice: 'alloy'
    });
  });
});
