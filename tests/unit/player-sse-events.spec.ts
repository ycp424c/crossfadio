import { describe, expect, it } from 'vitest';
import {
  parsePlayerPersistentSseEvent,
  parsePlayerPickNextSseEvent,
  queueTrackFromSsePayload
} from '../../src/renderer/playerSseEvents';

describe('player SSE event parsing', () => {
  it('adapts persistent queue-updated payloads from server ncmId tracks to UI queue tracks', () => {
    const parsed = parsePlayerPersistentSseEvent('queue-updated', {
      queue: [
        { ncmId: 101, name: 'First', artists: ['A'], durationMs: 123_000, coverImgUrl: 'cover.jpg' },
        { name: 'invalid without id' },
        { id: 'ui-2', name: 'Second', artists: ['B', 12], durationMs: 'bad' }
      ],
      currentIndex: 1
    });

    expect(parsed).toEqual({
      type: 'queue-updated',
      queue: [
        { id: '101', name: 'First', artists: ['A'], durationMs: 123_000, coverImgUrl: 'cover.jpg' },
        { id: 'ui-2', name: 'Second', artists: ['B'], durationMs: 0, coverImgUrl: null }
      ],
      currentIndex: 1,
      data: expect.any(Object)
    });
  });

  it('parses queue-appended events and ignores malformed tracks', () => {
    expect(parsePlayerPersistentSseEvent('queue-appended', {
      track: { ncmId: 'ncm-1', name: 'Appended' }
    })).toMatchObject({
      type: 'queue-appended',
      track: { id: 'ncm-1', name: 'Appended', artists: [], durationMs: 0, coverImgUrl: null }
    });

    expect(parsePlayerPickNextSseEvent('queue-appended', { track: { name: 'missing id' } })).toBeNull();
    expect(queueTrackFromSsePayload('not-an-object')).toBeNull();
  });

  it('parses pick-next debug and completion events into typed player events', () => {
    const debug = parsePlayerPickNextSseEvent('dj.debug', {
      excludedIds: ['1', 2, '3'],
      excludedDedupeKeys: ['a'],
      candidateScoreTable: [
        { rank: 1, id: '11', song: 'Song', artist: 'Artist', sources: 'semantic', adjustedScore: 4.2 }
      ]
    });
    expect(debug).toMatchObject({
      type: 'dj.debug',
      excludedIds: ['1', '3'],
      excludedDedupeKeys: ['a'],
      candidateScoreTable: [{ rank: 1, id: '11', song: 'Song', artist: 'Artist', sources: 'semantic', adjustedScore: 4.2 }]
    });

    expect(parsePlayerPickNextSseEvent('dj.pick-next.done', {
      added: false,
      reason: 'already-running'
    })).toMatchObject({
      type: 'dj.pick-next.done',
      added: false,
      reason: 'already-running'
    });
  });

  it('returns null for unknown or non-object player SSE payloads', () => {
    expect(parsePlayerPersistentSseEvent('connected', { userId: 'u1' })).toBeNull();
    expect(parsePlayerPersistentSseEvent('queue-updated', 'bad')).toBeNull();
    expect(parsePlayerPickNextSseEvent('dj.pick-next.done', null)).toBeNull();
  });
});
