import type { RequestHandler } from 'express';
import type { SessionToken } from '../../../shared/types.js';

type RuntimeHandlerOptions = {
  sessionToken: SessionToken;
};

export function createRuntimeHandler(options: RuntimeHandlerOptions): RequestHandler {
  return (_req, res) => {
    res.json({ ok: true, sessionToken: options.sessionToken });
  };
}
