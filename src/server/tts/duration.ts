const MIN_SPEECH_SEC = 2;
const MAX_SPEECH_SEC = 45;
const CJK_CHARS_PER_SEC = 4.2;
const LATIN_WORDS_PER_SEC = 2.7;
const PUNCTUATION_PAUSE_SEC = 0.15;
const BASE_OVERHEAD_SEC = 0.35;

export function estimateTtsDurationSec(text: string, speed = 1): number {
  const normalized = normalizeText(text);
  if (!normalized) {
    return MIN_SPEECH_SEC;
  }

  const cjkChars = countMatches(normalized, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const latinWords = countMatches(normalized, /[A-Za-z0-9]+/g);
  const punctuation = countMatches(normalized, /[，。！？、；：,.!?;:]/g);

  const estimated =
    cjkChars / CJK_CHARS_PER_SEC +
    latinWords / LATIN_WORDS_PER_SEC +
    punctuation * PUNCTUATION_PAUSE_SEC +
    BASE_OVERHEAD_SEC;

  const speedFactor = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const adjusted = estimated / speedFactor;
  return clamp(adjusted, MIN_SPEECH_SEC, MAX_SPEECH_SEC);
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
