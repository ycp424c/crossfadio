import { randomUUID } from 'node:crypto';
import { createHmac, createHash } from 'node:crypto';
import { z } from 'zod';
import { buildCacheHash, getCachedFilePath, saveToCache } from './cache.js';
import { getLogger } from '../logger.js';
import { TENCENT_TTS_VOICE_IDS } from '../../shared/tts.js';

const ALIYUN_CACHE_HASH_FORMAT = 'aliyun-auto-v2';
const ALIYUN_CACHE_LOOKUP_FORMATS = ['wav', 'mp3', 'opus', 'aac', 'flac'] as const;
const TENCENT_CACHE_HASH_FORMAT = 'tencent-tts-v1';
const TENCENT_CACHE_LOOKUP_FORMATS = ['mp3'] as const;

// Tencent Cloud TTS (产品 1073) 短文本合成接口
const TENCENT_TTS_ENDPOINT = 'https://tts.tencentcloudapi.com';
const TENCENT_TTS_SERVICE = 'tts';
const TENCENT_TTS_VERSION = '2019-08-23';
const TENCENT_TTS_ACTION = 'TextToVoice';
const TENCENT_TTS_REGION = 'ap-guangzhou';
// TextToVoice 中文最多 150 字（接口文档：cloud.tencent.com/document/api/1073/37995）
const TENCENT_TTS_MAX_INPUT_CHARS = 150;

// 腾讯云 1073 基础音色（ModelType=1，按次计费、性价比高）。
// 官方音色表：1001 智瑜(女)、1002 智聆(女)、1003 智美(女)、1004 智云(男)、1005 智莉(女)、
// 1007 智娜(女)、1008 智琪(女)、1009 智芸(女)、1010 智华(男)；1006 与 1011+ 无效。
const TENCENT_BASIC_VOICE_FEMALE_DEFAULT = 1001; // 智瑜 · 情感女声
const TENCENT_BASIC_VOICE_MALE_DEFAULT = 1004;   // 智云 · 通用男声
const TENCENT_MALE_VOICE_NAMES = new Set([
  'Ethan', 'Ryan', 'Aiden', 'Vincent', 'Neil', 'Elias', 'Arthur', 'Alek', 'Andre',
  'Dylan', 'Marcus', 'Roy', 'Peter', 'Eric', 'Rocky', 'Kai', 'Li', 'Sunny',
  'Lenn', 'Emilien', 'Radio Gol', 'Leon', 'Xander', 'Oscar'
]);

