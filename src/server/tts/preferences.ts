import type { TtsProvider } from '../config.js';
import { getPref, setPref } from '../store/prefs.js';

const LEGACY_TTS_VOICE_PREF_KEY = 'tts.voice';

export function getTtsVoicePreference(userId: string, provider: TtsProvider): string | null {
  return readVoicePreference(userId, ttsVoicePreferenceKey(provider))
    ?? readVoicePreference(userId, LEGACY_TTS_VOICE_PREF_KEY);
}

export function setTtsVoicePreference(userId: string, provider: TtsProvider, voice: string): void {
  setPref(userId, ttsVoicePreferenceKey(provider), voice.trim());
}

export function ttsVoicePreferenceKey(provider: TtsProvider): string {
  return `tts.voice.${provider}`;
}

function readVoicePreference(userId: string, key: string): string | null {
  const value = getPref<unknown>(userId, key);
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}
