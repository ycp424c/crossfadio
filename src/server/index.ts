import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalServer, type LocalServer } from './http/index.js';
import { initDb } from './store/db.js';
import { getLogger } from './logger.js';
import { loadConfig } from './config.js';
import { loadAllowlist } from './allowlist.js';
import { NcmProcessManager } from './ncm/spawn.js';
import { NcmClient } from './ncm/client.js';
import { NcmAuthService } from './ncm/auth.js';
import { resolveStaticDir as resolveRuntimeStaticDir } from './runtime.js';
import { startRetentionMaintenance } from './maintenance/retention.js';
import {
  createSelectionNarrationRuntime,
  type SelectionNarrationRuntime
} from './jobs/selection-narration-runtime.js';
import {
  createPreferenceExtractionRuntime,
  type PreferenceExtractionRuntime
} from './jobs/preference-extraction-runtime.js';
import {
  createExplicitExclusionResolutionRuntime,
  type ExplicitExclusionResolutionRuntime
} from './jobs/explicit-exclusion-resolution-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let localServer: LocalServer | null = null;
let ncm: NcmProcessManager | null = null;
let retentionMaintenance: ReturnType<typeof startRetentionMaintenance> | null = null;
let selectionNarrationRuntime: SelectionNarrationRuntime | null = null;
let preferenceExtractionRuntime: PreferenceExtractionRuntime | null = null;
let explicitExclusionResolutionRuntime: ExplicitExclusionResolutionRuntime | null = null;

async function bootstrap(): Promise<void> {
  const logger = getLogger();

  try {
    loadConfig();
    loadAllowlist();
    initDb();
    retentionMaintenance = startRetentionMaintenance({
      onError(error) {
        logger.warn({ err: error }, 'DJ v2 retention maintenance failed');
      }
    });
    selectionNarrationRuntime = createSelectionNarrationRuntime();
    selectionNarrationRuntime.start();
    preferenceExtractionRuntime = createPreferenceExtractionRuntime();
    preferenceExtractionRuntime.start();

    ncm = new NcmProcessManager();
    await ncm.start();
    explicitExclusionResolutionRuntime = createExplicitExclusionResolutionRuntime({
      ncmBaseUrl: ncm.getStatus().baseUrl
    });
    explicitExclusionResolutionRuntime.start();

    const ncmClient = new NcmClient(ncm.getStatus().baseUrl, {
      getCookie: () => null
    });

    const authRef = new NcmAuthService(ncmClient);

    localServer = await startLocalServer({
      ncm,
      ncmAuth: authRef,
      ncmBaseUrl: ncm.getStatus().baseUrl,
      host: resolveHost(),
      port: resolveServerPort(),
      staticDir: resolveStaticDir()
    });

    logger.info({ baseUrl: localServer.baseUrl, ncm: ncm.getStatus() }, 'Crossfadio web server started');
  } catch (error) {
    logger.error({ err: error }, 'Failed to bootstrap Crossfadio web server');
    await shutdown();
    process.exitCode = 1;
  }
}

async function shutdown(): Promise<void> {
  const logger = getLogger();

  if (explicitExclusionResolutionRuntime) {
    try {
      await explicitExclusionResolutionRuntime.stop();
    } catch (error) {
      logger.warn({ err: error }, 'Failed to stop Explicit Exclusion resolution cleanly');
    } finally {
      explicitExclusionResolutionRuntime = null;
    }
  }

  if (preferenceExtractionRuntime) {
    try {
      await preferenceExtractionRuntime.stop();
    } catch (error) {
      logger.warn({ err: error }, 'Failed to stop Preference Extraction cleanly');
    } finally {
      preferenceExtractionRuntime = null;
    }
  }

  if (selectionNarrationRuntime) {
    try {
      await selectionNarrationRuntime.stop();
    } catch (error) {
      logger.warn({ err: error }, 'Failed to stop Selection Journey narration cleanly');
    } finally {
      selectionNarrationRuntime = null;
    }
  }

  retentionMaintenance?.stop();
  retentionMaintenance = null;

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

function resolveHost(): string {
  return process.env.CROSSFADIO_HOST?.trim() || '127.0.0.1';
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
