import fs from 'node:fs';
import path from 'node:path';
import { buildCacheHash, getTtsCacheDir } from './cache.js';
import {
  resolvePreferredTtsAudioFormat,
  resolveTtsCacheHashFormat,
  resolveTtsCacheLookupFormats,
  type TtsConfig,
  type TtsResult
} from './client.js';
import { getLogger } from '../logger.js';
import type { Track } from '../agent/schema.js';

export type FallbackAwareTtsResult = TtsResult & {
  fallback: boolean;
};

export function buildFallbackTemplateText(_to: Pick<Track, 'id' | 'name' | 'artist'>): string {
  return '接下来切换到下一首，让音乐继续。';
}

export function getCachedFallbackTts(config: TtsConfig, text: string): TtsResult | null {
  for (const format of resolveTtsCacheLookupFormats(config)) {
    const filePath = fallbackFilePath(config, text, format);
    if (fs.existsSync(filePath)) {
      return { filePath, cached: true };
    }
  }
  return null;
}

export function saveFallbackTtsToCache(
  config: TtsConfig,
  text: string,
  data: Buffer,
  format?: string
): TtsResult {
  const resolvedFormat = normalizeAudioFormat(format) ?? resolvePreferredTtsAudioFormat(config);
  const filePath = fallbackFilePath(config, text, resolvedFormat);
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
  const synthesizedFormat = normalizeAudioFormat(path.extname(synthesized.filePath).slice(1));
  return saveFallbackTtsToCache(config, text, data, synthesizedFormat ?? undefined);
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
    if (fallback) {
      getLogger().warn({ err, provider: config.provider }, 'TTS synthesis failed; serving cached fallback audio');
      return { ...fallback, fallback: true };
    }
    throw err;
  }
}

function fallbackFilePath(config: TtsConfig, text: string, format: string): string {
  const hash = buildCacheHash({
    endpoint: config.baseUrl ? `${config.baseUrl}/fallback-template` : `${config.provider}/fallback-template`,
    model: config.model,
    voice: config.voice,
    speed: config.speed,
    format: resolveTtsCacheHashFormat(config),
    text
  });
  return path.join(getTtsCacheDir(), 'fallback', safePathSegment(config.voice), `${hash}.${format}`);
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_') || 'voice';
}

function normalizeAudioFormat(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'm4a') return 'aac';
  if (normalized === 'wave') return 'wav';
  return ['wav', 'mp3', 'opus', 'aac', 'flac'].includes(normalized) ? normalized : null;
}
