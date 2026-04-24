import type { RequestHandler } from 'express';
import type { NcmProcessManager } from '../../ncm/spawn.js';

export function createNcmStatusHandler(ncm: NcmProcessManager): RequestHandler {
  return (_req, res) => {
    res.json({ ok: true, ...ncm.getStatus() });
  };
}
