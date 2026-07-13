import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTest } from '../../src/server/config';
import { resolveLlmConfig } from '../../src/server/llm/config';
import { _resetDbForTest, initDb } from '../../src/server/store/db';
import { setPref } from '../../src/server/store/prefs';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.CROSSFADIO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-llm-config-'));
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars';
  process.env.CROSSFADIO_LLM_BASE_URL = 'https://tokenhub.tencentmaas.com/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
  process.env.CROSSFADIO_LLM_MODEL = 'hy3';
  process.env.CROSSFADIO_TTS_BASE_URL = 'https://tts.example/v1';
  process.env.CROSSFADIO_TTS_API_KEY = 'sk-test-tts';
  resetConfigForTest();
  initDb();
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetConfigForTest();
  _resetDbForTest();
});

describe('resolveLlmConfig', () => {
  it('keeps thinking disabled by default', () => {
    expect(resolveLlmConfig('user-a').thinking).toEqual({ type: 'disabled' });
    expect(resolveLlmConfig().thinking).toEqual({ type: 'disabled' });
  });

  it('enables thinking only for the user who opted in', () => {
    setPref('user-a', 'llm.thinkingEnabled', true);

    expect(resolveLlmConfig('user-a').thinking).toEqual({ type: 'enabled' });
    expect(resolveLlmConfig('user-b').thinking).toEqual({ type: 'disabled' });
  });
});
