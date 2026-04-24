import fs from 'node:fs';
import path from 'node:path';
import { buildCacheHash, getTtsCacheDir } from './cache.js';
import type { TtsConfig, TtsResult } from './client.js';
import type { Track } from '../agent/schema.js';

export type FallbackAwareTtsResult = TtsResult & {
  fallback: boolean;
};

export function buildFallbackTemplateText(to: Pick<Track, 'id' | 'name' | 'artist'>): string {
  const title = to.name?.trim() || '下一首';
  const artist = to.artist?.trim();
  const label = artist ? `${artist} 的 ${title}` : title;
  return `接下来换到 ${label}，让音乐继续。`;
}

export function getCachedFallbackTts(config: TtsConfig, text: string): TtsResult | null {
  const filePath = fallbackFilePath(config, text);
  return fs.existsSync(filePath) ? { filePath, cached: true } : null;
}

export function saveFallbackTtsToCache(config: TtsConfig, text: string, data: Buffer): TtsResult {
  const filePath = fallbackFilePath(config, text);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
  return { filePath, cached: false };
}

export async function ensureFallbackTtsCached(
  config: TtsConfig,
  text: string,
  synthesize: (text: string) => Promise<TtsResult>
): Promise<TtsResult> {
  const cached = getCachedFallbackTts(config, text);
  if (cached) return cached;

  const synthesized = await synthesize(text);
  const data = fs.readFileSync(synthesized.filePath);
  return saveFallbackTtsToCache(config, text, data);
}

export async function synthesizeTtsWithFallback(
  config: TtsConfig,
  text: string,
  fallbackText: string,
  synthesize: (text: string) => Promise<TtsResult>
): Promise<FallbackAwareTtsResult> {
  try {
    const result = await synthesize(text);
    return { ...result, fallback: false };
  } catch (err) {
    const fallback = getCachedFallbackTts(config, fallbackText);
    if (fallback) return { ...fallback, fallback: true };
    throw err;
  }
}

function fallbackFilePath(config: TtsConfig, text: string): string {
  const hash = buildCacheHash({
    endpoint: 'fallback-template',
    model: config.model,
    voice: config.voice,
    speed: config.speed,
    format: config.format,
    text
  });
  return path.join(getTtsCacheDir(), 'fallback', safePathSegment(config.voice), `${hash}.${config.format}`);
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_') || 'voice';
}
