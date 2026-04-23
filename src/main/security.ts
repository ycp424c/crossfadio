import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';

type SecretRecord = {
  encrypted: boolean;
  value: string;
};

type SecretMap = Record<string, SecretRecord>;

export class SecretStore {
  private readonly filePath: string;
  private cache: SecretMap = {};

  constructor() {
    const userData = app.getPath('userData');
    this.filePath = path.join(userData, 'secrets.bin');
    this.cache = this.loadFromDisk();
  }

  get(key: string): string | null {
    const record = this.cache[key];
    if (!record) {
      return null;
    }

    try {
      if (!record.encrypted) {
        return record.value;
      }

      const decoded = Buffer.from(record.value, 'base64');
      return safeStorage.decryptString(decoded);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    this.cache[key] = this.encode(value);
    this.persist();
  }

  remove(key: string): void {
    delete this.cache[key];
    this.persist();
  }

  private encode(value: string): SecretRecord {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(value).toString('base64');
      return {
        encrypted: true,
        value: encrypted
      };
    }

    return {
      encrypted: false,
      value
    };
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
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8');
  }
}
