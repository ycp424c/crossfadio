import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalServer, type LocalServer } from './http/index.js';
import { initDb } from './store/db.js';
import { getLogger } from './logger.js';
import { ensureUserCorpus } from './user-corpus/bootstrap.js';
import { NcmProcessManager } from './ncm/spawn.js';
import { NcmClient } from './ncm/client.js';
import { NcmAuthService } from './ncm/auth.js';
import { SecretStore } from './security.js';
import { resolveStaticDir as resolveRuntimeStaticDir } from './runtime.js';
import { startScheduler, stopScheduler } from './scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let localServer: LocalServer | null = null;
let ncm: NcmProcessManager | null = null;

async function bootstrap(): Promise<void> {
  const logger = getLogger();

  try {
    ensureUserCorpus();
    initDb();

    const secrets = new SecretStore();
    ncm = new NcmProcessManager();
    await ncm.start();

    let authRef: NcmAuthService | null = null;
    const ncmClient = new NcmClient(ncm.getStatus().baseUrl, {
      getCookie: () => authRef?.getCookie() ?? null
    });

    authRef = new NcmAuthService(ncmClient, secrets);

    localServer = await startLocalServer({
      ncm,
      ncmAuth: authRef,
      ncmClient,
      secrets,
      host: '127.0.0.1',
      port: resolveServerPort(),
      staticDir: resolveStaticDir()
    });

    startScheduler({ secrets, ncmClient });
    logger.info({ baseUrl: localServer.baseUrl, ncm: ncm.getStatus() }, 'Crossfadio web server started');
  } catch (error) {
    logger.error({ err: error }, 'Failed to bootstrap Crossfadio web server');
    await shutdown();
    process.exitCode = 1;
  }
}

async function shutdown(): Promise<void> {
  const logger = getLogger();

  stopScheduler();

  if (ncm) {
    try {
      await ncm.stop();
    } catch (error) {
      logger.warn({ err: error }, 'Failed to stop NCM process cleanly');
    } finally {
      ncm = null;
    }
  }

  if (localServer) {
    try {
      await localServer.close();
    } catch (error) {
      logger.warn({ err: error }, 'Failed to close local server cleanly');
    } finally {
      localServer = null;
    }
  }
}

function resolveServerPort(): number {
  const rawPort = Number(process.env.CROSSFADIO_PORT ?? '4318');

  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
    return 4318;
  }

  return rawPort;
}

function resolveStaticDir(): string | null {
  return resolveRuntimeStaticDir({
    rootDir: path.resolve(__dirname, '../..'),
    nodeEnv: process.env.NODE_ENV
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}

void bootstrap();
