import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveAppDataDir, resolveSecretsFilePath } from './app-paths.js';

type EncryptedSecretRecord = {
  encrypted: true;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  value: string;
};

type LegacySecretRecord = {
  encrypted: false;
  value: string;
};

type SecretRecord = EncryptedSecretRecord | LegacySecretRecord;
type SecretMap = Record<string, SecretRecord>;

const KEYCHAIN_SERVICE = 'Crossfadio';
const KEYCHAIN_ACCOUNT = 'secret-store-key';

export class SecretStore {
  private readonly filePath: string;
  private readonly key: Buffer;
  private cache: SecretMap = {};

  constructor() {
    this.filePath = resolveSecretsFilePath();
    this.key = resolveMasterKey();
    const loaded = this.loadFromDisk();
    this.cache = loaded.secrets;
    if (loaded.needsPersist) {
      this.persist();
    }
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

      const decipher = createDecipheriv(
        record.algorithm,
        this.key,
        Buffer.from(record.iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(record.value, 'base64')),
        decipher.final()
      ]).toString('utf-8');
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    this.cache[key] = this.encrypt(value);
    this.persist();
  }

  remove(key: string): void {
    delete this.cache[key];
    this.persist();
  }

  private loadFromDisk(): { secrets: SecretMap; needsPersist: boolean } {
    if (!fs.existsSync(this.filePath)) {
      return { secrets: {}, needsPersist: false };
    }

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { secrets: {}, needsPersist: false };
      }

      let needsPersist = false;
      const secrets: SecretMap = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') {
          secrets[key] = this.encrypt(value);
          needsPersist = true;
          continue;
        }

        if (isEncryptedRecord(value)) {
          secrets[key] = value;
          continue;
        }

        if (isLegacyRecord(value)) {
          secrets[key] = this.encrypt(value.value);
          needsPersist = true;
        }
      }

      return { secrets, needsPersist };
    } catch {
      return { secrets: {}, needsPersist: false };
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8');
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Best-effort on platforms/filesystems that support POSIX file modes.
    }
  }

  private encrypt(value: string): EncryptedSecretRecord {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);

    return {
      encrypted: true,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      value: encrypted.toString('base64')
    };
  }
}

function isEncryptedRecord(value: unknown): value is EncryptedSecretRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<EncryptedSecretRecord>;
  return (
    record.encrypted === true &&
    record.algorithm === 'aes-256-gcm' &&
    typeof record.iv === 'string' &&
    typeof record.tag === 'string' &&
    typeof record.value === 'string'
  );
}

function isLegacyRecord(value: unknown): value is LegacySecretRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<LegacySecretRecord>;
  return record.encrypted === false && typeof record.value === 'string';
}

function resolveMasterKey(): Buffer {
  const envKey = process.env.CROSSFADIO_SECRET_KEY?.trim();
  if (envKey) {
    return normalizeKeyMaterial(envKey);
  }

  if (process.platform === 'darwin') {
    const keychainKey = getOrCreateMacKeychainSecret();
    if (keychainKey) {
      return normalizeKeyMaterial(keychainKey);
    }
  }

  return getOrCreateLocalKeyFile();
}

function normalizeKeyMaterial(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function getOrCreateMacKeychainSecret(): string | null {
  const existing = spawnSync('security', [
    'find-generic-password',
    '-w',
    '-s',
    KEYCHAIN_SERVICE,
    '-a',
    KEYCHAIN_ACCOUNT
  ], { encoding: 'utf-8' });

  if (existing.status === 0 && existing.stdout.trim()) {
    return existing.stdout.trim();
  }

  const created = randomBytes(32).toString('base64');
  const result = spawnSync('security', [
    'add-generic-password',
    '-U',
    '-s',
    KEYCHAIN_SERVICE,
    '-a',
    KEYCHAIN_ACCOUNT,
    '-w',
    created
  ], { encoding: 'utf-8' });

  return result.status === 0 ? created : null;
}

function getOrCreateLocalKeyFile(): Buffer {
  const keyPath = path.join(resolveAppDataDir(), 'secrets.key');
  if (fs.existsSync(keyPath)) {
    return normalizeKeyMaterial(fs.readFileSync(keyPath, 'utf-8').trim());
  }

  const key = randomBytes(32).toString('base64');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key, { encoding: 'utf-8', mode: 0o600 });
  return normalizeKeyMaterial(key);
}
