import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { resolveStateDbPath } from '../app-paths.js';
import { runMigrations } from './migrations.js';

let dbInstance: Database.Database | null = null;

export function initDb(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = resolveStateDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

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

export function _resetDbForTest(): void {
  dbInstance?.close();
  dbInstance = null;
}
