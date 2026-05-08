import { jwtVerify } from 'jose';
import type { Request, Response, NextFunction } from 'express';
import { getConfig } from '../../config.js';
import { getLogger } from '../../logger.js';

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  // EventSource 不支持自定义 header，query param 作为备选
  let token = typeof req.query.token === 'string' ? (req.query.token as string) : null;

  if (!token) {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      token = header.slice(7);
    }
  }

  if (!token) {
    res.status(401).json({ ok: false, error: 'unauthorized', message: '缺少认证令牌' });
    return;
  }
  try {
    const config = getConfig();
    const secret = new TextEncoder().encode(config.jwtSecret);
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new Error('invalid sub');
    }
    (req as Request & { userId: string }).userId = payload.sub;
    next();
  } catch (err) {
    getLogger().debug({ err }, 'JWT verification failed');
    res.status(401).json({ ok: false, error: 'unauthorized', message: '令牌无效或已过期' });
  }
}
