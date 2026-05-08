import fs from 'node:fs';
import path from 'node:path';
import { resolveAppDataDir } from './app-paths.js';
import { getLogger } from './logger.js';

let allowlist: Set<string> | null = null;

export function loadAllowlist(): Set<string> {
  const filePath = path.join(resolveAppDataDir(), 'allowlist.json');

  if (!fs.existsSync(filePath)) {
    getLogger().warn({ filePath }, 'allowlist.json not found — no users will be permitted');
    allowlist = new Set();
    return allowlist;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      throw new Error('allowlist.json must be a JSON array of strings');
    }
    allowlist = new Set(parsed as string[]);
    getLogger().info({ count: allowlist.size }, 'Allowlist loaded');
    return allowlist;
  } catch (err) {
    getLogger().error({ err }, 'Failed to load allowlist.json');
    allowlist = new Set();
    return allowlist;
  }
}

export function isAllowed(ncmId: string): boolean {
  if (!allowlist) loadAllowlist();
  return allowlist!.has(ncmId);
}

export function getAllowlist(): string[] {
  if (!allowlist) loadAllowlist();
  return Array.from(allowlist!).sort();
}

export function addToAllowlist(ncmId: string): void {
  if (!allowlist) loadAllowlist();
  if (allowlist!.has(ncmId)) return;
  allowlist!.add(ncmId);
  saveAllowlist();
  getLogger().info({ ncmId }, 'Added to allowlist');
}

export function removeFromAllowlist(ncmId: string): void {
  if (!allowlist) loadAllowlist();
  if (!allowlist!.delete(ncmId)) return;
  saveAllowlist();
  getLogger().info({ ncmId }, 'Removed from allowlist');
}

function saveAllowlist(): void {
  const filePath = path.join(resolveAppDataDir(), 'allowlist.json');
  const arr = Array.from(allowlist!).sort();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(arr, null, 2), 'utf-8');
}
