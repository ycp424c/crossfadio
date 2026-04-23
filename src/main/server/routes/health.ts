import type { RequestHandler } from 'express';
import { healthResponseSchema } from '@shared/schema';
import { getDb } from '@main/store/db';

const bootTime = Date.now();

export const getHealthHandler: RequestHandler = (_req, res) => {
  let dbReady = true;

  try {
    getDb().prepare('SELECT 1').get();
  } catch {
    dbReady = false;
  }

  const payload = healthResponseSchema.parse({
    ok: true,
    service: 'crossfadio-local-brain',
    uptimeSec: Math.floor((Date.now() - bootTime) / 1000),
    dbReady,
    timestamp: new Date().toISOString()
  });

  res.json(payload);
};
