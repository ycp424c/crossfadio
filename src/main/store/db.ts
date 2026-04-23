import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations';

let dbInstance: Database.Database | null = null;

export function initDb(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  const dbPath = path.join(userData, 'state.db');

  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
  runMigrations(dbInstance);

  return dbInstance;
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database is not initialized.');
  }

  return dbInstance;
}
