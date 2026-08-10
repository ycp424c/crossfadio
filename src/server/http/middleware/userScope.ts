import type { Request, Response, NextFunction } from 'express';
import type { NcmClient as NcmClientType } from '../../ncm/client.js';
import { NcmClient } from '../../ncm/client.js';
import { getUserById } from '../../store/users.js';
import { getUserAccessStatus } from '../../store/user-access-controls.js';
import { deriveKey, decrypt } from '../../crypto.js';
import { getConfig } from '../../config.js';
import { getLogger } from '../../logger.js';
import { scheduleTasteAnalysisIfDue } from '../routes/taste-analysis.js';
import { scheduleMusicEntityIndexIfDue } from '../../music-agent/entity-indexer.js';
import { resolveUserTier } from '../../resource-policy.js';

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

  // Persistent safety suspension blocks every JWT request, independent of
  // priority membership. Takes effect on the next request after suspension.
  if (getUserAccessStatus(userId) === 'suspended') {
    getLogger().warn({ userId }, 'Suspended user blocked at JWT boundary');
    res.status(403).json({ ok: false, error: 'forbidden', message: '账号已被暂停使用，请联系管理员' });
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
    // Fire-and-forget background taste analysis and entity indexing only for
    // priority users; standard users never schedule these from ordinary requests.
    if (resolveUserTier(userId) === 'priority') {
      scheduleTasteAnalysisIfDue(userId, ncmClient);
      scheduleMusicEntityIndexIfDue(userId, ncmClient);
    }
    next();
  } catch (err) {
    getLogger().error({ err, userId }, 'Failed to decrypt user cookie');
    res.status(401).json({ ok: false, error: 'unauthorized', message: '用户凭证解密失败，请重新登录' });
  }
}
