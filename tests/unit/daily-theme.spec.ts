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

  it('rejects generated themes that pin an all-day theme to night', async () => {
    vi.setSystemTime(new Date('2026-05-15T06:30:00.000Z'));
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              theme: '春末微风，周五夜晚的惬意时光',
              keywords: ['周五夜晚', 'city pop']
            })
          }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    ));

    const theme = await getOrGenerateDailyTheme();

    expect(theme?.theme).not.toContain('夜晚');
    expect(theme?.theme).not.toContain('周五晚');
    expect(theme?.keywords).not.toContain('周五夜晚');
  });
});
