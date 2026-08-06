import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REQUIRED_ENV = {
  CROSSFADIO_JWT_SECRET: 'jwt-test',
  CROSSFADIO_LLM_BASE_URL: 'https://llm.example/v1',
  CROSSFADIO_LLM_API_KEY: 'llm-key',
  CROSSFADIO_LLM_MODEL: 'llm-model',
  CROSSFADIO_TTS_BASE_URL: 'https://tts.example/v1',
  CROSSFADIO_TTS_API_KEY: 'tts-key'
} as const;

const originalEnv = new Map<string, string | undefined>([
  ...Object.keys(REQUIRED_ENV),
  'CROSSFADIO_LYRICS_SELECTION_MODE',
  'CROSSFADIO_TTS_PROVIDER',
  'CROSSFADIO_TTS_MODEL',
  'CROSSFADIO_TTS_VOICE_DEFAULT'
].map((name) => [name, process.env[name]]));

beforeEach(async () => {
  const { resetConfigForTest } = await import('../../src/server/config.js');
  resetConfigForTest();
  Object.assign(process.env, REQUIRED_ENV);
  delete process.env.CROSSFADIO_LYRICS_SELECTION_MODE;
  delete process.env.CROSSFADIO_TTS_PROVIDER;
  delete process.env.CROSSFADIO_TTS_MODEL;
  delete process.env.CROSSFADIO_TTS_VOICE_DEFAULT;
});

afterEach(async () => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const { resetConfigForTest } = await import('../../src/server/config.js');
  resetConfigForTest();
});

describe('lyrics selection mode config', () => {
  it.each(['off', 'shadow', 'enforce_fit', 'enforce_all'] as const)(
    'accepts %s',
    async (mode) => {
      process.env.CROSSFADIO_LYRICS_SELECTION_MODE = mode;
      const { loadConfig } = await import('../../src/server/config.js');

      expect(loadConfig().lyricsSelectionMode).toBe(mode);
    }
  );

  it('defaults to off when the env var is absent', async () => {
    const { loadConfig } = await import('../../src/server/config.js');

    expect(loadConfig().lyricsSelectionMode).toBe('off');
  });

  it('falls back to off for an invalid value without throwing', async () => {
    process.env.CROSSFADIO_LYRICS_SELECTION_MODE = 'strict';
    const { loadConfig } = await import('../../src/server/config.js');

    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().lyricsSelectionMode).toBe('off');
  });
});

describe('TTS provider config', () => {
  it('requires an explicit model and voice default for openai-compatible', async () => {
    process.env.CROSSFADIO_TTS_PROVIDER = 'openai-compatible';
    const { loadConfig } = await import('../../src/server/config.js');

    expect(() => loadConfig()).toThrow(
      'Missing required environment variable: CROSSFADIO_TTS_MODEL / CROSSFADIO_TTS_VOICE_DEFAULT (provider=openai-compatible)'
    );
  });

  it('accepts an explicit model and voice default for openai-compatible', async () => {
    process.env.CROSSFADIO_TTS_PROVIDER = 'openai-compatible';
    process.env.CROSSFADIO_TTS_MODEL = 'gpt-4o-mini-tts';
    process.env.CROSSFADIO_TTS_VOICE_DEFAULT = 'alloy';
    const { loadConfig } = await import('../../src/server/config.js');

    expect(loadConfig().tts).toMatchObject({
      provider: 'openai-compatible',
      model: 'gpt-4o-mini-tts',
      voiceDefault: 'alloy'
    });
  });
});
