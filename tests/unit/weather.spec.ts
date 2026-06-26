import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = process.cwd();

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

  it('logs the stored location path used by weather fetches and location updates', () => {
    const weatherSource = fs.readFileSync(path.join(root, 'src/server/weather.ts'), 'utf-8');
    const locationSource = fs.readFileSync(path.join(root, 'src/server/http/routes/location.ts'), 'utf-8');

    expect(weatherSource).toContain('Weather fetch using location');
    expect(weatherSource).toContain('Weather fetch succeeded');
    expect(weatherSource).toContain('hasStoredLocation');
    expect(locationSource).toContain('Browser location stored');
    expect(locationSource).toContain('lat: parsed.data.lat.toFixed(4)');
    expect(locationSource).toContain('lon: parsed.data.lon.toFixed(4)');
  });
});
