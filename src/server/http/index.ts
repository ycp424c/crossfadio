import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { getHealthHandler } from './routes/health.js';
import { setupWsServer } from './ws.js';
import type { SessionToken } from '../../shared/types.js';
import type { NcmProcessManager } from '../ncm/spawn.js';
import { createNcmStatusHandler } from './routes/ncm.js';
import type { NcmAuthService } from '../ncm/auth.js';
import type { NcmClient } from '../ncm/client.js';
import {
  createNcmLogoutHandler,
  createNcmQrHandler,
  createNcmQrStatusHandler,
  createNcmSessionHandler
} from './routes/ncm-login.js';
import { createNextHandler, createNowHandler } from './routes/now-next.js';
import { createStartPlayHandler, createEndPlayHandler } from './routes/plays.js';
import { createGetSettingsHandler, createSaveSettingsHandler } from './routes/settings.js';
import {
  createGetTodayPlanHandler,
  createRegeneratePlanHandler,
  createReplanSegmentHandler,
  createGapFillHandler
} from './routes/plan.js';
import { createSegueTriggerHandler, createSegueAudioHandler } from './routes/segue.js';
import { createChatMessageHandler } from './routes/chat.js';
import { createRuntimeHandler } from './routes/runtime.js';
import { createGetLikedQueueHandler, createSetQueueStateHandler } from './routes/queue.js';
import type { SecretStore } from '../security.js';

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
  ncmClient: NcmClient;
  secrets: SecretStore;
  host: string;
  port: number;
  staticDir?: string | null;
};

export async function startLocalServer(options: StartLocalServerOptions): Promise<LocalServer> {
  const app = express();
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || origin === 'null') {
          callback(null, true);
          return;
        }

        if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`CORS blocked origin: ${origin}`));
      }
    })
  );
  app.use(express.json({ limit: '1mb' }));

  const sessionToken = randomBytes(24).toString('hex');

  app.get('/api/runtime', createRuntimeHandler({ sessionToken }));
  app.get('/api/health', getHealthHandler);
  app.get('/api/ncm/status', createNcmStatusHandler(options.ncm));
  app.get('/api/ncm/login/qr', createNcmQrHandler(options.ncmAuth));
  app.post('/api/ncm/login/qr', createNcmQrHandler(options.ncmAuth));
  app.get('/api/ncm/login/status', createNcmQrStatusHandler(options.ncmAuth));
  app.get('/api/ncm/login/session', createNcmSessionHandler(options.ncmAuth));
  app.post('/api/ncm/login/logout', createNcmLogoutHandler(options.ncmAuth));
  app.post('/api/ncm/logout', createNcmLogoutHandler(options.ncmAuth));
  app.get('/api/now', createNowHandler(options.ncmClient));
  app.get('/api/next', createNextHandler(options.ncmClient));
  app.post('/api/plays', createStartPlayHandler());
  app.patch('/api/plays/:id', createEndPlayHandler());
  app.get('/api/settings', createGetSettingsHandler(options.secrets));
  app.put('/api/settings', createSaveSettingsHandler(options.secrets));
  app.get('/api/plan/today', createGetTodayPlanHandler({ secrets: options.secrets, ncmClient: options.ncmClient }));
  app.post('/api/plan/regenerate', createRegeneratePlanHandler({ secrets: options.secrets, ncmClient: options.ncmClient }));
  app.post('/api/plan/replan-segment', createReplanSegmentHandler({ secrets: options.secrets, ncmClient: options.ncmClient }));
  app.post('/api/plan/gap-fill', createGapFillHandler({ secrets: options.secrets, ncmClient: options.ncmClient }));
  app.get('/api/queue/liked', createGetLikedQueueHandler(options.ncmClient));
  app.put('/api/queue/state', createSetQueueStateHandler());
  app.post('/api/segue/trigger', createSegueTriggerHandler({ secrets: options.secrets, ncmClient: options.ncmClient }));
  app.get('/api/segue/audio/*', createSegueAudioHandler());

  if (options.staticDir && fs.existsSync(options.staticDir)) {
    app.use(express.static(options.staticDir));
    app.get(/^(?!\/api(?:\/|$)|\/ws(?:\/|$)).*/, (_req, res) => {
      res.sendFile(path.join(options.staticDir!, 'index.html'));
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : 'unknown error';
    res.status(500).json({ ok: false, error: message });
  });

  const server = createServer(app);
  const chatHandler = createChatMessageHandler({ secrets: options.secrets, ncmClient: options.ncmClient });
  setupWsServer(server, { sessionToken, onChatMessage: chatHandler });

  const port = await listen(server, options.host, options.port);
  const baseUrl = `http://${options.host}:${port}`;
  const wsUrl = `ws://${options.host}:${port}/ws`;

  return {
    port,
    baseUrl,
    wsUrl,
    sessionToken,
    close: async () => closeServer(server)
  };
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
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
