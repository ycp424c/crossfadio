import { describe, expect, it } from 'vitest';
import { createPickReasonCache } from '../../src/server/dj/pick-reason-cache.js';

describe('DJ pick reason cache', () => {
  it('expires a reason after its short retention window', () => {
    let now = 1_000;
    const cache = createPickReasonCache({
      ttlMs: 100,
      maxEntries: 10,
      now: () => now
    });

    cache.set('user-a', 'track-a', 'reason-a');
    expect(cache.get('user-a', 'track-a')).toBe('reason-a');

    now = 1_100;
    expect(cache.get('user-a', 'track-a')).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('keeps a hard capacity and evicts the least recently used reason', () => {
    const cache = createPickReasonCache({
      ttlMs: 1_000,
      maxEntries: 2,
      now: () => 1_000
    });
    cache.set('user', 'track-a', 'reason-a');
    cache.set('user', 'track-b', 'reason-b');
    expect(cache.get('user', 'track-a')).toBe('reason-a');

    cache.set('user', 'track-c', 'reason-c');

    expect(cache.get('user', 'track-b')).toBeNull();
    expect(cache.get('user', 'track-a')).toBe('reason-a');
    expect(cache.get('user', 'track-c')).toBe('reason-c');
    expect(cache.size()).toBe(2);
  });
});
