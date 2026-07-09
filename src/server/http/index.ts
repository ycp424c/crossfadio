import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { getConfig } from '../config.js';
import { getHealthHandler } from './routes/health.js';
import type { NcmProcessManager } from '../ncm/spawn.js';
import { createNcmStatusHandler } from './routes/ncm.js';
import type { NcmAuthService } from '../ncm/auth.js';
import {
  createNcmLogoutHandler,
  createNcmQrHandler,
  createNcmQrStatusHandler,
  createNcmSessionHandler
} from './routes/ncm-login.js';
import { createNextHandler, createNowHandler } from './routes/now-next.js';
import { createStartPlayHandler, createEndPlayHandler } from './routes/plays.js';
import {
  createGetSettingsHandler,
  createPreviewTtsHandler,
  createSaveSettingsHandler,
  createGetPlayerContextHandler
} from './routes/settings.js';
import { createAnalyzeTasteHandler } from './routes/taste-analysis.js';
import { createSegueTriggerHandler, createSegueAudioHandler, createSseSegueHandler } from './routes/segue.js';
import { createDjPickNextHandler, createSseDjPickNextHandler } from './routes/djNext.js';
import { createGetRecentMessagesHandler } from './routes/messages.js';
import { createSetLocationHandler } from './routes/location.js';
import {
  createGetWhitelistHandler,
  createGetBlockedHandler,
  createAddToWhitelistHandler,
  createRemoveFromWhitelistHandler,
  createUnblockHandler
} from './routes/whitelist.js';
import { createRuntimeHandler } from './routes/runtime.js';
import {
  createCreatePersonalDjContextTokenHandler,
  createGetPersonalDjContextStatusHandler,
  createListPersonalDjContextTokensHandler,
  createPostPersonalDjContextHandler,
  createRevokeCurrentPersonalDjContextHandler,
  createRevokePersonalDjContextTokenHandler
} from './routes/personal-dj-context.js';
import {
  createGetLikedIdsHandler,
  createGetLikedQueueHandler,
  createLikeTrackHandler,
  createSetQueueStateHandler
} from './routes/queue.js';
import { authMiddleware } from './middleware/auth.js';
import { userScopeMiddleware } from './middleware/userScope.js';
import { adminMiddleware } from './middleware/admin.js';
import { personalDjContextBridgeAuth } from './middleware/personalDjContextBridgeAuth.js';
import { createSseEventsHandler, createSseChatHandler, createSseCancelRecommendHandler } from './routes/sse-events.js';

export type LocalServer = {
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
};

type StartLocalServerOptions = {
  ncm: NcmProcessManager;
  ncmAuth: NcmAuthService;
  ncmBaseUrl: string;
  host: string;
  port: number;
  staticDir?: string | null;
};

export async function startLocalServer(options: StartLocalServerOptions): Promise<LocalServer> {
  const config = getConfig();
  const app = express();

  // Store NCM base URL for middleware
  app.locals.ncmBaseUrl = options.ncmBaseUrl;

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || origin === 'null') { callback(null, true); return; }
        if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) { callback(null, true); return; }
        if (config.allowedOrigins.some((o) => o === origin)) { callback(null, true); return; }
        callback(new Error(`CORS blocked origin: ${origin}`));
      }
    })
  );
  app.use(express.json({ limit: '1mb' }));

  // ── Public routes ─────────────────────────────────────────────────────────
  app.get('/api/runtime', createRuntimeHandler());
  app.get('/api/health', getHealthHandler);
  app.get('/api/ncm/status', createNcmStatusHandler(options.ncm));
  app.get('/api/ncm/login/qr', createNcmQrHandler(options.ncmAuth));
  app.post('/api/ncm/login/qr', createNcmQrHandler(options.ncmAuth));
  app.get('/api/ncm/login/status', createNcmQrStatusHandler(options.ncmAuth));
  app.get('/api/segue/audio/*', createSegueAudioHandler());

  // ── Bridge-token routes ─────────────────────────────────────────────────────
  app.post('/api/personal-dj-context', personalDjContextBridgeAuth, createPostPersonalDjContextHandler());

  // ── Protected routes ──────────────────────────────────────────────────────
  const protect = [authMiddleware, userScopeMiddleware];
  const adminProtect = [authMiddleware, userScopeMiddleware, adminMiddleware];

  app.get('/api/ncm/login/session', protect, createNcmSessionHandler());
  app.post('/api/ncm/login/logout', protect, createNcmLogoutHandler());
  app.post('/api/ncm/logout', protect, createNcmLogoutHandler());
  app.get('/api/now', protect, createNowHandler());
  app.get('/api/next', protect, createNextHandler());
  app.post('/api/plays', protect, createStartPlayHandler());
  app.patch('/api/plays/:id', protect, createEndPlayHandler());
  app.get('/api/settings', protect, createGetSettingsHandler());
  app.put('/api/settings', protect, createSaveSettingsHandler());
  app.post('/api/settings/tts-preview', protect, createPreviewTtsHandler());
  app.post('/api/settings/analyze-taste', protect, createAnalyzeTasteHandler());
  app.get('/api/settings/player-context', protect, createGetPlayerContextHandler());
  app.get('/api/settings/personal-dj-context', protect, createGetPersonalDjContextStatusHandler());
  app.post('/api/settings/personal-dj-context/revoke-current', protect, createRevokeCurrentPersonalDjContextHandler());
  app.get('/api/settings/personal-dj-context/tokens', protect, createListPersonalDjContextTokensHandler());
  app.post('/api/settings/personal-dj-context/tokens', protect, createCreatePersonalDjContextTokenHandler());
  app.delete('/api/settings/personal-dj-context/tokens/:id', protect, createRevokePersonalDjContextTokenHandler());
  app.get('/api/queue/liked/ids', protect, createGetLikedIdsHandler());
  app.get('/api/queue/liked', protect, createGetLikedQueueHandler());
  app.post('/api/queue/like', protect, createLikeTrackHandler());
  app.put('/api/queue/state', protect, createSetQueueStateHandler());
  app.post('/api/segue/trigger', protect, createSegueTriggerHandler({ secrets: null as any }));
  app.post('/api/dj/pick-next', protect, createDjPickNextHandler({ secrets: null as any }));
  app.get('/api/messages/recent', protect, createGetRecentMessagesHandler());
  app.post('/api/location', protect, createSetLocationHandler());
  app.get('/api/whitelist', adminProtect, createGetWhitelistHandler());
  app.get('/api/whitelist/blocked', adminProtect, createGetBlockedHandler());
  app.post('/api/whitelist', adminProtect, createAddToWhitelistHandler());
  app.delete('/api/whitelist/:ncmId', adminProtect, createRemoveFromWhitelistHandler());
  app.post('/api/whitelist/unblock/:id', adminProtect, createUnblockHandler());

  // ── SSE routes ───────────────────────────────────────────────────────────
  app.get('/api/sse/events', protect, createSseEventsHandler());
  app.post('/api/sse/chat', protect, createSseChatHandler());
  app.post('/api/sse/chat/cancel', protect, createSseCancelRecommendHandler());
  app.post('/api/sse/segue', protect, createSseSegueHandler({ secrets: null as any }));
  app.post('/api/sse/pick-next', protect, createSseDjPickNextHandler({ secrets: null as any }));

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

  const port = await listen(server, options.host, options.port);
  const baseUrl = `http://${options.host}:${port}`;
  return {
    port,
    baseUrl,
    close: async () => closeServer(server)
  };
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Failed to acquire port.')); return; }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
