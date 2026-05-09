import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTest } from '../../src/server/config';
import {
  _resetForTest,
  getDailyTheme,
  getOrGenerateDailyTheme,
  getOrGenerateDailyThemeWithin
} from '../../src/server/daily-theme';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.useFakeTimers();
  process.env.CROSSFADIO_JWT_SECRET = 'unit-test-secret-key-at-least-32-chars';
  process.env.CROSSFADIO_LLM_BASE_URL = 'https://llm.example/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'sk-test';
  process.env.CROSSFADIO_LLM_MODEL = 'test-model';
  process.env.CROSSFADIO_TTS_BASE_URL = 'https://tts.example/v1';
  process.env.CROSSFADIO_TTS_API_KEY = 'sk-test-tts';
  process.env.CROSSFADIO_DAILY_THEME_TIMEOUT_MS = '25';
  resetConfigForTest();
  _resetForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  resetConfigForTest();
  _resetForTest();
});

describe('daily theme generation', () => {
  it('lets callers stop waiting for a slow theme without cancelling the shared generation', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new DOMException('aborted', 'AbortError'));
        });
      })
    ));

    const sharedGeneration = getOrGenerateDailyTheme();
    const shortWait = getOrGenerateDailyThemeWithin(10);

    await vi.advanceTimersByTimeAsync(10);
    await expect(shortWait).resolves.toBeNull();
    expect(getDailyTheme()).toBeNull();

    await vi.advanceTimersByTimeAsync(15);
    await expect(sharedGeneration).resolves.toMatchObject({
      theme: expect.stringContaining('特辑')
    });
    expect(getDailyTheme()).not.toBeNull();
  });
});
