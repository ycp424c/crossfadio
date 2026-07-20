export type ListeningSignalInput = {
  outcome: 'completed' | 'skipped' | 'failed' | 'interrupted';
  listenedMs: number;
  positionMs: number;
  durationMs: number | null;
  legacyExposureOverride?: number | null;
};

export type ListeningSignals = {
  exposure: number;
  earlySkip: boolean;
};

export function deriveListeningSignals(input: ListeningSignalInput): ListeningSignals {
  const durationMs = validPositiveNumber(input.durationMs) ? input.durationMs : null;
  const listenedMs = nonNegativeFinite(input.listenedMs);
  const positionMs = nonNegativeFinite(input.positionMs);
  const exposure = input.outcome === 'completed'
    ? 1
    : durationMs === null
      ? Math.min(0.5, listenedMs / 240_000)
      : Math.min(1, listenedMs / durationMs);

  return {
    exposure: clamp01(input.legacyExposureOverride ?? exposure),
    earlySkip: input.legacyExposureOverride == null &&
      input.outcome === 'skipped' &&
      durationMs !== null &&
      positionMs < durationMs / 2
  };
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function validPositiveNumber(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
