import { describe, expect, it } from 'vitest';
import { deriveListeningSignals } from '../../src/server/listening/listening-signals.js';

describe('Listening Episode signals', () => {
  it('treats only a manual skip before the midpoint as Early Skip', () => {
    expect(deriveListeningSignals({
      outcome: 'skipped',
      listenedMs: 49_900,
      positionMs: 49_900,
      durationMs: 100_000
    })).toEqual({ exposure: 0.499, earlySkip: true });

    expect(deriveListeningSignals({
      outcome: 'skipped',
      listenedMs: 50_000,
      positionMs: 50_000,
      durationMs: 100_000
    })).toEqual({ exposure: 0.5, earlySkip: false });
  });

  it('keeps conservative Exposure without inferring Early Skip when duration is unknown', () => {
    expect(deriveListeningSignals({
      outcome: 'skipped',
      listenedMs: 60_000,
      positionMs: 10_000,
      durationMs: null
    })).toEqual({ exposure: 0.25, earlySkip: false });

    expect(deriveListeningSignals({
      outcome: 'failed',
      listenedMs: 180_000,
      positionMs: 1_000,
      durationMs: null
    })).toEqual({ exposure: 0.5, earlySkip: false });
  });

  it('uses the migration override without inventing negative feedback', () => {
    expect(deriveListeningSignals({
      outcome: 'skipped',
      listenedMs: 0,
      positionMs: 0,
      durationMs: 100_000,
      legacyExposureOverride: 0.25
    })).toEqual({ exposure: 0.25, earlySkip: false });
  });
});
