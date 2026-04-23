import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express from 'express';
import cors from 'cors';
import { getHealthHandler } from './routes/health';
import { setupWsServer } from './ws';
import type { SessionToken } from '@shared/types';
import type { NcmProcessManager } from '@main/ncm/spawn';
import { createNcmStatusHandler } from './routes/ncm';
import type { NcmAuthService } from '@main/ncm/auth';
import {
  createNcmLogoutHandler,
  createNcmQrHandler,
  createNcmQrStatusHandler,
  createNcmSessionHandler
} from './routes/ncm-login';

export type LocalServer = {
  port: number;
  baseUrl: string;
  wsUrl: string;
  sessionToken: SessionToken;
  close: () => Promise<void>;
};

type StartLocalServerOptions = {
  ncm: NcmProcessManager;
  ncmAuth: NcmAuthService;
};

export async function startLocalServer(options: StartLocalServerOptions): Promise<LocalServer> {
  const app = express();
  app.use(cors({ origin: 'http://localhost' }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', getHealthHandler);
  app.get('/api/ncm/status', createNcmStatusHandler(options.ncm));
  app.get('/api/ncm/login/qr', createNcmQrHandler(options.ncmAuth));
  app.get('/api/ncm/login/status', createNcmQrStatusHandler(options.ncmAuth));
  app.get('/api/ncm/login/session', createNcmSessionHandler(options.ncmAuth));
  app.post('/api/ncm/login/logout', createNcmLogoutHandler(options.ncmAuth));

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    res.status(500).json({ ok: false, error: message });
  });

  const server = createServer(app);
  const sessionToken = randomBytes(24).toString('hex');
  setupWsServer(server, sessionToken);

  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  return {
    port,
    baseUrl,
    wsUrl,
    sessionToken,
    close: async () => closeServer(server)
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to acquire local server port.'));
        return;
      }

      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
