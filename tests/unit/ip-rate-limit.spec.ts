import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import {
  createIpFixedWindowLimiter,
  qrCreateLimiter,
  qrStatusLimiter
} from '../../src/server/http/middleware/ip-rate-limit';
import {
  createNcmQrHandler,
  createNcmQrStatusHandler
} from '../../src/server/http/routes/ncm-login';

function makeReqRes(ip: string, forwardedFor?: string) {
  const req = {
    ip,
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}
  } as Request;
  const res = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined as unknown,
    set: vi.fn((name: string, value: string) => {
      res.headers[name] = value;
      return res;
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    })
  } as unknown as Response;
  const next = vi.fn() as NextFunction;
  return { req, res, next };
}

describe('fixed-window IP rate limiter', () => {
  it('allows requests up to the limit and rejects the next with 429 and Retry-After', () => {
    let now = 1_000_000;
    const limiter = createIpFixedWindowLimiter({ windowMs: 600_000, max: 5, now: () => now });

    for (let index = 0; index < 5; index += 1) {
      const { req, res, next } = makeReqRes('1.2.3.4');
      limiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }

    const { req, res, next } = makeReqRes('1.2.3.4');
    limiter(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('600');
    expect(res.body).toMatchObject({ ok: false, error: 'rate_limited' });
  });

  it('isolates rate-limit buckets by IP', () => {
    let now = 1_000_000;
    const limiter = createIpFixedWindowLimiter({ windowMs: 600_000, max: 1, now: () => now });

    const first = makeReqRes('1.1.1.1');
    limiter(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledTimes(1);

    const second = makeReqRes('2.2.2.2');
    limiter(second.req, second.res, second.next);
    expect(second.next).toHaveBeenCalledTimes(1);

    const third = makeReqRes('1.1.1.1');
    limiter(third.req, third.res, third.next);
    expect(third.next).not.toHaveBeenCalled();
    expect(third.res.statusCode).toBe(429);
  });

  it('keys only on Express req.ip and never parses forwarded headers directly', () => {
    let now = 1_000_000;
    const limiter = createIpFixedWindowLimiter({ windowMs: 600_000, max: 1, now: () => now });

    // Both requests carry the same x-forwarded-for value but different req.ip:
    // the limiter must treat them as distinct clients and never trust the header.
    const first = makeReqRes('10.0.0.1', '203.0.113.9');
    limiter(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledTimes(1);

    const second = makeReqRes('10.0.0.2', '203.0.113.9');
    limiter(second.req, second.res, second.next);
    expect(second.next).toHaveBeenCalledTimes(1);
  });

  it('resets a bucket after the window elapses', () => {
    let now = 1_000_000;
    const limiter = createIpFixedWindowLimiter({ windowMs: 600_000, max: 1, now: () => now });

    const first = makeReqRes('5.6.7.8');
    limiter(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledTimes(1);

    const blocked = makeReqRes('5.6.7.8');
    limiter(blocked.req, blocked.res, blocked.next);
    expect(blocked.next).not.toHaveBeenCalled();

    now += 600_000;
    const afterWindow = makeReqRes('5.6.7.8');
    limiter(afterWindow.req, afterWindow.res, afterWindow.next);
    expect(afterWindow.next).toHaveBeenCalledTimes(1);
  });

  it('prunes expired buckets on access so stale clients do not accumulate', () => {
    let now = 1_000_000;
    const limiter = createIpFixedWindowLimiter({ windowMs: 600_000, max: 5, now: () => now });

    const first = makeReqRes('1.1.1.1');
    limiter(first.req, first.res, first.next);
    expect(limiter._bucketCountForTest()).toBe(1);

    now += 600_000;
    const second = makeReqRes('2.2.2.2');
    limiter(second.req, second.res, second.next);

    // The expired 1.1.1.1 bucket was pruned; only the new one remains.
    expect(limiter._bucketCountForTest()).toBe(1);
  });
});

describe('public QR endpoint rate limits', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    qrCreateLimiter._resetForTest();
    qrStatusLimiter._resetForTest();
    const app = express();
    const auth = {
      createQr: vi.fn().mockResolvedValue({ key: 'key-1', qrimg: 'img', qrurl: 'url' }),
      checkQr: vi.fn().mockResolvedValue({
        code: 801,
        hint: 'waiting',
        message: '等待扫码',
        hasCookie: false
      })
    };
    app.get('/qr', qrCreateLimiter, createNcmQrHandler(auth as never));
    app.post('/qr', qrCreateLimiter, createNcmQrHandler(auth as never));
    app.get('/status', qrStatusLimiter, createNcmQrStatusHandler(auth as never));
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    qrCreateLimiter._resetForTest();
    qrStatusLimiter._resetForTest();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function get(path: string): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${path}`, (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += String(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) as unknown : null });
        });
      }).on('error', reject);
    });
  }

  function post(path: string): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${path}`, { method: 'POST' }, (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += String(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) as unknown : null });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('allows 5 QR creations per IP per 10 minutes and rejects the sixth with 429', async () => {
    for (let index = 0; index < 5; index += 1) {
      const result = await get('/qr');
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ok: true, key: 'key-1' });
    }

    const blocked = await get('/qr');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ ok: false, error: 'rate_limited' });

    // GET and POST share the same create limiter: POST is also blocked.
    const blockedPost = await post('/qr');
    expect(blockedPost.status).toBe(429);
  });

  it('keeps QR status polling independent from QR creation', async () => {
    // The status limiter has its own budget: 40 polls per 60 seconds.
    for (let index = 0; index < 40; index += 1) {
      const result = await get('/status?key=k');
      expect(result.status).toBe(200);
    }

    const blocked = await get('/status?key=k');
    expect(blocked.status).toBe(429);

    // Creation budget is untouched by the 40 status polls.
    const created = await get('/qr');
    expect(created.status).toBe(200);
  });

  it('wires the independent limiter instances onto the public QR routes', () => {
    const source = fs.readFileSync('src/server/http/index.ts', 'utf8');
    expect(source).toContain("routes.get('/api/ncm/login/qr', qrCreateLimiter");
    expect(source).toContain("routes.post('/api/ncm/login/qr', qrCreateLimiter");
    expect(source).toContain("routes.get('/api/ncm/login/status', qrStatusLimiter");
    expect(source).not.toContain("routes.get('/api/ncm/login/status', qrCreateLimiter");
  });
});
