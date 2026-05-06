import type { Request, Response } from 'express';
import { z } from 'zod';
import type { NcmClient } from '../../ncm/client.js';
import { setLocation } from '../../store/location.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

const bodySchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180)
});

export function createSetLocationHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }
    setLocation(userId, parsed.data.lat, parsed.data.lon);
    res.json({ ok: true });
  };
}
