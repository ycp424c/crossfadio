import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { startLocalServer, type LocalServer } from './server';
import { initDb } from './store/db';
import { getLogger } from './logger';
import { ensureUserCorpus } from './user-corpus/bootstrap';
import { NcmProcessManager } from './ncm/spawn';
import { NcmClient } from './ncm/client';
import { NcmAuthService } from './ncm/auth';
import { SecretStore } from './security';

let mainWindow: BrowserWindow | null = null;
let localServer: LocalServer | null = null;
let ncm: NcmProcessManager | null = null;
let ncmAuth: NcmAuthService | null = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
});

app.whenReady().then(async () => {
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
    ncmAuth = authRef;

    localServer = await startLocalServer({ ncm, ncmAuth: authRef });

    createMainWindow(localServer);

    logger.info({ port: localServer.port, ncm: ncm.getStatus() }, 'Crossfadio started');
  } catch (error) {
    logger.error({ err: error }, 'Failed to bootstrap app');
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && localServer) {
    createMainWindow(localServer);
  }
});

app.on('before-quit', async () => {
  const logger = getLogger();
  if (ncm) {
    try {
      await ncm.stop();
      ncm = null;
    } catch (error) {
      logger.warn({ err: error }, 'Failed to stop NCM process cleanly');
    }
  }

  ncmAuth = null;

  if (localServer) {
    try {
      await localServer.close();
      localServer = null;
    } catch (error) {
      logger.warn({ err: error }, 'Failed to close local server cleanly');
    }
  }
});

function createMainWindow(server: LocalServer): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 680,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--CROSSFADIO_BASE_URL=${server.baseUrl}`,
        `--CROSSFADIO_WS_URL=${server.wsUrl}`,
        `--CROSSFADIO_SESSION_TOKEN=${server.sessionToken}`
      ]
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}
