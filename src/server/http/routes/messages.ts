import type { RequestHandler } from 'express';
import { z } from 'zod';
import { getRecentMessages } from '../../store/messages.js';

const querySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50)
});

export function createGetRecentMessagesHandler(): RequestHandler {
  return (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    const limit = parsed.success ? parsed.data.limit : 50;
    const messages = getRecentMessages(limit);
    res.json({ ok: true, messages });
  };
}
