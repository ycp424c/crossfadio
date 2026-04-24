import { describe, expect, it } from 'vitest';
import { buildFallbackPlan } from '../../src/server/agent/plan-fallback';
import type { PlaylistEntry } from '../../src/server/user-corpus/loader';

const basePlaylist: PlaylistEntry = {
  id: 'pl1',
  name: 'Test Playlist',
  segments: ['morning'],
  tags: ['calm', 'indie'],
  priority: 1,
  energyRange: [0.3, 0.6]
};

describe('buildFallbackPlan', () => {
  it('returns a plan with 4 segments for given date', () => {
    const plan = buildFallbackPlan('2024-01-01', []);
    expect(plan.mode).toBe('plan');
    expect(plan.date).toBe('2024-01-01');
    expect(plan.segments).toHaveLength(4);
  });

  it('uses generic fallback track when no playlists available', () => {
    const plan = buildFallbackPlan('2024-01-01', []);
    for (const seg of plan.segments) {
      expect(seg.tracks).toHaveLength(1);
      expect(seg.tracks[0].query).not.toContain('playlist:');
    }
  });

  it('picks best matching playlist for segment', () => {
    const plan = buildFallbackPlan('2024-01-01', [basePlaylist]);
    const morning = plan.segments.find((s) => s.id === 'morning')!;
    expect(morning.tracks[0].query).toBe('playlist:pl1');
  });

  it('scores by tag overlap when segment id does not match', () => {
    const workPlaylist: PlaylistEntry = {
      id: 'pl-work',
      name: 'Focus',
      segments: [],
      tags: ['focus', 'instrumental', 'lofi'],
      priority: 1
    };
    const plan = buildFallbackPlan('2024-01-01', [workPlaylist]);
    const work = plan.segments.find((s) => s.id === 'work')!;
    expect(work.tracks[0].query).toBe('playlist:pl-work');
  });

  it('handles 0-100 scale energyRange', () => {
    const pl: PlaylistEntry = {
      id: 'pl-100',
      name: 'Wide',
      segments: ['morning'],
      tags: [],
      priority: 1,
      energyRange: [30, 60]
    };
    const plan = buildFallbackPlan('2024-01-01', [pl]);
    const morning = plan.segments.find((s) => s.id === 'morning')!;
    expect(morning.tracks[0].query).toBe('playlist:pl-100');
  });
});
