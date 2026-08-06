import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../../src/server/store/db';
import { setPref } from '../../src/server/store/prefs';
import {
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_VOICE,
  resolveEffectiveVoiceForProvider,
  resolveTtsConfig,
  TENCENT_DEFAULT_VOICE_ID
} from '../../src/server/tts/config';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
const originalTtsKey = process.env.CROSSFADIO_TTS_API_KEY;
const originalTtsProvider = process.env.CROSSFADIO_TTS_PROVIDER;
const originalTtsSecretId = process.env.CROSSFADIO_TTS_SECRET_ID;
const originalTtsSecretKey = process.env.CROSSFADIO_TTS_SECRET_KEY;
const originalTtsModel = process.env.CROSSFADIO_TTS_MODEL;
const originalTtsVoiceDefault = process.env.CROSSFADIO_TTS_VOICE_DEFAULT;

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
  delete process.env.CROSSFADIO_TTS_PROVIDER;
  delete process.env.CROSSFADIO_TTS_SECRET_ID;
  delete process.env.CROSSFADIO_TTS_SECRET_KEY;
  delete process.env.CROSSFADIO_TTS_MODEL;
  delete process.env.CROSSFADIO_TTS_VOICE_DEFAULT;
  const { resetConfigForTest } = await import('../../src/server/config');
  resetConfigForTest();
  initDb();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
  if (originalTtsKey === undefined) delete process.env.CROSSFADIO_TTS_API_KEY;
  else process.env.CROSSFADIO_TTS_API_KEY = originalTtsKey;
  if (originalTtsProvider === undefined) delete process.env.CROSSFADIO_TTS_PROVIDER;
  else process.env.CROSSFADIO_TTS_PROVIDER = originalTtsProvider;
  if (originalTtsSecretId === undefined) delete process.env.CROSSFADIO_TTS_SECRET_ID;
  else process.env.CROSSFADIO_TTS_SECRET_ID = originalTtsSecretId;
  if (originalTtsSecretKey === undefined) delete process.env.CROSSFADIO_TTS_SECRET_KEY;
  else process.env.CROSSFADIO_TTS_SECRET_KEY = originalTtsSecretKey;
  if (originalTtsModel === undefined) delete process.env.CROSSFADIO_TTS_MODEL;
  else process.env.CROSSFADIO_TTS_MODEL = originalTtsModel;
  if (originalTtsVoiceDefault === undefined) delete process.env.CROSSFADIO_TTS_VOICE_DEFAULT;
  else process.env.CROSSFADIO_TTS_VOICE_DEFAULT = originalTtsVoiceDefault;
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
    setPref('userA', 'tts.voice', 'Ethan');
    setPref('userB', 'tts.voice', 'Cherry');

    expect(resolveTtsConfig('userA').voice).toBe('Ethan');
    expect(resolveTtsConfig('userB').voice).toBe('Cherry');
  });

  it('normalizes a legacy OpenAI voice to a valid Qwen voice for aliyun-qwen', () => {
    setPref('userC', 'tts.voice', 'alloy');

    const config = resolveTtsConfig('userC');

    expect(config.provider).toBe('aliyun-qwen');
    expect(config.voice).toBe(DEFAULT_TTS_VOICE);
  });

  it('prefers the current provider-scoped voice over the legacy shared voice', () => {
    setPref('userD', 'tts.voice', 'Cherry');
    setPref('userD', 'tts.voice.aliyun-qwen', 'Ethan');

    expect(resolveTtsConfig('userD').voice).toBe('Ethan');
  });
});

