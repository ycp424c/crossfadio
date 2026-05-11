import { getLogger } from './logger.js';
import { getLocation } from './store/location.js';

export type WeatherResult = {
  location: string;
  tempC: number;
  desc: string;
};

const TIMEOUT_MS = 5000;

/**
 * Fetches current weather from wttr.in.
 * Uses browser-reported coordinates if available (set via POST /api/location),
 * otherwise falls back to wttr.in auto-detection based on server IP.
 * Returns null on any failure — callers must handle the null case gracefully.
 */
export async function fetchWeather(userId?: string): Promise<WeatherResult | null> {
  const loc = userId ? getLocation(userId) : null;
  const locationStr = loc ? `${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}` : 'auto';
  const url = `https://wttr.in/${encodeURIComponent(locationStr)}?format=j1`;
  const logger = getLogger();

  logger.info(
    { userId, location: locationStr, hasStoredLocation: Boolean(loc) },
    'Weather fetch using location'
  );

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

    let resp: Response;
    try {
      resp = await fetch(url, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      logger.warn(
        { userId, location: locationStr, status: resp.status, hasStoredLocation: Boolean(loc) },
        'Weather fetch returned non-ok response'
      );
      return null;
    }

    const data = (await resp.json()) as WttrResponse;
    const current = data?.current_condition?.[0];
    if (!current) return null;

    const tempC = parseFloat(current.temp_C ?? '0');
    const desc = current.weatherDesc?.[0]?.value ?? '';

    logger.info(
      { userId, location: locationStr, hasStoredLocation: Boolean(loc), tempC, desc },
      'Weather fetch succeeded'
    );
    return { location: locationStr, tempC, desc };
  } catch (err) {
    logger.debug({ err, userId, location: locationStr, hasStoredLocation: Boolean(loc) }, 'Weather fetch failed, degrading to null');
    return null;
  }
}

type WttrResponse = {
  current_condition?: Array<{
    temp_C?: string;
    weatherDesc?: Array<{ value?: string }>;
  }>;
};
