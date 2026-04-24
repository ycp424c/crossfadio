import type { RequestHandler } from 'express';
import { z } from 'zod';
import { setQueueState } from '../../store/queue.js';

const queueStateBodySchema = z.object({
  queue: z.array(z.string().min(1)),
  currentIndex: z.number().int().nonnegative().default(0)
});

export function createSetQueueStateHandler(): RequestHandler {
  return (req, res) => {
    const parsed = queueStateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }

    setQueueState(
      parsed.data.queue.map((ncmId) => ({ ncmId })),
      parsed.data.currentIndex
    );
    res.json({ ok: true });
  };
}
