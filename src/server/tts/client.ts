import { z } from 'zod';
import { buildCacheHash, getCachedFilePath, saveToCache } from './cache.js';

const ALIYUN_CACHE_HASH_FORMAT = 'aliyun-auto-v2';
const ALIYUN_CACHE_LOOKUP_FORMATS = ['wav', 'mp3', 'opus', 'aac', 'flac'] as const;

export const ttsConfigSchema = z.object({
  provider: z.enum(['openai-compatible', 'aliyun-qwen']).optional().default('openai-compatible'),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().default('tts-1'),
  voice: z.string().default('alloy'),
  speed: z.number().min(0.25).max(4.0).default(1.0),
  format: z.enum(['mp3', 'opus', 'aac', 'flac']).default('mp3')
});

export type TtsConfig = z.infer<typeof ttsConfigSchema>;

export type TtsResult = {
  filePath: string;
  cached: boolean;
};

export class TtsClient {
  constructor(private readonly config: TtsConfig) {}

  async synthesize(text: string, opts: { signal?: AbortSignal } = {}): Promise<TtsResult> {
    const hash = buildCacheHash({
      endpoint: this.config.baseUrl,
      model: this.config.model,
      voice: this.config.voice,
      speed: this.config.speed,
      format: resolveTtsCacheHashFormat(this.config),
      text
    });

    const cached = getCachedFilePath(hash, resolveTtsCacheLookupFormats(this.config));
    if (cached) {
      return { filePath: cached, cached: true };
    }

    if ((this.config.provider ?? 'openai-compatible') === 'aliyun-qwen') {
      return this.synthesizeWithAliyunQwen(text, hash, opts);
    }

    const resp = await fetch(`${this.config.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        input: text,
        voice: this.config.voice,
        speed: this.config.speed,
        response_format: this.config.format
      }),
      signal: opts.signal
    });

    if (!resp.ok) {
      throw new TtsError(`TTS request failed: ${resp.status} ${resp.statusText}`);
    }

    const data = Buffer.from(await resp.arrayBuffer());
    const filePath = saveToCache(hash, this.config.format, data);
    return { filePath, cached: false };
  }

  private async synthesizeWithAliyunQwen(
    text: string,
    hash: string,
    opts: { signal?: AbortSignal }
  ): Promise<TtsResult> {
    const resp = await fetch(this.config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        input: {
          text,
          voice: this.config.voice,
          language_type: 'Auto'
        }
      }),
      signal: opts.signal
    });

    if (!resp.ok) {
      throw new TtsError(`TTS request failed: ${resp.status} ${resp.statusText}`);
    }

    const payload = (await resp.json()) as unknown;
    const audioUrl = extractAliyunAudioUrl(payload);
    if (!audioUrl) {
      throw new TtsError('TTS request failed: missing Alibaba Qwen audio URL');
    }

    const audioResp = await fetch(audioUrl, { signal: opts.signal });
    if (!audioResp.ok) {
      throw new TtsError(`TTS audio download failed: ${audioResp.status} ${audioResp.statusText}`);
    }

    const data = Buffer.from(await audioResp.arrayBuffer());
    const detectedFormat = detectAudioFormat(audioUrl, audioResp.headers.get('content-type'), resolvePreferredTtsAudioFormat(this.config));
    const filePath = saveToCache(hash, detectedFormat, data);
    return { filePath, cached: false };
  }
}

export class TtsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsError';
  }
}

function extractAliyunAudioUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const output = (payload as { output?: unknown }).output;
  if (!output || typeof output !== 'object') return null;
  const audio = (output as { audio?: unknown }).audio;
  if (!audio || typeof audio !== 'object') return null;
  const url = (audio as { url?: unknown }).url;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

export function resolveTtsCacheHashFormat(config: Pick<TtsConfig, 'provider' | 'format'>): string {
  if ((config.provider ?? 'openai-compatible') === 'aliyun-qwen') {
    return ALIYUN_CACHE_HASH_FORMAT;
  }
  return config.format;
}

export function resolveTtsCacheLookupFormats(config: Pick<TtsConfig, 'provider' | 'format'>): string[] {
  if ((config.provider ?? 'openai-compatible') === 'aliyun-qwen') {
    return [...ALIYUN_CACHE_LOOKUP_FORMATS];
  }
  return [config.format];
}

export function resolvePreferredTtsAudioFormat(config: Pick<TtsConfig, 'provider' | 'format'>): string {
  if ((config.provider ?? 'openai-compatible') === 'aliyun-qwen') {
    return 'wav';
  }
  return config.format;
}

function detectAudioFormat(audioUrl: string, contentType: string | null, fallback: string): string {
  const byContentType = normalizeContentTypeFormat(contentType);
  if (byContentType) return byContentType;

  const byUrl = normalizeAudioFormat(fileExtension(audioUrl));
  if (byUrl) return byUrl;

  return fallback;
}

function normalizeContentTypeFormat(contentType: string | null): string | null {
  if (!contentType) return null;
  const normalized = contentType.toLowerCase().split(';', 1)[0]?.trim() ?? '';

  switch (normalized) {
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/aac':
      return 'aac';
    case 'audio/flac':
      return 'flac';
    case 'audio/ogg':
    case 'audio/opus':
      return 'opus';
    default:
      return null;
  }
}

function fileExtension(value: string): string {
  try {
    const pathname = new URL(value).pathname;
    const idx = pathname.lastIndexOf('.');
    if (idx < 0) return '';
    return pathname.slice(idx + 1).toLowerCase();
  } catch {
    return '';
  }
}

function normalizeAudioFormat(value: string): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();

  if (normalized === 'm4a') return 'aac';
  if (normalized === 'wave') return 'wav';

  return ALIYUN_CACHE_LOOKUP_FORMATS.includes(normalized as (typeof ALIYUN_CACHE_LOOKUP_FORMATS)[number])
    ? normalized
    : null;
}
