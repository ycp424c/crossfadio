import type { Request, Response, NextFunction } from 'express';
import type { NcmClient as NcmClientType } from '../../ncm/client.js';
import { NcmClient } from '../../ncm/client.js';
import { getUserById } from '../../store/users.js';
import { deriveKey, decrypt } from '../../crypto.js';
import { getConfig } from '../../config.js';
import { isAllowed } from '../../allowlist.js';
import { getLogger } from '../../logger.js';
import { scheduleTasteAnalysisIfDue } from '../routes/taste-analysis.js';

export async function userScopeMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = (req as Request & { userId?: string }).userId;
  if (!userId) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  // Re-check allowlist membership — a user removed from the allowlist must lose
  // access immediately, not only when their JWT expires.
  if (!isAllowed(userId)) {
    getLogger().warn({ userId }, 'User not in allowlist');
    res.status(403).json({ ok: false, error: 'forbidden', message: '没有访问权限' });
    return;
  }

  const user = getUserById(userId);
  if (!user) {
    getLogger().warn({ userId }, 'Authed user not found in DB — cookie may have been cleared');
    res.status(401).json({ ok: false, error: 'unauthorized', message: '用户记录不存在，请重新登录' });
    return;
  }

  try {
    const config = getConfig();
    const key = deriveKey(config.jwtSecret);
    const cookie = decrypt(user.ncm_cookie, key);
    const ncmBaseUrl = req.app.locals.ncmBaseUrl as string;
    const ncmClient = new NcmClient(ncmBaseUrl, { getCookie: () => cookie });
    (req as Request & { userId: string; ncmClient: NcmClientType }).ncmClient = ncmClient;
    // Fire-and-forget background taste analysis if due (won't block request)
    scheduleTasteAnalysisIfDue(userId, ncmClient);
    next();
  } catch (err) {
    getLogger().error({ err, userId }, 'Failed to decrypt user cookie');
    res.status(401).json({ ok: false, error: 'unauthorized', message: '用户凭证解密失败，请重新登录' });
  }
}
