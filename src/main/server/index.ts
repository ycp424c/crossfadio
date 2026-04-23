import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import express from 'express';
import cors from 'cors';
import { getHealthHandler } from './routes/health';
import { setupWsServer } from './ws';
import type { SessionToken } from '@shared/types';
import type { NcmProcessManager } from '@main/ncm/spawn';
import { createNcmStatusHandler } from './routes/ncm';

export type LocalServer = {
  port: number;
  baseUrl: string;
  wsUrl: string;
  sessionToken: SessionToken;
  close: () => Promise<void>;
};

type StartLocalServerOptions = {
  ncm: NcmProcessManager;
};

export async function startLocalServer(options: StartLocalServerOptions): Promise<LocalServer> {
  const app = express();
  app.use(cors({ origin: 'http://localhost' }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', getHealthHandler);
  app.get('/api/ncm/status', createNcmStatusHandler(options.ncm));

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
