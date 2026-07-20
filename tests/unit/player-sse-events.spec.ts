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
      revision: null,
      data: expect.any(Object)
    });
  });

  it('rejects removed per-track queue events and ignores malformed tracks', () => {
    expect(parsePlayerPersistentSseEvent('queue-appended', {
      track: { ncmId: 'ncm-1', name: 'Appended' }
    })).toBeNull();

    expect(parsePlayerPickNextSseEvent('queue-appended', { track: { name: 'missing id' } })).toBeNull();
    expect(queueTrackFromSsePayload('not-an-object')).toBeNull();
  });

  it('parses pick-next debug and completion events into typed player events', () => {
    const debug = parsePlayerPickNextSseEvent('dj.debug', {
      excludedIds: ['1', 2, '3'],
      excludedDedupeKeys: ['a'],
      candidateScoreTable: [
        { rank: 1, id: '11', song: 'Song', artist: 'Artist', sources: 'semantic', adjustedScore: 4.2 }
      ],
      selectionTrace: {
        schemaVersion: 1,
        runId: 'run-1',
        mode: 'autonomous',
        createdAt: '2026-07-17T10:00:00.000Z',
        decisions: [{
          stage: 'final', action: 'selected', reasonCode: 'final_eligible',
          candidateId: '11', provenance: { source: 'playback_eligibility' }, evidenceRefs: []
        }]
      }
    });
    expect(debug).toMatchObject({
      type: 'dj.debug',
      excludedIds: ['1', '3'],
      excludedDedupeKeys: ['a'],
      candidateScoreTable: [{ rank: 1, id: '11', song: 'Song', artist: 'Artist', sources: 'semantic', adjustedScore: 4.2 }],
      selectionTrace: expect.objectContaining({ runId: 'run-1', schemaVersion: 1 })
    });

    expect(parsePlayerPickNextSseEvent('dj.debug', {
      selectionTrace: { schemaVersion: 999 }
    })).toMatchObject({ type: 'dj.debug', selectionTrace: null });

    expect(parsePlayerPickNextSseEvent('dj.pick-next.done', {
      added: false,
      reason: 'already-running'
    })).toMatchObject({
      type: 'dj.pick-next.done',
      added: false,
      reason: 'already-running'
    });
  });

  it('parses a connected recovery snapshot and rejects unknown or non-object payloads', () => {
    expect(parsePlayerPersistentSseEvent('connected', {
      userId: 'u1',
      queue: [{ ncmId: 'recovered', name: 'Recovered' }],
      currentIndex: 0,
      revision: 4,
      journeys: [journeySnapshot()]
    })).toMatchObject({
      type: 'connected',
      queue: [{ id: 'recovered', name: 'Recovered' }],
      currentIndex: 0,
      revision: 4,
      journeys: [{ runId: 'run-sse' }]
    });
    expect(parsePlayerPersistentSseEvent('unknown', { userId: 'u1' })).toBeNull();
    expect(parsePlayerPersistentSseEvent('queue-updated', 'bad')).toBeNull();
    expect(parsePlayerPickNextSseEvent('dj.pick-next.done', null)).toBeNull();
  });

  it('parses the shared Selection Journey event for persistent and direct streams', () => {
    const snapshot = journeySnapshot();
    expect(parsePlayerPersistentSseEvent('selection.journey', {
      type: 'selection.journey', snapshot
    })).toMatchObject({ type: 'selection.journey', snapshot });
    expect(parsePlayerPickNextSseEvent('selection.journey', {
      type: 'selection.journey', snapshot
    })).toMatchObject({ type: 'selection.journey', snapshot });
  });
});

function journeySnapshot() {
  return {
    schemaVersion: 1,
    runId: 'run-sse',
    journeyVersion: 1,
    revision: 1,
    status: 'running',
    summary: '正在选歌。',
    startedAt: '2026-07-17T04:00:00.000Z',
    updatedAt: '2026-07-17T04:00:01.000Z',
    stages: [],
    candidates: [],
    selections: [],
    narration: { status: 'pending' }
  };
}
