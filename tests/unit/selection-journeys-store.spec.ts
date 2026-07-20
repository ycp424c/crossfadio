import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SelectionJourneySnapshot } from '../../src/shared/selection';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-selection-journeys-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  const { initDb } = await import('../../src/server/store/db.js');
  initDb();
});

afterEach(async () => {
  const { _resetDbForTest } = await import('../../src/server/store/db.js');
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

function snapshot(revision: number, updatedAt: string): SelectionJourneySnapshot {
  return {
    schemaVersion: 1,
    runId: 'run-store-1',
    journeyVersion: 1,
    revision,
    status: revision >= 2 ? 'completed' : 'running',
    summary: revision >= 2 ? '这一轮已经选好。' : '正在选歌。',
    startedAt: '2026-07-17T04:00:00.000Z',
    updatedAt,
    ...(revision >= 2 ? { completedAt: updatedAt } : {}),
    stages: [],
    candidates: [],
    selections: [],
    narration: { status: 'pending' }
  };
}

describe('Selection Journey store', () => {
  it('inserts and updates only newer revisions while duplicate delivery stays idempotent', async () => {
    const { saveSelectionJourney } = await import('../../src/server/store/selection-journeys.js');

    const first = saveSelectionJourney({
      userId: 'user-a',
      factsHash: 'facts-a',
      snapshot: snapshot(1, '2026-07-17T04:00:01.000Z')
    });
    const duplicate = saveSelectionJourney({
      userId: 'user-a',
      factsHash: 'facts-a',
      snapshot: snapshot(1, '2026-07-17T04:00:01.000Z')
    });
    const updated = saveSelectionJourney({
      userId: 'user-a',
      factsHash: 'facts-b',
      snapshot: snapshot(2, '2026-07-17T04:00:02.000Z')
    });
    const stale = saveSelectionJourney({
      userId: 'user-a',
      factsHash: 'facts-a',
      snapshot: snapshot(1, '2026-07-17T04:00:01.000Z')
    });

    expect(duplicate.id).toBe(first.id);
    expect(updated.id).toBe(first.id);
    expect(updated.snapshot.revision).toBe(2);
    expect(stale.snapshot.revision).toBe(2);
    expect(stale.factsHash).toBe('facts-b');
  });

  it('rejects conflicting content at the same revision', async () => {
    const { saveSelectionJourney } = await import('../../src/server/store/selection-journeys.js');
    saveSelectionJourney({
      userId: 'user-a',
      factsHash: 'facts-a',
      snapshot: snapshot(1, '2026-07-17T04:00:01.000Z')
    });

    expect(() => saveSelectionJourney({
      userId: 'user-a',
      factsHash: 'facts-other',
      snapshot: { ...snapshot(1, '2026-07-17T04:00:01.000Z'), summary: '另一份内容。' }
    })).toThrow(/conflicting journey revision/i);
  });

  it('lists 24-hour history by default and expires persistence after 30 days', async () => {
    const { cleanupSelectionJourneys, listRecentSelectionJourneys, saveSelectionJourney } = await import(
      '../../src/server/store/selection-journeys.js'
    );
    saveSelectionJourney({
      userId: 'user-a',
      factsHash: 'facts-a',
      snapshot: snapshot(1, '2026-07-17T04:00:01.000Z')
    });

    expect(listRecentSelectionJourneys('user-a', {
      now: '2026-07-18T03:59:59.000Z'
    })).toHaveLength(1);
    expect(listRecentSelectionJourneys('user-a', {
      now: '2026-07-18T04:00:02.000Z'
    })).toHaveLength(0);
    expect(cleanupSelectionJourneys('2026-08-16T04:00:02.000Z')).toBe(1);
  });

  it('orders and windows history by selection start while returning only the latest run version', async () => {
    const { listRecentSelectionJourneys, saveSelectionJourney } = await import(
      '../../src/server/store/selection-journeys.js'
    );
    const save = (
      runId: string,
      startedAt: string,
      updatedAt: string,
      journeyVersion = 1
    ) => saveSelectionJourney({
      userId: 'user-a',
      factsHash: `${runId}-${journeyVersion}`,
      snapshot: {
        ...snapshot(1, updatedAt),
        runId,
        journeyVersion,
        startedAt
      }
    });

    save('old-polished-late', '2026-07-16T03:00:00.000Z', '2026-07-17T03:59:59.000Z');
    save('current', '2026-07-17T03:00:00.000Z', '2026-07-17T03:00:01.000Z');
    save('current', '2026-07-17T03:00:00.000Z', '2026-07-17T03:00:02.000Z', 2);
    save('newest', '2026-07-17T03:30:00.000Z', '2026-07-17T03:30:01.000Z');

    const history = listRecentSelectionJourneys('user-a', {
      now: '2026-07-17T04:00:00.000Z'
    });
    expect(history.map((record) => [
      record.snapshot.runId,
      record.snapshot.journeyVersion
    ])).toEqual([
      ['newest', 1],
      ['current', 2]
    ]);
  });

  it('does not include a future-dated Journey in the recent history window', async () => {
    const { listRecentSelectionJourneys, saveSelectionJourney } = await import(
      '../../src/server/store/selection-journeys.js'
    );
    saveSelectionJourney({
      userId: 'user-a',
      factsHash: 'future-facts',
      snapshot: {
        ...snapshot(2, '2026-07-18T04:00:02.000Z'),
        runId: 'future-run',
        startedAt: '2026-07-18T04:00:01.000Z'
      }
    });

    expect(listRecentSelectionJourneys('user-a', {
      now: '2026-07-18T04:00:00.000Z'
    })).toEqual([]);
  });
});
