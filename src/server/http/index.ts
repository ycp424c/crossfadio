import { randomUUID } from 'node:crypto';
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
import {
  createPatchListeningEpisodeHandler,
  createPutListeningEpisodeHandler
} from './routes/listening-episodes.js';
import { createListSelectionJourneysHandler } from './routes/selection-journeys.js';
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
import {
  createGetSuspendedHandler,
  createSuspendUserHandler,
  createReactivateUserHandler
} from './routes/access-controls.js';
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
import { qrCreateLimiter, qrStatusLimiter } from './middleware/ip-rate-limit.js';
import { safeOperationalError } from '../errors/safe-operational-error.js';
import { getLogger } from '../logger.js';
import { handleAsync } from './async-handler.js';

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

  // Trust forwarded headers ONLY for sockets whose remote address matches the
  // explicit trusted-proxy IP/CIDR allowlist (Express `trust proxy` with
  // CIDRs). The default empty allowlist keeps req.ip as the socket address so
  // QR rate-limit buckets can never be forged through X-Forwarded-For; an
  // operator must name their exact proxy addresses, never just a hop count.
  if (config.trustedProxyCidrs.length > 0) {
    app.set('trust proxy', config.trustedProxyCidrs);
  }

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

  const routes = {
    get(path: string, ...handlers: express.RequestHandler[]): void {
      app.get(path, ...handlers.map(handleAsync));
    },
    post(path: string, ...handlers: express.RequestHandler[]): void {
      app.post(path, ...handlers.map(handleAsync));
    },
    put(path: string, ...handlers: express.RequestHandler[]): void {
      app.put(path, ...handlers.map(handleAsync));
    },
    patch(path: string, ...handlers: express.RequestHandler[]): void {
      app.patch(path, ...handlers.map(handleAsync));
    },
    delete(path: string, ...handlers: express.RequestHandler[]): void {
      app.delete(path, ...handlers.map(handleAsync));
    }
  };

  // ── Public routes ─────────────────────────────────────────────────────────
  routes.get('/api/runtime', createRuntimeHandler());
  routes.get('/api/health', getHealthHandler);
  routes.get('/api/ncm/status', createNcmStatusHandler(options.ncm));
  routes.get('/api/ncm/login/qr', qrCreateLimiter, createNcmQrHandler(options.ncmAuth));
  routes.post('/api/ncm/login/qr', qrCreateLimiter, createNcmQrHandler(options.ncmAuth));
  routes.get('/api/ncm/login/status', qrStatusLimiter, createNcmQrStatusHandler(options.ncmAuth));
  routes.get('/api/segue/audio/*', createSegueAudioHandler());

  // ── Bridge-token routes ─────────────────────────────────────────────────────
  routes.post('/api/personal-dj-context', personalDjContextBridgeAuth, createPostPersonalDjContextHandler());

  // ── Protected routes ──────────────────────────────────────────────────────
  const protect = [authMiddleware, userScopeMiddleware];
  const adminProtect = [authMiddleware, userScopeMiddleware, adminMiddleware];

  routes.get('/api/ncm/login/session', ...protect, createNcmSessionHandler());
  routes.post('/api/ncm/login/logout', ...protect, createNcmLogoutHandler());
  routes.post('/api/ncm/logout', ...protect, createNcmLogoutHandler());
  routes.get('/api/now', ...protect, createNowHandler());
  routes.get('/api/next', ...protect, createNextHandler());
  routes.put('/api/listening-episodes/:clientEpisodeId', ...protect, createPutListeningEpisodeHandler());
  routes.patch('/api/listening-episodes/:clientEpisodeId', ...protect, createPatchListeningEpisodeHandler());
  routes.get('/api/dj/selection-journeys', ...protect, createListSelectionJourneysHandler());
  routes.get('/api/settings', ...protect, createGetSettingsHandler());
  routes.put('/api/settings', ...protect, createSaveSettingsHandler());
  routes.post('/api/settings/tts-preview', ...protect, createPreviewTtsHandler());
  routes.post('/api/settings/analyze-taste', ...protect, createAnalyzeTasteHandler());
  routes.get('/api/settings/player-context', ...protect, createGetPlayerContextHandler());
  routes.get('/api/settings/personal-dj-context', ...protect, createGetPersonalDjContextStatusHandler());
  routes.post('/api/settings/personal-dj-context/revoke-current', ...protect, createRevokeCurrentPersonalDjContextHandler());
  routes.get('/api/settings/personal-dj-context/tokens', ...protect, createListPersonalDjContextTokensHandler());
  routes.post('/api/settings/personal-dj-context/tokens', ...protect, createCreatePersonalDjContextTokenHandler());
  routes.delete('/api/settings/personal-dj-context/tokens/:id', ...protect, createRevokePersonalDjContextTokenHandler());
  routes.get('/api/queue/liked/ids', ...protect, createGetLikedIdsHandler());
  routes.get('/api/queue/liked', ...protect, createGetLikedQueueHandler());
  routes.post('/api/queue/like', ...protect, createLikeTrackHandler());
  routes.put('/api/queue/state', ...protect, createSetQueueStateHandler());
  routes.post('/api/segue/trigger', ...protect, createSegueTriggerHandler({ secrets: null as any }));
  routes.post('/api/dj/pick-next', ...protect, createDjPickNextHandler({ secrets: null as any }));
  routes.get('/api/messages/recent', ...protect, createGetRecentMessagesHandler());
  routes.post('/api/location', ...protect, createSetLocationHandler());
  routes.get('/api/whitelist', ...adminProtect, createGetWhitelistHandler());
  routes.get('/api/whitelist/blocked', ...adminProtect, createGetBlockedHandler());
  routes.post('/api/whitelist', ...adminProtect, createAddToWhitelistHandler());
  routes.delete('/api/whitelist/:ncmId', ...adminProtect, createRemoveFromWhitelistHandler());
  routes.post('/api/whitelist/unblock/:id', ...adminProtect, createUnblockHandler());
  routes.get('/api/access/suspended', ...adminProtect, createGetSuspendedHandler());
  routes.post('/api/access/suspended', ...adminProtect, createSuspendUserHandler());
  routes.delete('/api/access/suspended/:ncmId', ...adminProtect, createReactivateUserHandler());

  // ── SSE routes ───────────────────────────────────────────────────────────
  routes.get('/api/sse/events', ...protect, createSseEventsHandler());
  routes.post('/api/sse/chat', ...protect, createSseChatHandler());
  routes.post('/api/sse/chat/cancel', ...protect, createSseCancelRecommendHandler());
  routes.post('/api/sse/segue', ...protect, createSseSegueHandler({ secrets: null as any }));
  routes.post('/api/sse/pick-next', ...protect, createSseDjPickNextHandler({ secrets: null as any }));

  if (options.staticDir && fs.existsSync(options.staticDir)) {
    app.use(express.static(options.staticDir));
    app.get(/^(?!\/api(?:\/|$)|\/ws(?:\/|$)).*/, (_req, res) => {
      res.sendFile(path.join(options.staticDir!, 'index.html'));
    });
  }

  app.use(createGlobalErrorHandler());

  const server = createServer(app);

  const port = await listen(server, options.host, options.port);
  const baseUrl = `http://${options.host}:${port}`;
  return {
    port,
    baseUrl,
    close: async () => closeServer(server)
  };
}

type ErrorLogger = {
  error(payload: Record<string, unknown>, message: string): void;
};

export function createGlobalErrorHandler(logger: ErrorLogger = getLogger()) {
  return (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void => {
    const correlationId = randomUUID();
    logger.error(
      { correlationId, ...safeOperationalError(error, 'unhandled_http_error') },
      'Unhandled HTTP request failure'
    );
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(500).json({
      ok: false,
      error: 'internal_error',
      message: '请求暂时失败，请稍后重试',
      correlationId
    });
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
