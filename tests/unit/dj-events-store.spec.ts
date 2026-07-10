import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb, _resetDbForTest } from '../../src/server/store/db';
import { appendDjEvent, getRecentDjEvents, getRecentTrackSelectedEvent } from '../../src/server/store/dj-events';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-dj-events-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('dj events store', () => {
  it('appends and reads recent DJ events with generated correlation id', () => {
    const event = appendDjEvent({
      userId: 'user-1',
      type: 'track_selected',
      runId: 'run-1',
      trackId: 'track-1',
      payload: {
        trackId: 'track-1',
        trackName: 'Song',
        artist: 'Artist',
        selectionRationale: 'Fits the current low-distraction state.',
        batchRationale: 'Keep the next block steady.',
        source: 'liked',
        pickOrder: 1
      }
    });

    expect(event.correlationId).toBe(event.id);
    const recent = getRecentDjEvents('user-1');
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      id: event.id,
      userId: 'user-1',
      type: 'track_selected',
      runId: 'run-1',
      trackId: 'track-1'
    });
    expect(recent[0]?.payload).toMatchObject({
      selectionRationale: 'Fits the current low-distraction state.'
    });
  });

  it('rejects invalid payloads before writing', () => {
    expect(() => appendDjEvent({
      userId: 'user-1',
      type: 'personal_context_uploaded',
      payload: {
        contextId: 'ctx-1',
        uploadedAt: new Date().toISOString(),
        summaryPreview: 'ok',
        source: { kind: 'lifemesh_bundle' },
        unknown: true
      }
    })).toThrow();

    expect(getRecentDjEvents('user-1')).toEqual([]);
  });

  it('round-trips a strict selection_completed payload', () => {
    const event = appendDjEvent({
      userId: 'user-1',
      type: 'selection_completed',
      runId: 'run-1',
      payload: {
        finalTrackIds: ['track-1', 'track-2'],
        finalRationale: '本次实际补充 2 首：Artist 1《Song 1》、Artist 2《Song 2》。',
        proposedRationale: '模型原本建议接两首歌。',
        targetCount: 2,
        requestedPickCount: 3,
        appendedCount: 2,
        finalPickDiagnostics: {
          targetPickCount: 2,
          rawPickCount: 3,
          eligiblePickCount: 3,
          acceptedPickCount: 2,
          droppedPickCount: 1,
          titleMotifDroppedCount: 0,
          rankedBackfillCount: 1,
          rejectedPickCount: 0,
          semanticConflictDroppedCount: 0,
          qualityDroppedCount: 0,
          unassessedDroppedCount: 0,
          assessmentValidationFailureCount: 0
        },
        skippedPicks: [{
          id: 'track-3',
          name: 'Song 3',
          artist: 'Artist 3',
          dedupeKey: 'song 3::artist 3',
          reason: 'no_remaining_slots'
        }]
      }
    });

    expect(getRecentDjEvents('user-1')).toEqual([
      expect.objectContaining({
        id: event.id,
        type: 'selection_completed',
        payload: event.payload
      })
    ]);

    expect(() => appendDjEvent({
      userId: 'user-1',
      type: 'selection_completed',
      payload: {
        finalTrackIds: ['track-1'],
        finalRationale: '完成选择。',
        appendedCount: 1,
        skippedPicks: [],
        unknown: true
      }
    })).toThrow();
    expect(getRecentDjEvents('user-1')).toHaveLength(1);
  });

  it('finds the most recent track_selected event by user and track id', () => {
    appendDjEvent({
      userId: 'user-1',
      type: 'track_selected',
      trackId: 'track-1',
      createdAt: '2026-07-08T09:00:00.000Z',
      payload: {
        trackId: 'track-1',
        trackName: 'Older Song',
        selectionRationale: 'older rationale'
      }
    });
    const latest = appendDjEvent({
      userId: 'user-1',
      type: 'track_selected',
      runId: 'run-latest',
      trackId: 'track-1',
      createdAt: '2026-07-08T10:00:00.000Z',
      payload: {
        trackId: 'track-1',
        trackName: 'Latest Song',
        selectionRationale: 'latest rationale'
      }
    });
    appendDjEvent({
      userId: 'user-2',
      type: 'track_selected',
      trackId: 'track-1',
      createdAt: '2026-07-08T11:00:00.000Z',
      payload: {
        trackId: 'track-1',
        trackName: 'Other User Song',
        selectionRationale: 'other user'
      }
    });

    expect(getRecentTrackSelectedEvent('user-1', 'track-1')?.id).toBe(latest.id);
    expect(getRecentTrackSelectedEvent('user-1', 'missing')).toBeNull();
  });

  it('returns events with identical timestamps in reverse insertion order', () => {
    const createdAt = '2026-07-08T12:00:00.000Z';
    const first = appendDjEvent({
      userId: 'user-1',
      type: 'selection_started',
      createdAt,
      payload: { trigger: 'system' }
    });
    const second = appendDjEvent({
      userId: 'user-1',
      type: 'track_selected',
      createdAt,
      payload: {
        trackId: 'track-1',
        trackName: 'Song',
        selectionRationale: 'reason'
      }
    });
    const third = appendDjEvent({
      userId: 'user-1',
      type: 'queue_changed',
      createdAt,
      payload: { action: 'append', trackIds: ['track-1'] }
    });

    expect(getRecentDjEvents('user-1').map((event) => event.id)).toEqual([
      third.id,
      second.id,
      first.id
    ]);
  });
});
