import { getConfig, type TtsProvider } from '../config.js';
import { DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, QWEN3_TTS_VOICES, TENCENT_TTS_VOICE_IDS } from '../../shared/tts.js';
import { resolveTencentVoiceType } from './client.js';
import type { TtsConfig } from './client.js';
import { getTtsVoicePreference } from './preferences.js';

export { DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from '../../shared/tts.js';

export const DEFAULT_TTS_CONFIG = {
  provider: 'aliyun-qwen',
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  model: DEFAULT_TTS_MODEL,
  voice: DEFAULT_TTS_VOICE,
  speed: 1,
  format: 'mp3'
} as const satisfies Omit<TtsConfig, 'apiKey'>;

// 腾讯云默认音色 id（智瑜 · 情感女声），用于 tencent-cloud 模式下 pref 缺失/非法时的展示兜底。
export const TENCENT_DEFAULT_VOICE_ID = TENCENT_TTS_VOICE_IDS[0] ?? '1001';

export function resolveTtsConfig(userId: string): TtsConfig {
  const config = getConfig();
  const userVoice = getTtsVoicePreference(userId, config.tts.provider);
  const voice = userVoice || config.tts.voiceDefault || DEFAULT_TTS_VOICE;
  const fallbackVoice = config.tts.voiceDefault || DEFAULT_TTS_VOICE;
  const speed = DEFAULT_TTS_CONFIG.speed;
  const model = config.tts.model || DEFAULT_TTS_MODEL;

  if (config.tts.provider === 'tencent-cloud') {
    return {
      provider: 'tencent-cloud',
      secretId: config.tts.secretId ?? undefined,
      secretKey: config.tts.secretKey ?? undefined,
      model: 'TextToVoice',
      // 旧格式音色名（如 Ethan/Cherry）由 resolveTencentVoiceType 按性别映射，此处原样透传；
      // 数字但非法的值同样在合成时兜底。
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
      model,
      // pref 可能残留腾讯 VoiceType 数字 id，按当前 provider 归一化后发出。
      voice: sanitizeNonTencentVoice(voice, config.tts.provider, fallbackVoice),
      speed,
      format: 'mp3'
    };
  }

  // aliyun-qwen：同样归一化，非法音色（腾讯数字 id、OpenAI 旧音色名）回退到合法 Qwen 音色。
  return {
    provider: 'aliyun-qwen',
    baseUrl: config.tts.baseUrl ?? undefined,
    apiKey: config.tts.apiKey ?? undefined,
    model,
    voice: sanitizeNonTencentVoice(voice, config.tts.provider, fallbackVoice),
    speed,
    format: 'mp3'
  };
}

// 解析"该 provider 下应展示/使用的有效音色"：
// tencent 复用合成端的同一套 legacy 映射（Ethan 等男声 -> 1004，其余 -> 1001），
// 保证 GET 展示、PUT 校验与合成 VoiceType 一致；其他 provider 按各自 allowlist 归一化。
export function resolveEffectiveVoiceForProvider(
  voice: string,
  provider: TtsProvider,
  fallbackVoice: string
): string {
  if (provider === 'tencent-cloud') {
    return String(resolveTencentVoiceType(voice));
  }
  return sanitizeNonTencentVoice(voice, provider, fallbackVoice);
}

// 非腾讯 provider 的音色归一化：
// - aliyun-qwen：音色必须在 Qwen 音色表内，否则回退到合法的 Qwen 音色（fallback 自身非法时用默认）；
// - openai-compatible：自由音色名原样保留，仅清理腾讯数字 id 残留（fallback 自身也不能是数字）。
function sanitizeNonTencentVoice(voice: string, provider: TtsProvider, fallbackVoice: string): string {
  if (provider === 'aliyun-qwen') {
    if ((QWEN3_TTS_VOICES as readonly string[]).includes(voice)) return voice;
    return (QWEN3_TTS_VOICES as readonly string[]).includes(fallbackVoice)
      ? fallbackVoice
      : DEFAULT_TTS_VOICE;
  }
  if (/^\d+$/.test(voice)) {
    return /^\d+$/.test(fallbackVoice) ? DEFAULT_TTS_VOICE : fallbackVoice;
  }
  return voice;
}