describe('resolveTtsConfig with openai-compatible provider', () => {
  it('falls back to the configured provider voice when a Tencent digit voice id lingers in the pref', async () => {
    process.env.CROSSFADIO_TTS_PROVIDER = 'openai-compatible';
    process.env.CROSSFADIO_TTS_MODEL = 'gpt-4o-mini-tts';
    process.env.CROSSFADIO_TTS_VOICE_DEFAULT = 'alloy';
    const { resetConfigForTest } = await import('../../src/server/config');
    resetConfigForTest();
    setPref('userT', 'tts.voice', '1001');

    const config = resolveTtsConfig('userT');

    expect(config.provider).toBe('openai-compatible');
    expect(config.voice).toBe('alloy');
  });

  it('keeps non-digit voice names unchanged', async () => {
    process.env.CROSSFADIO_TTS_PROVIDER = 'openai-compatible';
    process.env.CROSSFADIO_TTS_MODEL = 'gpt-4o-mini-tts';
    process.env.CROSSFADIO_TTS_VOICE_DEFAULT = 'alloy';
    const { resetConfigForTest } = await import('../../src/server/config');
    resetConfigForTest();
    setPref('userT', 'tts.voice', 'nova');

    expect(resolveTtsConfig('userT').voice).toBe('nova');
  });

  it('uses CROSSFADIO_TTS_MODEL when configured for non-Tencent providers', async () => {
    process.env.CROSSFADIO_TTS_PROVIDER = 'openai-compatible';
    process.env.CROSSFADIO_TTS_MODEL = 'gpt-4o-mini-tts';
    process.env.CROSSFADIO_TTS_VOICE_DEFAULT = 'alloy';
    const { resetConfigForTest } = await import('../../src/server/config');
    resetConfigForTest();

    expect(resolveTtsConfig('userT').model).toBe('gpt-4o-mini-tts');
  });
});

describe('resolveTtsConfig with tencent-cloud provider', () => {
  it('passes through digit voice ids and keeps secret config', async () => {
    process.env.CROSSFADIO_TTS_PROVIDER = 'tencent-cloud';
    process.env.CROSSFADIO_TTS_SECRET_ID = 'AKID-test';
    process.env.CROSSFADIO_TTS_SECRET_KEY = 'secret-key';
    const { resetConfigForTest } = await import('../../src/server/config');
    resetConfigForTest();
    setPref('userT', 'tts.voice', '1004');

    const config = resolveTtsConfig('userT');

    expect(config.provider).toBe('tencent-cloud');
    expect(config.voice).toBe('1004');
    expect(config.secretId).toBe('AKID-test');
  });
});

describe('resolveEffectiveVoiceForProvider', () => {
  it('maps legacy male voices to the male VoiceType id for tencent-cloud (matches synthesis)', () => {
    // 与 resolveTencentVoiceType 同一套 legacy 映射：Ethan/Ryan 等男声 -> 1004，避免 GET 展示与合成不一致。
    expect(resolveEffectiveVoiceForProvider('Ethan', 'tencent-cloud', 'Cherry')).toBe('1004');
    expect(resolveEffectiveVoiceForProvider('Ryan', 'tencent-cloud', 'Cherry')).toBe('1004');
  });

  it('normalizes invalid voices to the default Tencent voice id for tencent-cloud', () => {
    expect(resolveEffectiveVoiceForProvider('Cherry', 'tencent-cloud', 'Cherry')).toBe(TENCENT_DEFAULT_VOICE_ID);
    expect(resolveEffectiveVoiceForProvider('1001', 'tencent-cloud', 'Cherry')).toBe('1001');
    expect(resolveEffectiveVoiceForProvider('1006', 'tencent-cloud', 'Cherry')).toBe(TENCENT_DEFAULT_VOICE_ID);
  });

  it('strips Tencent digit ids for aliyun-qwen and openai-compatible', () => {
    expect(resolveEffectiveVoiceForProvider('1001', 'aliyun-qwen', 'Cherry')).toBe('Cherry');
    expect(resolveEffectiveVoiceForProvider('1001', 'openai-compatible', 'Cherry')).toBe('Cherry');
    expect(resolveEffectiveVoiceForProvider('Ethan', 'aliyun-qwen', 'Cherry')).toBe('Ethan');
  });

  it('falls back to a valid Qwen voice when a legacy OpenAI voice lingers for aliyun-qwen', () => {
    expect(resolveEffectiveVoiceForProvider('alloy', 'aliyun-qwen', 'Cherry')).toBe('Cherry');
    expect(resolveEffectiveVoiceForProvider('nova', 'aliyun-qwen', 'Ethan')).toBe('Ethan');
  });

  it('keeps the fallback itself valid when it is a Tencent digit id', () => {
    // fallback 自身是非法数字音色时，继续回退到默认 Qwen 音色，而不是把数字发给 Qwen。
    expect(resolveEffectiveVoiceForProvider('1001', 'aliyun-qwen', '1001')).toBe(DEFAULT_TTS_VOICE);
    expect(resolveEffectiveVoiceForProvider('1004', 'aliyun-qwen', '1001')).toBe(DEFAULT_TTS_VOICE);
    expect(resolveEffectiveVoiceForProvider('1001', 'openai-compatible', '1001')).toBe(DEFAULT_TTS_VOICE);
  });
});
