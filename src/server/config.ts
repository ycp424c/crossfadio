export type ServerConfig = {
  jwtSecret: string;
  jwtTtlDays: number;
  llm: { baseUrl: string; apiKey: string; model: string };
  tts: { baseUrl: string; apiKey: string; voiceDefault: string | null };
  embedding: { baseUrl: string; apiKey: string; model: string; dimensions: number } | null;
  host: string;
  allowedOrigins: string[];
  adminNcmId: string | null;
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
    tts: {
      baseUrl: required('CROSSFADIO_TTS_BASE_URL'),
      apiKey: required('CROSSFADIO_TTS_API_KEY'),
      voiceDefault: process.env.CROSSFADIO_TTS_VOICE_DEFAULT?.trim() || null
    },
    embedding: resolveEmbeddingConfig(),
    host: process.env.CROSSFADIO_HOST?.trim() || '127.0.0.1',
    allowedOrigins: (process.env.CROSSFADIO_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    adminNcmId: process.env.CROSSFADIO_ADMIN_NCM_ID?.trim() || null
  };

  return _config;
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
    dimensions: resolvePositiveInt(process.env.CROSSFADIO_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_DIMENSIONS)
  };
}

function resolvePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
