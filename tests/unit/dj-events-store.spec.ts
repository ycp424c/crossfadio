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
});
