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
  const speed = DEFAULT_TTS_CONFIG.speed;

  if (config.tts.provider === 'tencent-cloud') {
    return {
      provider: 'tencent-cloud',
      secretId: config.tts.secretId ?? undefined,
      secretKey: config.tts.secretKey ?? undefined,
      model: 'TextToVoice',
      voice,
      speed,
      format: 'mp3'
    };
  }

  if (config.tts.provider === 'openai-compatible') {
    return {
      provider: 'openai-compatible',
      baseUrl: config.tts.baseUrl ?? undefined,
      apiKey: config.tts.apiKey ?? undefined,
      model: DEFAULT_TTS_MODEL,
      voice,
      speed,
      format: 'mp3'
    };
  }

  // aliyun-qwen：pref 可能残留腾讯 VoiceType 数字 id，检测到数字格式时回退默认，避免把无效音色发给 Qwen。
  const aliyunVoice = /^\d+$/.test(voice)
    ? config.tts.voiceDefault || DEFAULT_TTS_VOICE
    : voice;
  return {
    provider: 'aliyun-qwen',
    baseUrl: config.tts.baseUrl ?? undefined,
    apiKey: config.tts.apiKey ?? undefined,
    model: DEFAULT_TTS_MODEL,
    voice: aliyunVoice,
    speed,
    format: 'mp3'
  };
}
