import type { RequestHandler } from 'express';
import { setLocation } from '../../store/location.js';

export function createSetLocationHandler(): RequestHandler {
  return (req, res) => {
    const { lat, lon } = req.body as { lat?: unknown; lon?: unknown };
    if (
      typeof lat !== 'number' ||
      typeof lon !== 'number' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 || lat > 90 ||
      lon < -180 || lon > 180
    ) {
      res.status(400).json({ ok: false, error: 'invalid lat/lon' });
      return;
    }
    setLocation(lat, lon);
    res.json({ ok: true });
  };
}
