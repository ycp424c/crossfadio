import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SELECTION_ROTATION_HISTORY_PICK_LIMIT } from '../../src/shared/dj-memory';
import { _resetDbForTest, getDb, initDb } from '../../src/server/store/db';
import { appendDjEvent } from '../../src/server/store/dj-events';
import { runDataMigrations } from '../../src/server/store/migrations';
import {
  getSelectionRotationSnapshot,
  recordSelectionRotationExposure,
  recordSelectionRotationRound
} from '../../src/server/store/selection-rotation';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-selection-rotation-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('selection rotation persistence', () => {
  it('records manual exposure before the first autonomous round at logical round zero', () => {
    expect(recordSelectionRotationExposure({
      userId: 'user-0',
      runId: 'manual-before-auto',
      tracks: [{ id: '100', name: 'Manual First', artists: ['Manual Artist'] }]
    })).toEqual({ inserted: true, roundNumber: 0 });

    expect(getSelectionRotationSnapshot('user-0')).toMatchObject({
      currentRound: 0,
      picks: [
        expect.objectContaining({
          runId: 'manual-before-auto',
          roundNumber: 0,
          trackId: '100'
        })
      ]
    });
  });

  it('records a manual exposure at the current logical round without advancing it', () => {
    recordSelectionRotationRound({
      userId: 'user-1',
      runId: 'auto-run-1',
      tracks: [{ id: '101', name: 'Auto Song', artists: ['Auto Artist'] }]
    });

    expect(recordSelectionRotationExposure({
      userId: 'user-1',
      runId: 'manual-run',
      tracks: [{ id: '102', name: 'Manual Song', artists: ['Manual Artist'] }]
    })).toEqual({ inserted: true, roundNumber: 1 });

    expect(getSelectionRotationSnapshot('user-1')).toMatchObject({
      currentRound: 1,
      picks: expect.arrayContaining([
        expect.objectContaining({
          runId: 'manual-run',
          roundNumber: 1,
          trackId: '102',
          trackKey: 'manualsong::manualartist'
        })
      ])
    });
  });

  it('backfills committed auto rounds and chat exposures while ignoring failed runs', () => {
    appendSelectionRun({
      runId: 'auto-run',
      trigger: 'auto_fill',
      trackId: '201',
      trackName: 'Auto Song',
      artist: 'Auto Artist',
      committed: true
    });
    appendSelectionRun({
      runId: 'chat-run',
      trigger: 'chat_recommend',
      trackId: '202',
      trackName: 'Chat Song',
      artist: 'Chat Artist',
      committed: true
    });
    appendSelectionRun({
      runId: 'failed-run',
      trigger: 'auto_fill',
      trackId: '203',
      trackName: 'Failed Song',
      artist: 'Failed Artist',
      committed: false
    });

    const current = Number((getDb().prepare(
      `SELECT value FROM meta WHERE key = 'data_migration_version'`
    ).get() as { value: string }).value);
    getDb().prepare(
      `UPDATE meta SET value = ? WHERE key = 'data_migration_version'`
    ).run(String(current - 1));
    runDataMigrations(getDb());

    const snapshot = getSelectionRotationSnapshot('user-1');
    expect(snapshot).toMatchObject({
      currentRound: 1,
      picks: expect.arrayContaining([
        expect.objectContaining({
          runId: 'auto-run',
          roundNumber: 1,
          trackId: '201',
          trackKey: 'autosong::autoartist'
        }),
        expect.objectContaining({
          runId: 'chat-run',
          roundNumber: 1,
          trackId: '202',
          trackKey: 'chatsong::chatartist'
        })
      ])
    });
    expect(snapshot.picks.some((pick) => pick.runId === 'failed-run')).toBe(false);
  });

  it('advances once per committed autonomous selection run and preserves normalized pick identities', () => {
    expect(recordSelectionRotationRound({
      userId: 'user-1',
      runId: 'run-1',
      selectedAt: '2026-07-01T12:00:00.000Z',
      tracks: [
        { id: '101', name: 'First Song', artists: ['Lead Artist', 'Guest Artist'] },
        { id: '102', name: 'Second Song', artists: ['Other Artist'] }
      ]
    })).toEqual({ inserted: true, roundNumber: 1 });

    expect(recordSelectionRotationRound({
      userId: 'user-1',
      runId: 'run-1',
      selectedAt: '2026-07-08T12:00:00.000Z',
      tracks: [{ id: '999', name: 'Retry Must Not Count', artists: ['Retry Artist'] }]
    })).toEqual({ inserted: false, roundNumber: 1 });

    expect(recordSelectionRotationRound({
      userId: 'user-1',
      runId: 'run-2',
      selectedAt: '2026-09-01T12:00:00.000Z',
      tracks: [{ id: '103', name: 'Third Song', artists: ['Third Artist'] }]
    })).toEqual({ inserted: true, roundNumber: 2 });

    expect(getSelectionRotationSnapshot('user-1')).toEqual({
      currentRound: 2,
      picks: [
        expect.objectContaining({
          runId: 'run-2',
          roundNumber: 2,
          trackId: '103',
          trackKey: 'thirdsong::thirdartist',
          artistKeys: ['third artist']
        }),
        expect.objectContaining({
          runId: 'run-1',
          roundNumber: 1,
          trackId: '101',
          trackKey: 'firstsong::leadartist',
          artistKeys: ['lead artist', 'guest artist']
        }),
        expect.objectContaining({
          runId: 'run-1',
          roundNumber: 1,
          trackId: '102',
          trackKey: 'secondsong::otherartist',
          artistKeys: ['other artist']
        })
      ]
    });
  });

  it('bounds same-round manual exposure history by pick count', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO selection_rotation_runs (
        user_id, run_id, round_number, advances_round, selected_at, track_count
      ) VALUES (?, ?, 0, 0, ?, ?)
    `).run(
      'bounded-user',
      'bulk-manual',
      '2026-07-01T00:00:00.000Z',
      SELECTION_ROTATION_HISTORY_PICK_LIMIT
    );
    const insertPick = db.prepare(`
      INSERT INTO selection_rotation_picks (
        user_id, run_id, round_number, pick_order, track_id, track_name,
        artist_display, track_key, artist_keys_json, selected_at
      ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (let index = 1; index <= SELECTION_ROTATION_HISTORY_PICK_LIMIT; index += 1) {
        insertPick.run(
          'bounded-user',
          'bulk-manual',
          index,
          `old-${index}`,
          `Old Song ${index}`,
          'Old Artist',
          `oldsong${index}::oldartist`,
          JSON.stringify(['old artist']),
          '2026-07-01T00:00:00.000Z'
        );
      }
    }).immediate();

    recordSelectionRotationExposure({
      userId: 'bounded-user',
      runId: 'newest-manual',
      selectedAt: '2026-07-02T00:00:00.000Z',
      tracks: [{ id: 'newest', name: 'Newest Song', artists: ['Newest Artist'] }]
    });

    const snapshot = getSelectionRotationSnapshot('bounded-user');
    expect(snapshot.picks).toHaveLength(SELECTION_ROTATION_HISTORY_PICK_LIMIT);
    expect(snapshot.picks[0]).toMatchObject({
      runId: 'newest-manual',
      trackId: 'newest'
    });
    expect(snapshot.picks.some((pick) => pick.trackId === 'old-4000')).toBe(false);
    expect((db.prepare(`
      SELECT COUNT(*) AS count
      FROM selection_rotation_picks
      WHERE user_id = ?
    `).get('bounded-user') as { count: number }).count)
      .toBe(SELECTION_ROTATION_HISTORY_PICK_LIMIT);
  });
});

