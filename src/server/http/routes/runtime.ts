import type { RequestHandler } from 'express';

export function createRuntimeHandler(): RequestHandler {
  return (_req, res) => {
    res.json({ ok: true, version: '2.0.0' });
  };
}
