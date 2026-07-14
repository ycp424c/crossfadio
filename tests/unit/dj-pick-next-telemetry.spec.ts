import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDjPickNextFallbackStatsTracker,
  createDjPickNextTelemetry
} from '../../src/server/dj/pickNextTelemetry';
import { setQueueState } from '../../src/server/store/queue';

describe('DJ pick-next telemetry', () => {
  beforeEach(() => {
    setQueueState('telemetry-user', [], 0);
  });

  it('tracks fallback rate by fallback path while treating success paths as non-fallback', () => {
    const tracker = createDjPickNextFallbackStatsTracker();

    expect(tracker.record({ path: 'music_agent_success' })).toMatchObject({
      totalRuns: 1,
      fallbackRuns: 0,
      fallbackRate: 0,
      fallbackPaths: {}
    });
    expect(tracker.record({ path: 'music_agent_safety_block' })).toMatchObject({
      totalRuns: 2,
      fallbackRuns: 0,
      fallbackRate: 0,
      fallbackPaths: {}
    });
    expect(tracker.record({ path: 'music_agent_ranked_fallback' })).toMatchObject({
      totalRuns: 3,
      fallbackRuns: 1,
      fallbackRate: 0.333,
      fallbackPaths: { music_agent_ranked_fallback: 1 }
    });
    expect(tracker.record({ path: 'legacy_random_fallback' })).toMatchObject({
      totalRuns: 4,
      fallbackRuns: 2,
      fallbackRate: 0.5,
      fallbackPaths: {
        music_agent_ranked_fallback: 1,
        legacy_random_fallback: 1
      }
    });
  });

  it('broadcasts appended queue tracks, done event, and structured diagnostics', () => {
    const logger = { info: vi.fn() };
    const telemetry = createDjPickNextTelemetry({ logger });
    const emit = vi.fn();
    setQueueState('telemetry-user', [
      { ncmId: 'old', name: 'Existing Track' },
      { ncmId: 'new-1', name: 'New One' },
      { ncmId: 'new-2', name: 'New Two' }
    ], 0);

    telemetry.broadcastAppended(
      'telemetry-user',
      1,
      2,
      emit,
      'legacy_llm_success',
      {
        agentPickCount: 2,
        rankedBackfillCount: 0,
        candidateCount: 8,
        elapsedMs: 25,
        discoveryMode: 'explore'
      }
    );

    expect(emit).toHaveBeenNthCalledWith(1, {
      type: 'queue-appended',
      track: { ncmId: 'new-1', name: 'New One' }
    });
    expect(emit).toHaveBeenNthCalledWith(2, {
      type: 'queue-appended',
      track: { ncmId: 'new-2', name: 'New Two' }
    });
    expect(emit).toHaveBeenNthCalledWith(3, {
      type: 'dj.pick-next.done',
      added: true,
      addedCount: 2,
      targetCount: 2,
      trackIds: ['new-1', 'new-2'],
      trackNames: ['New One', 'New Two'],
      trackName: 'New One、New Two',
      elapsedMs: 25
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        targetCount: 2,
        appendedCount: 2,
        agentPickCount: 2,
        rankedBackfillCount: 0,
        candidateCount: 8,
        elapsedMs: 25,
        fallbackPath: 'legacy_llm_success',
        discoveryMode: 'explore',
        trackIds: ['new-1', 'new-2'],
        trackNames: ['New One', 'New Two'],
        fallbackStats: expect.objectContaining({ totalRuns: 1, fallbackRuns: 0 })
      }),
      'DJ pick-next: broadcast appended tracks'
    );
  });
});
