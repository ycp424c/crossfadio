import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import pino from 'pino';

let loggerInstance: pino.Logger | null = null;

function resolveLogFilePath(): string {
  const userData = app.getPath('userData');
  const logsDir = path.join(userData, 'logs');
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
