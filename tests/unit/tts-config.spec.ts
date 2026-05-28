import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../../src/server/store/db';
import { setPref } from '../../src/server/store/prefs';
import { DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, resolveTtsConfig } from '../../src/server/tts/config';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
const originalTtsKey = process.env.CROSSFADIO_TTS_API_KEY;

let dataDir: string;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-tts-config-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  // Set required env vars
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars-long!!';
  process.env.CROSSFADIO_LLM_BASE_URL = 'http://localhost:8080/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
  process.env.CROSSFADIO_LLM_MODEL = 'gpt-test';
  process.env.CROSSFADIO_TTS_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  process.env.CROSSFADIO_TTS_API_KEY = 'dashscope-key';
  const { resetConfigForTest } = await import('../../src/server/config');
  resetConfigForTest();
  initDb();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  if (originalTtsKey === undefined) delete process.env.CROSSFADIO_TTS_API_KEY;
  else process.env.CROSSFADIO_TTS_API_KEY = originalTtsKey;
});

describe('resolveTtsConfig', () => {
  it('defaults to default voice when no user pref is set', () => {
    const config = resolveTtsConfig('user1');

    expect(config.apiKey).toBe('dashscope-key');
    expect(config.model).toBe(DEFAULT_TTS_MODEL);
    expect(config.voice).toBe(DEFAULT_TTS_VOICE);
    expect(config.provider).toBe('aliyun-qwen');
  });

  it('uses user voice preference when set', () => {
    setPref('user2', 'tts.voice', 'Ethan');

    const config = resolveTtsConfig('user2');

    expect(config.voice).toBe('Ethan');
  });

  it('each userId gets their own voice preference', () => {
    setPref('userA', 'tts.voice', 'Alloy');
    setPref('userB', 'tts.voice', 'Cherry');

    expect(resolveTtsConfig('userA').voice).toBe('Alloy');
    expect(resolveTtsConfig('userB').voice).toBe('Cherry');
  });
});