export const ttsConfigSchema = z.object({
  provider: z.enum(['openai-compatible', 'aliyun-qwen', 'tencent-cloud']).optional().default('openai-compatible'),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  secretId: z.string().optional(),
  secretKey: z.string().optional(),
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
    const effectiveText = this.config.provider === 'tencent-cloud'
      ? truncateTencentTtsText(text)
      : text;
    const hash = buildCacheHash({
      endpoint: this.config.baseUrl ?? TENCENT_TTS_ENDPOINT,
      model: this.config.model,
      voice: this.config.voice,
      speed: this.config.speed,
      format: resolveTtsCacheHashFormat(this.config),
      text: effectiveText
    });

    const cached = getCachedFilePath(hash, resolveTtsCacheLookupFormats(this.config));
    if (cached) {
      return { filePath: cached, cached: true };
    }

    if ((this.config.provider ?? 'openai-compatible') === 'aliyun-qwen') {
      return this.synthesizeWithAliyunQwen(effectiveText, hash, opts);
    }

    if (this.config.provider === 'tencent-cloud') {
      return this.synthesizeWithTencentTts(effectiveText, hash, opts);
    }

    const baseUrl = this.config.baseUrl;
    const apiKey = this.config.apiKey;
    if (!baseUrl || !apiKey) {
      throw new TtsError('TTS request failed: missing baseUrl/apiKey for openai-compatible provider');
    }
    const resp = await fetch(`${baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
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
    const baseUrl = this.config.baseUrl;
    const apiKey = this.config.apiKey;
    if (!baseUrl || !apiKey) {
      throw new TtsError('TTS request failed: missing baseUrl/apiKey for aliyun-qwen provider');
    }
    const resp = await fetch(baseUrl, {
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

  private async synthesizeWithTencentTts(
    text: string,
    hash: string,
    opts: { signal?: AbortSignal }
  ): Promise<TtsResult> {
    const secretId = this.config.secretId;
    const secretKey = this.config.secretKey;
    if (!secretId || !secretKey) {
      throw new TtsError('TTS request failed: missing tencent-cloud secretId/secretKey');
    }

    const payload = {
      Text: text,
      SessionId: randomUUID(),
      VoiceType: resolveTencentVoiceType(this.config.voice),
      Codec: 'mp3',
      Speed: mapAliyunSpeedToTencent(this.config.speed),
      Volume: 5,
      EnableSubtitle: false,
      ModelType: 1
    };
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const { authorization } = signTencentTc3Request({
      secretId,
      secretKey,
      host: TENCENT_TTS_ENDPOINT.replace('https://', ''),
      service: TENCENT_TTS_SERVICE,
      timestamp,
      body
    });

    const resp = await fetch(`${TENCENT_TTS_ENDPOINT}/`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: TENCENT_TTS_ENDPOINT.replace('https://', ''),
        'X-TC-Action': TENCENT_TTS_ACTION,
        'X-TC-Version': TENCENT_TTS_VERSION,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Region': TENCENT_TTS_REGION
      },
      body,
      signal: opts.signal
    });

    if (!resp.ok) {
      throw new TtsError(`TTS request failed: ${resp.status} ${resp.statusText}`);
    }

    const payloadJson = (await resp.json()) as {
      Response?: { Error?: { Code?: string; Message?: string }; Audio?: string };
    };
    const error = payloadJson.Response?.Error;
    if (error?.Code) {
      throw new TtsError(`TTS request failed: ${error.Code} ${error.Message ?? ''}`);
    }
    const audioBase64 = payloadJson.Response?.Audio;
    if (!audioBase64) {
      throw new TtsError('TTS request failed: missing audio in response');
    }

    const filePath = saveToCache(hash, 'mp3', Buffer.from(audioBase64, 'base64'));
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
  if (config.provider === 'tencent-cloud') {
    return TENCENT_CACHE_HASH_FORMAT;
  }
  return config.format;
}

export function resolveTtsCacheLookupFormats(config: Pick<TtsConfig, 'provider' | 'format'>): string[] {
  if ((config.provider ?? 'openai-compatible') === 'aliyun-qwen') {
    return [...ALIYUN_CACHE_LOOKUP_FORMATS];
  }
  if (config.provider === 'tencent-cloud') {
    return [...TENCENT_CACHE_LOOKUP_FORMATS];
  }
  return [config.format];
}

export function resolvePreferredTtsAudioFormat(config: Pick<TtsConfig, 'provider' | 'format'>): string {
  if ((config.provider ?? 'openai-compatible') === 'aliyun-qwen') {
    return 'wav';
  }
  if (config.provider === 'tencent-cloud') {
    return 'mp3';
  }
  return config.format;
}

// 把 per-user 的 TTS 音色解析为腾讯云 1073 基础音色 VoiceType。
// 新格式直接存 VoiceType 字符串（TENCENT_TTS_VOICE_IDS，实测 1006/1011+ 无效）；
// 旧格式（阿里云音色名）按性别映射：男声 -> 1004 智云，其余 -> 1001 智瑜。
export function resolveTencentVoiceType(voice: string): number {
  const normalized = voice.trim();
  if (/^\d+$/.test(normalized)) {
    const parsed = Number.parseInt(normalized, 10);
    if ((TENCENT_TTS_VOICE_IDS as readonly string[]).includes(String(parsed))) return parsed;
    return TENCENT_BASIC_VOICE_FEMALE_DEFAULT;
  }
  if (TENCENT_MALE_VOICE_NAMES.has(normalized)) {
    return TENCENT_BASIC_VOICE_MALE_DEFAULT;
  }
  return TENCENT_BASIC_VOICE_FEMALE_DEFAULT;
}

// TextToVoice 中文最多 150 字；超长时按码点截断并告警（避免 151-220 字口播被接口拒绝）。
function truncateTencentTtsText(text: string): string {
  if (Array.from(text).length <= TENCENT_TTS_MAX_INPUT_CHARS) return text;
  const truncated = Array.from(text).slice(0, TENCENT_TTS_MAX_INPUT_CHARS).join('');
  getLogger().warn({
    originalChars: Array.from(text).length,
    truncatedChars: TENCENT_TTS_MAX_INPUT_CHARS
  }, 'Tencent TTS input truncated to 150 chars');
  return truncated;
}

// 阿里云语义 speed（1.0 = 正常语速）映射到腾讯云 1073 的 Speed（0 = 正常语速，范围 -2..2）
function mapAliyunSpeedToTencent(speed: number): number {
  const v = Math.round((speed - 1) * 2);
  return Math.max(-2, Math.min(2, v));
}

// Tencent Cloud TC3-HMAC-SHA256 签名（用于腾讯云 API 3.0）
export function signTencentTc3Request(opts: {
  secretId: string;
  secretKey: string;
  host: string;
  service: string;
  timestamp: number;
  body: string;
}): { authorization: string; date: string } {
  const { secretId, secretKey, host, service, timestamp, body } = opts;
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const hashedPayload = sha256Hex(body);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, 'tc3_request');
  const signature = hmacSha256(secretSigning, stringToSign).toString('hex');
  return {
    authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    date
  };
}

function hmacSha256(key: string | Buffer, msg: string): Buffer {
  return createHmac('sha256', key).update(msg).digest();
}

function sha256Hex(msg: string): string {
  return createHash('sha256').update(msg).digest('hex');
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
