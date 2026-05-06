import type { Request, Response } from 'express';
import type { NcmClient } from '../../ncm/client.js';
import { getRecentMessages } from '../../store/messages.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

export function createGetRecentMessagesHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const messages = getRecentMessages(userId, 20);
    res.json({ ok: true, messages });
  };
}
