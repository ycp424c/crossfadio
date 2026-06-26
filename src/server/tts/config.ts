import { getConfig } from '../config.js';
import { getPref } from '../store/prefs.js';
import { DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from '../../shared/tts.js';
import type { TtsConfig } from './client.js';

export { DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from '../../shared/tts.js';

export const DEFAULT_TTS_CONFIG = {
  provider: 'aliyun-qwen',
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  model: DEFAULT_TTS_MODEL,
  voice: DEFAULT_TTS_VOICE,
  speed: 1,
  format: 'mp3'
} as const satisfies Omit<TtsConfig, 'apiKey'>;

export function resolveTtsConfig(userId: string): TtsConfig {
  const config = getConfig();
  const userVoice = getPref<string>(userId, 'tts.voice');
  const voice = userVoice || config.tts.voiceDefault || DEFAULT_TTS_VOICE;
  return {
    provider: 'aliyun-qwen',
    baseUrl: config.tts.baseUrl,
    apiKey: config.tts.apiKey,
    model: DEFAULT_TTS_CONFIG.model,
    voice,
    speed: DEFAULT_TTS_CONFIG.speed,
    format: DEFAULT_TTS_CONFIG.format
  };
}
