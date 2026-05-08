import type { Request, Response, NextFunction } from 'express';
import { getConfig } from '../../config.js';

export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  const userId = (req as Request & { userId?: string }).userId;
  const config = getConfig();

  if (!config.adminNcmId) {
    res.status(403).json({
      ok: false,
      error: 'forbidden',
      message: '管理员功能未启用，请配置 CROSSFADIO_ADMIN_NCM_ID 环境变量'
    });
    return;
  }

  if (userId !== config.adminNcmId) {
    res.status(403).json({
      ok: false,
      error: 'forbidden',
      message: '仅限管理员操作'
    });
    return;
  }

  next();
}
