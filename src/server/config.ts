import { lyricsSelectionModeSchema, type LyricsSelectionMode } from './music-agent/track-understanding.js';

export type TtsProvider = 'aliyun-qwen' | 'openai-compatible' | 'tencent-cloud';

export type ServerConfig = {
  jwtSecret: string;
  jwtTtlDays: number;
  llm: { baseUrl: string; apiKey: string; model: string };
  tts: {
    provider: TtsProvider;
    baseUrl: string | null;
    apiKey: string | null;
    secretId: string | null;
    secretKey: string | null;
    voiceDefault: string | null;
    model: string | null;
  };
  embedding: { baseUrl: string; apiKey: string; model: string; dimensions: number; sendDimensions: boolean } | null;
  host: string;
  allowedOrigins: string[];
  adminNcmId: string | null;
  lyricsSelectionMode: LyricsSelectionMode;
};

const DEFAULT_EMBEDDING_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-v4';
const DEFAULT_EMBEDDING_DIMENSIONS = 1024;

let _config: ServerConfig | null = null;

export function loadConfig(): ServerConfig {
  const required = (name: string): string => {
    const val = process.env[name]?.trim();
    if (!val) throw new Error(`Missing required environment variable: ${name}`);
    return val;
  };

  _config = {
    jwtSecret: required('CROSSFADIO_JWT_SECRET'),
    jwtTtlDays: Math.max(1, Number(process.env.CROSSFADIO_JWT_TTL_DAYS ?? '7') || 7),
    llm: {
      baseUrl: required('CROSSFADIO_LLM_BASE_URL'),
      apiKey: required('CROSSFADIO_LLM_API_KEY'),
      model: required('CROSSFADIO_LLM_MODEL')
    },
    tts: resolveTtsServerConfig(),
    embedding: resolveEmbeddingConfig(),
    host: process.env.CROSSFADIO_HOST?.trim() || '127.0.0.1',
    allowedOrigins: (process.env.CROSSFADIO_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    adminNcmId: process.env.CROSSFADIO_ADMIN_NCM_ID?.trim() || null,
    lyricsSelectionMode: resolveLyricsSelectionMode(process.env.CROSSFADIO_LYRICS_SELECTION_MODE)
  };

  return _config;
}

function resolveLyricsSelectionMode(value: string | undefined): LyricsSelectionMode {
  const parsed = lyricsSelectionModeSchema.safeParse(value?.trim());
  return parsed.success ? parsed.data : 'off';
}

function resolveTtsServerConfig(): ServerConfig['tts'] {
  const rawProvider = process.env.CROSSFADIO_TTS_PROVIDER?.trim() || 'aliyun-qwen';
  if (rawProvider !== 'aliyun-qwen' && rawProvider !== 'openai-compatible' && rawProvider !== 'tencent-cloud') {
    throw new Error(`Invalid CROSSFADIO_TTS_PROVIDER: ${rawProvider} (expected aliyun-qwen | openai-compatible | tencent-cloud)`);
  }
  const provider = rawProvider as TtsProvider;
  const baseUrl = process.env.CROSSFADIO_TTS_BASE_URL?.trim() || null;
  const apiKey = process.env.CROSSFADIO_TTS_API_KEY?.trim() || null;
  const secretId = process.env.CROSSFADIO_TTS_SECRET_ID?.trim() || null;
  const secretKey = process.env.CROSSFADIO_TTS_SECRET_KEY?.trim() || null;
  const voiceDefault = process.env.CROSSFADIO_TTS_VOICE_DEFAULT?.trim() || null;
  const model = process.env.CROSSFADIO_TTS_MODEL?.trim() || null;

  if (provider === 'tencent-cloud') {
    if (!secretId || !secretKey) {
      throw new Error('Missing required environment variable: CROSSFADIO_TTS_SECRET_ID / CROSSFADIO_TTS_SECRET_KEY (provider=tencent-cloud)');
    }
  } else {
    if (!baseUrl || !apiKey) {
      throw new Error(`Missing required environment variable: CROSSFADIO_TTS_BASE_URL / CROSSFADIO_TTS_API_KEY (provider=${provider})`);
    }
    if (provider === 'openai-compatible' && (!model || !voiceDefault)) {
      throw new Error('Missing required environment variable: CROSSFADIO_TTS_MODEL / CROSSFADIO_TTS_VOICE_DEFAULT (provider=openai-compatible)');
    }
  }

  return {
    provider,
    baseUrl,
    apiKey,
    secretId,
    secretKey,
    voiceDefault,
    // 非腾讯 provider 的 TTS 模型名：openai-compatible 可指向任意兼容端点模型（如 gpt-4o-mini-tts），
    // aliyun-qwen 需为 DashScope TTS 模型；缺省时由调用方回退到 DEFAULT_TTS_MODEL。
    model
  };
}

export function getConfig(): ServerConfig {
  if (!_config) return loadConfig();
  return _config;
}

export function resetConfigForTest(): void {
  _config = null;
}

function resolveEmbeddingConfig(): ServerConfig['embedding'] {
  const apiKey = process.env.CROSSFADIO_EMBEDDING_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    baseUrl: process.env.CROSSFADIO_EMBEDDING_BASE_URL?.trim() || DEFAULT_EMBEDDING_BASE_URL,
    apiKey,
    model: process.env.CROSSFADIO_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL,
    dimensions: resolvePositiveInt(process.env.CROSSFADIO_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_DIMENSIONS),
    sendDimensions: (process.env.CROSSFADIO_EMBEDDING_SEND_DIMENSIONS?.trim() ?? '1') !== '0'
  };
}

function resolvePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
