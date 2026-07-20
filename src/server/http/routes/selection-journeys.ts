import type { Request, Response } from 'express';
import { z } from 'zod';
import { listRecentSelectionJourneys } from '../../store/selection-journeys.js';

type AuthedRequest = Request & { userId: string };

const querySchema = z.object({
  limit: z.union([
    z.number().int().positive(),
    z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive())
  ]).optional()
}).strict();

export function createListSelectionJourneysHandler(deps: {
  now?: () => Date;
} = {}) {
  return (req: Request, res: Response): void => {
    const parsed = querySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid query' });
      return;
    }
    const { userId } = req as AuthedRequest;
    const journeys = listRecentSelectionJourneys(userId, {
      now: (deps.now?.() ?? new Date()).toISOString(),
      limit: Math.min(parsed.data.limit ?? 20, 100)
    }).map((record) => record.snapshot);
    res.json({ ok: true, journeys });
  };
}
