import { describe, expect, it } from 'vitest';
import { buildPlaybackTimeline } from '../../src/renderer/audio/timeline';

describe('buildPlaybackTimeline', () => {
  it('maps playback timing to ordered readonly timeline events', () => {
    const timeline = buildPlaybackTimeline(180, {
      positionSec: 170,
      timing: { prefetchLeadSec: 10, segueLeadSec: 12, crossfadeSec: 8 },
      duckingHintSec: 6
    });

    expect(timeline.progressPct).toBeCloseTo(94.44, 2);
    expect(timeline.events.map((event) => event.id)).toEqual(['segue', 'prefetch', 'crossfade']);
    expect(timeline.events.map((event) => event.atSec)).toEqual([168, 170, 172]);
    expect(timeline.ranges).toEqual([
      {
        id: 'ducking',
        label: 'TTS ducking',
        startSec: 168,
        endSec: 174,
        startPct: 93.33333333333333,
        widthPct: 3.3333333333333335
      },
      {
        id: 'crossfade',
        label: 'Crossfade',
        startSec: 172,
        endSec: 180,
        startPct: 95.55555555555556,
        widthPct: 4.444444444444445
      }
    ]);
  });

  it('keeps short-track percentages inside timeline bounds', () => {
    const timeline = buildPlaybackTimeline(5, {
      positionSec: 9,
      timing: { prefetchLeadSec: 10, segueLeadSec: 12, crossfadeSec: 8 },
      duckingHintSec: 8
    });

    expect(timeline.progressPct).toBe(100);
    expect(timeline.events.every((event) => event.pct >= 0 && event.pct <= 100)).toBe(true);
    expect(timeline.ranges.every((range) => range.startPct >= 0 && range.startPct + range.widthPct <= 100)).toBe(true);
  });
});