function appendSelectionRun(input: {
  runId: string;
  trigger: 'auto_fill' | 'chat_recommend';
  trackId: string;
  trackName: string;
  artist: string;
  committed: boolean;
}): void {
  const started = appendDjEvent({
    userId: 'user-1',
    type: 'selection_started',
    runId: input.runId,
    correlationId: input.runId,
    createdAt: '2026-07-01T12:00:00.000Z',
    payload: { trigger: input.trigger, targetCount: 1 }
  });
  const selected = appendDjEvent({
    userId: 'user-1',
    type: 'track_selected',
    runId: input.runId,
    correlationId: input.runId,
    causationEventId: started.id,
    trackId: input.trackId,
    createdAt: '2026-07-01T12:00:01.000Z',
    payload: {
      trackId: input.trackId,
      trackName: input.trackName,
      artist: input.artist,
      selectionRationale: 'selected',
      pickOrder: 1
    }
  });
  if (!input.committed) return;
  appendDjEvent({
    userId: 'user-1',
    type: 'queue_changed',
    runId: input.runId,
    correlationId: input.runId,
    causationEventId: selected.id,
    createdAt: '2026-07-01T12:00:02.000Z',
    payload: {
      action: 'append',
      trackIds: [input.trackId],
      position: 'end',
      afterQueuePreview: []
    }
  });
}
