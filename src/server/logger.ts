import path from 'node:path';
import fs from 'node:fs';
import pino from 'pino';
import { resolveLogsDir } from './app-paths.js';

let loggerInstance: pino.Logger | null = null;

function resolveLogFilePath(): string {
  const logsDir = resolveLogsDir();
  fs.mkdirSync(logsDir, { recursive: true });

  const day = new Date().toISOString().slice(0, 10);
  return path.join(logsDir, `app-${day}.log`);
}

export function getLogger(): pino.Logger {
  if (loggerInstance) {
    return loggerInstance;
  }

  loggerInstance = pino(
    {
      level: process.env.NODE_ENV === 'development' ? 'debug' : 'info'
    },
    pino.destination({
      dest: resolveLogFilePath(),
      sync: false,
      mkdir: true
    })
  );

  return loggerInstance;
}
