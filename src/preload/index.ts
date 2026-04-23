import { contextBridge, ipcRenderer } from 'electron';

type RuntimeConfig = {
  baseUrl: string;
  wsUrl: string;
  sessionToken: string;
};

function getArgValue(key: string): string {
  const envValue = process.env[key];
  if (typeof envValue === 'string' && envValue.trim().length > 0) {
    return envValue.trim();
  }

  const prefix = `--${key}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  if (arg) {
    return arg.slice(prefix.length);
  }

  const standaloneKey = `--${key}`;
  const standaloneIndex = process.argv.indexOf(standaloneKey);
  if (standaloneIndex >= 0) {
    const next = process.argv[standaloneIndex + 1];
    if (typeof next === 'string' && next.length > 0 && !next.startsWith('--')) {
      return next;
    }
  }

  for (const item of process.argv) {
    const queryValue = getQueryValue(item, key);
    if (queryValue) {
      return queryValue;
    }
  }

  return '';
}

function getQueryValue(value: string, key: string): string {
  const queryIndex = value.indexOf('?');
  if (queryIndex < 0) {
    return '';
  }

  const query = value.slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  return params.get(key) ?? '';
}

function readRuntimeConfig(): RuntimeConfig {
  const local = {
    baseUrl: getArgValue('CROSSFADIO_BASE_URL'),
    wsUrl: getArgValue('CROSSFADIO_WS_URL'),
    sessionToken: getArgValue('CROSSFADIO_SESSION_TOKEN')
  };

  if (local.baseUrl && local.wsUrl && local.sessionToken) {
    return local;
  }

  try {
    const fallback = ipcRenderer.sendSync('crossfadio:get-runtime-config') as Partial<RuntimeConfig> | null;
    if (!fallback || typeof fallback !== 'object') {
      return local;
    }

    return {
      baseUrl: local.baseUrl || String(fallback.baseUrl ?? ''),
      wsUrl: local.wsUrl || String(fallback.wsUrl ?? ''),
      sessionToken: local.sessionToken || String(fallback.sessionToken ?? '')
    };
  } catch {
    return local;
  }
}

contextBridge.exposeInMainWorld('crossfadio', {
  getRuntimeConfig: () => readRuntimeConfig(),
  requestLocalApi: (path: string, method?: string) =>
    ipcRenderer.invoke('crossfadio:local-api', { path, method })
});
