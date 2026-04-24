import fs from 'node:fs';
import path from 'node:path';
import { resolveSecretsFilePath } from './app-paths.js';

type SecretMap = Record<string, string>;

export class SecretStore {
  private readonly filePath: string;
  private cache: SecretMap = {};

  constructor() {
    this.filePath = resolveSecretsFilePath();
    this.cache = this.loadFromDisk();
  }

  get(key: string): string | null {
    return this.cache[key] ?? null;
  }

  set(key: string, value: string): void {
    this.cache[key] = value;
    this.persist();
  }

  remove(key: string): void {
    delete this.cache[key];
    this.persist();
  }

  private loadFromDisk(): SecretMap {
    if (!fs.existsSync(this.filePath)) {
      return {};
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as SecretMap;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8');
  }
}
