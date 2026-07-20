import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDbForTest, initDb } from '../../src/server/store/db.js';
import {
  deleteExpiredSelectionDebugTraces,
  getSelectionDebugTrace,
  saveSelectionDebugTrace
} from '../../src/server/store/selection-debug-traces.js';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-selection-trace-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('selection debug trace store', () => {
  it('stores the full validated trace for exactly seven days with user isolation', () => {
    const saved = saveSelectionDebugTrace({
      userId: 'user-1',
      trace: trace('run-1'),
      createdAt: new Date('2026-07-17T10:00:00.000Z')
    });

    expect(saved).toMatchObject({
      userId: 'user-1', runId: 'run-1', schemaVersion: 1,
      createdAt: '2026-07-17T10:00:00.000Z',
      expiresAt: '2026-07-24T10:00:00.000Z'
    });
    expect(getSelectionDebugTrace('user-1', 'run-1', {
      now: new Date('2026-07-24T09:59:59.999Z')
    })).toEqual(saved);
    expect(getSelectionDebugTrace('user-2', 'run-1')).toBeNull();
    expect(getSelectionDebugTrace('user-1', 'run-1', {
      now: new Date('2026-07-24T10:00:00.000Z')
    })).toBeNull();
  });

  it('upserts one trace per user, run, and schema version', () => {
    saveSelectionDebugTrace({ userId: 'user-1', trace: trace('run-1') });
    const updated = saveSelectionDebugTrace({
      userId: 'user-1',
      trace: {
        ...trace('run-1'),
        decisions: [{
          stage: 'final', action: 'selected', reasonCode: 'final_eligible',
          candidateId: 'track-1', provenance: { source: 'playback_eligibility' }, evidenceRefs: []
        }]
      },
      createdAt: new Date('2026-07-17T11:00:00.000Z')
    });

    expect(updated.trace.decisions).toHaveLength(1);
    expect(getSelectionDebugTrace('user-1', 'run-1')?.id).toBe(updated.id);
  });

  it('deletes expired rows and rejects malformed full traces', () => {
    saveSelectionDebugTrace({
      userId: 'user-1', trace: trace('expired'), createdAt: new Date('2026-07-01T00:00:00.000Z')
    });
    saveSelectionDebugTrace({
      userId: 'user-1', trace: trace('active'), createdAt: new Date('2026-07-17T00:00:00.000Z')
    });

    expect(deleteExpiredSelectionDebugTraces(new Date('2026-07-17T00:00:00.000Z'))).toBe(1);
    expect(getSelectionDebugTrace('user-1', 'expired')).toBeNull();
    expect(getSelectionDebugTrace('user-1', 'active')).not.toBeNull();
    expect(() => saveSelectionDebugTrace({
      userId: 'user-1', trace: { ...trace('bad'), schemaVersion: 999 } as never
    })).toThrow();
  });
});

function trace(runId: string) {
  return {
    schemaVersion: 1 as const,
    runId,
    mode: 'autonomous' as const,
    createdAt: '2026-07-17T10:00:00.000Z',
    decisions: []
  };
}
