import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { handleAsync } from '../../src/server/http/async-handler.js';
import { createGlobalErrorHandler } from '../../src/server/http/index.js';

describe('global HTTP error handler', () => {
  it('returns a stable public error and logs only a safe projection', () => {
    const logger = { error: vi.fn() };
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };
    const privateMessage = 'SQLITE_PRIVATE /root/private.db user query';

    createGlobalErrorHandler(logger)(
      Object.assign(new Error(privateMessage), { code: 'PRIVATE CODE', status: 503 }),
      {} as never,
      response as never,
      vi.fn()
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      ok: false,
      error: 'internal_error',
      message: '请求暂时失败，请稍后重试',
      correlationId: expect.any(String)
    });
    expect(logger.error).toHaveBeenCalledWith({
      correlationId: expect.any(String),
      code: 'provider_server_error',
      status: 503
    }, 'Unhandled HTTP request failure');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privateMessage);
    expect(JSON.stringify(response.json.mock.calls)).not.toContain(privateMessage);
  });

  it('routes a rejected async request through the real Express error pipeline', async () => {
    const logger = { error: vi.fn() };
    const app = express();
    app.get('/async-failure', handleAsync(async () => {
      await Promise.resolve();
      throw Object.assign(new Error('private async failure'), { status: 503 });
    }));
    app.use(createGlobalErrorHandler(logger));

    await withHttpApp(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/async-failure`);

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: 'internal_error',
        message: '请求暂时失败，请稍后重试',
        correlationId: expect.any(String)
      });
    });
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('delegates an error after SSE headers have already been committed', async () => {
    const logger = { error: vi.fn() };
    const downstream = vi.fn();
    const app = express();
    const streamError = new Error('stream failed after commit');
    app.get('/stream-failure', handleAsync(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: connected\ndata: {}\n\n');
      await Promise.resolve();
      throw streamError;
    }));
    app.use(createGlobalErrorHandler(logger));
    app.use((
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      downstream(error);
      res.end();
    });

    await withHttpApp(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/stream-failure`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('event: connected\ndata: {}\n\n');
    });
    expect(downstream).toHaveBeenCalledWith(streamError);
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

async function withHttpApp(
  app: express.Express,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer(app);
  await listen(server);
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await close(server);
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
