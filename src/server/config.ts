export type ServerConfig = {
  jwtSecret: string;
  jwtTtlDays: number;
  llm: { baseUrl: string; apiKey: string; model: string };
  tts: { baseUrl: string; apiKey: string; voiceDefault: string | null };
  host: string;
  allowedOrigins: string[];
};

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
    host: process.env.CROSSFADIO_HOST?.trim() || '127.0.0.1',
    allowedOrigins: (process.env.CROSSFADIO_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
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
