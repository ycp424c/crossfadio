import { getPref } from '../store/prefs.js';
import type { SecretStore } from '../security.js';
import type { TtsConfig } from './client.js';

export function resolveTtsConfig(secrets: SecretStore): TtsConfig | null {
  const stored = getPref<{
    baseUrl: string;
    model: string;
    voice: string;
    speed: number;
    format: string;
  }>('tts.config');
  if (!stored) return null;
  const apiKey = secrets.get('tts.apiKey');
  if (!apiKey) return null;
  return {
    baseUrl: stored.baseUrl,
    apiKey,
    model: stored.model,
    voice: stored.voice,
    speed: stored.speed,
    format: stored.format as TtsConfig['format']
  };
}
