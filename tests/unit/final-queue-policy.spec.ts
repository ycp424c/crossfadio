import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateFinalQueuePick,
  evaluateFinalQueuePickWithContext
} from '../../src/server/music-agent/final-queue-policy';
import { _resetDbForTest, initDb } from '../../src/server/store/db';
import { createExplicitExclusion } from '../../src/server/store/explicit-exclusions';
import { setQueueState } from '../../src/server/store/queue';
import { recordSelectionRotationRound } from '../../src/server/store/selection-rotation';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-final-policy-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
  setQueueState('user-1', [], 0);
});

afterEach(() => {
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('live final queue policy', () => {
  it('re-reads durable rotation history before mutating the queue', () => {
    recordSelectionRotationRound({
      userId: 'user-1',
      runId: 'previous-run',
      tracks: [{ id: 'recent', name: 'Recent Song', artists: ['Recent Artist'] }]
    });

    expect(evaluateFinalQueuePick({
      userId: 'user-1',
      mode: 'autonomous',
      runId: 'next-run',
      pick: {
        id: 'recent',
        name: 'Recent Song',
        artist: 'Recent Artist',
        source: 'search',
        reason: 'LLM selected it'
      }
    })).toMatchObject({
      action: 'reject',
      reasonCodes: ['rotation_final_rejection']
    });
  });

  it('preserves exact band identities containing comma and ampersand', () => {
    createExplicitExclusion({
      userId: 'user-1', entityType: 'artist', entityKey: 'Earth, Wind & Fire',
      sourceKind: 'listener_instruction', sourceRef: { messageId: 1 }
    });

    expect(evaluateFinalQueuePick({
      userId: 'user-1', mode: 'autonomous', runId: 'run-band',
      pick: { id: '1', name: 'September', artist: 'Earth, Wind & Fire', source: 'search', reason: 'fit' }
    })).toMatchObject({ action: 'reject', reasonCodes: ['explicit_artist_exclusion'] });
    expect(evaluateFinalQueuePick({
      userId: 'user-1', mode: 'autonomous',
      pick: { id: '2', name: 'Planet Song', artist: 'Earth', source: 'search', reason: 'fit' }
    })).toMatchObject({ action: 'select', reasonCodes: ['final_eligible'] });
  });

  it('returns the live idempotency context together with the authoritative decision', () => {
    const evaluation = evaluateFinalQueuePickWithContext({
      userId: 'user-1',
      mode: 'autonomous',
      runId: 'run-idempotent',
      playedTrackIds: new Set(['already-played']),
      pick: {
        id: 'already-played',
        name: 'Played Song',
        artist: 'Played Artist',
        source: 'search',
        reason: 'fit'
      }
    });

    expect(evaluation).toMatchObject({
      decision: {
        phase: 'final',
        action: 'reject',
        reasonCodes: ['played_track_idempotency']
      },
      replayContext: {
        explicitTrackExcluded: false,
        queueContainsTrack: false,
        playedTrack: true
      }
    });
  });
});
