import { contextBridge } from 'electron';

type RuntimeConfig = {
  baseUrl: string;
  wsUrl: string;
  sessionToken: string;
};

function getArgValue(key: string): string {
  const prefix = `--${key}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

const runtimeConfig: RuntimeConfig = {
  baseUrl: getArgValue('CROSSFADIO_BASE_URL'),
  wsUrl: getArgValue('CROSSFADIO_WS_URL'),
  sessionToken: getArgValue('CROSSFADIO_SESSION_TOKEN')
};

contextBridge.exposeInMainWorld('crossfadio', {
  getRuntimeConfig: () => runtimeConfig
});
