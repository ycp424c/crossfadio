import type { RequestHandler } from 'express';

export type IpRateLimitOptions = {
  windowMs: number;
  max: number;
  /** Injectable clock for deterministic tests (defaults to Date.now). */
  now?: () => number;
};

export type IpRateLimiterMiddleware = RequestHandler & {
  _resetForTest(): void;
  _bucketCountForTest(): number;
};

type Bucket = {
  windowStart: number;
  count: number;
};

/**
 * Fixed-window rate limiter keyed ONLY on Express req.ip. Forwarded headers are
 * never parsed directly — trust proxy is an explicit deployment decision.
 *
 * Returns a JSON 429 `rate_limited` response with Retry-After on overflow,
 * prunes expired buckets on every access, and exposes test hooks.
 */
export function createIpFixedWindowLimiter(options: IpRateLimitOptions): IpRateLimiterMiddleware {
  const buckets = new Map<string, Bucket>();
  const nowFn = options.now ?? Date.now;

  const middleware = ((req, res, next) => {
    const now = nowFn();
    // Express always populates req.ip for real sockets; fall back to a shared
    // bucket key for synthetic requests so the limiter never crashes.
    const ip = req.ip ?? 'unknown';

    // Prune expired buckets so stale clients never accumulate.
    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStart >= options.windowMs) buckets.delete(key);
    }

    const existing = buckets.get(ip);
    if (!existing || now - existing.windowStart >= options.windowMs) {
      buckets.set(ip, { windowStart: now, count: 1 });
      next();
      return;
    }

    if (existing.count >= options.max) {
      const retryInSeconds = Math.max(1, Math.ceil((existing.windowStart + options.windowMs - now) / 1000));
      res.set('Retry-After', String(retryInSeconds));
      res.status(429).json({
        ok: false,
        error: 'rate_limited',
        message: '请求过于频繁，请稍后再试'
      });
      return;
    }

    existing.count += 1;
    next();
  }) as IpRateLimiterMiddleware;

  middleware._resetForTest = () => buckets.clear();
  middleware._bucketCountForTest = () => buckets.size;
  return middleware;
}

// ── Public QR endpoint limiters (independent instances) ──────────────────────

/** GET/POST /api/ncm/login/qr — 5 creations per IP per 10 minutes. */
export const qrCreateLimiter = createIpFixedWindowLimiter({
  windowMs: 10 * 60_000,
  max: 5
});

/** GET /api/ncm/login/status — 40 polls per IP per 60 seconds. */
export const qrStatusLimiter = createIpFixedWindowLimiter({
  windowMs: 60_000,
  max: 40
});
