import type { Request, Response, NextFunction } from 'express';
import { isAllowed } from '../../allowlist.js';
import { getLogger } from '../../logger.js';
import { getUserById } from '../../store/users.js';
import {
  markPersonalDjContextTokenUsed,
  resolvePersonalDjContextToken
} from '../../store/personal-dj-context-tokens.js';

export type PersonalDjContextBridgeRequest = Request & {
  userId: string;
  bridgeTokenId: string;
};

export function personalDjContextBridgeAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ ok: false, error: 'unauthorized', message: '缺少 Bridge Token' });
    return;
  }

  const record = resolvePersonalDjContextToken(token);
  if (!record) {
    res.status(401).json({ ok: false, error: 'unauthorized', message: 'Bridge Token 无效或已撤销' });
    return;
  }

  if (!isAllowed(record.userId)) {
    getLogger().warn({ userId: record.userId, bridgeTokenId: record.id }, 'Bridge Token user not in allowlist');
    res.status(403).json({ ok: false, error: 'forbidden', message: '没有访问权限' });
    return;
  }

  if (!getUserById(record.userId)) {
    getLogger().warn({ userId: record.userId, bridgeTokenId: record.id }, 'Bridge Token user record missing');
    res.status(401).json({ ok: false, error: 'unauthorized', message: '用户记录不存在，请重新登录' });
    return;
  }

  markPersonalDjContextTokenUsed(record.id);
  (req as PersonalDjContextBridgeRequest).userId = record.userId;
  (req as PersonalDjContextBridgeRequest).bridgeTokenId = record.id;
  next();
}
