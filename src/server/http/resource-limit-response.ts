import type { Response } from 'express';
import { ResourceLimitError, type ResourceLimitErrorCode } from '../resource-governor.js';

const MESSAGES: Record<ResourceLimitErrorCode, string> = {
  daily_quota_exceeded: '今日 AI 额度已用完，请明天再试',
  user_concurrency_exceeded: '同时进行的任务过多，请稍后再试',
  standard_capacity_exceeded: '当前标准用户并发已满，请稍后再试',
  global_capacity_exceeded: '服务繁忙，请稍后再试',
  event_connection_limit_exceeded: '实时连接数已达上限，请关闭其他播放器页面后重试'
};

/**
 * Uniform 429 resource_limited response with Retry-After.
 * Only the stable reason code, operation and a safe Chinese message are
 * exposed — never global counters or another user's usage.
 */
export function sendResourceLimitResponse(res: Response, error: ResourceLimitError): void {
  res.set('Retry-After', String(error.retryAfterSeconds));
  res.status(429).json({
    ok: false,
    error: 'resource_limited',
    reason: error.code,
    operation: error.operation,
    message: MESSAGES[error.code]
  });
}
