import { getPref } from '../store/prefs.js';
import type { SecretStore } from '../security.js';
import type { TtsConfig } from './client.js';

export const DEFAULT_TTS_CONFIG = {
  provider: 'aliyun-qwen',
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  model: 'qwen-tts',
  voice: 'Cherry',
  speed: 1,
  format: 'mp3'
} as const satisfies Omit<TtsConfig, 'apiKey'>;

export function resolveTtsConfig(secrets: SecretStore): TtsConfig | null {
  const stored = getPref<Partial<Omit<TtsConfig, 'apiKey'>>>('tts.config') ?? {};
  const apiKey = secrets.get('tts.apiKey');
  if (!apiKey) return null;
  const merged = { ...DEFAULT_TTS_CONFIG, ...stored, provider: stored.provider ?? inferProvider(stored) };
  return {
    provider: merged.provider,
    baseUrl: merged.baseUrl,
    apiKey,
    model: merged.model,
    voice: merged.voice,
    speed: merged.speed,
    format: merged.format as TtsConfig['format']
  };
}

function inferProvider(config: Partial<Omit<TtsConfig, 'apiKey'>>): TtsConfig['provider'] {
  if (!config.baseUrl && !config.model) {
    return DEFAULT_TTS_CONFIG.provider;
  }

  if (config.baseUrl?.includes('dashscope.aliyuncs.com') || config.model === DEFAULT_TTS_CONFIG.model) {
    return 'aliyun-qwen';
  }

  return 'openai-compatible';
}
