import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchWeather', () => {
  it('returns null on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { fetchWeather } = await import('../../src/server/weather');
    const result = await fetchWeather();
    expect(result).toBeNull();
  });

  it('returns null on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    const { fetchWeather } = await import('../../src/server/weather');
    const result = await fetchWeather();
    expect(result).toBeNull();
  });

  it('returns weather object on success', async () => {
    const mockWeather = { current_condition: [{ temp_C: '20', weatherDesc: [{ value: 'Sunny' }] }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockWeather
    }));
    const { fetchWeather } = await import('../../src/server/weather');
    const result = await fetchWeather();
    expect(result).toMatchObject({ tempC: 20, desc: 'Sunny', location: 'auto' });
  });
});
