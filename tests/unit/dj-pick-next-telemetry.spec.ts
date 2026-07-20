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
    expect(tracker.record({ path: 'music_agent_ranked_recovery' })).toMatchObject({
      totalRuns: 2,
      fallbackRuns: 1,
      fallbackRate: 0.5,
      fallbackPaths: { music_agent_ranked_recovery: 1 }
    });
    expect(tracker.record({ path: 'no_candidates' })).toMatchObject({
      totalRuns: 3,
      fallbackRuns: 2,
      fallbackRate: 0.667,
      fallbackPaths: {
        music_agent_ranked_recovery: 1,
        no_candidates: 1
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
      [
        { ncmId: 'new-1', name: 'New One' },
        { ncmId: 'new-2', name: 'New Two' }
      ],
      2,
      emit,
      'music_agent_success',
      {
        agentPickCount: 2,
        rankedBackfillCount: 0,
        candidateCount: 8,
        elapsedMs: 25,
        discoveryMode: 'explore'
      }
    );

    expect(emit).toHaveBeenNthCalledWith(1, {
      type: 'queue-updated',
      queue: [
        { ncmId: 'old', name: 'Existing Track' },
        { ncmId: 'new-1', name: 'New One' },
        { ncmId: 'new-2', name: 'New Two' }
      ],
      currentIndex: 0,
      revision: expect.any(Number),
    });
    expect(emit).toHaveBeenNthCalledWith(2, {
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
        fallbackPath: 'music_agent_success',
        discoveryMode: 'explore',
        fallbackStats: expect.objectContaining({ totalRuns: 1, fallbackRuns: 0 })
      }),
      'DJ pick-next: broadcast appended tracks'
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('new-1');
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('New One');
  });
});
