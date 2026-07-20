import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionJourneySnapshot } from '../../src/shared/selection';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-journey-routes-'));
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

describe('Selection Journey history route', () => {
  it('returns only the authenticated user history and caps the requested limit', async () => {
    const { saveSelectionJourney } = await import('../../src/server/store/selection-journeys.js');
    const { createListSelectionJourneysHandler } = await import(
      '../../src/server/http/routes/selection-journeys.js'
    );
    saveSelectionJourney({ userId: 'user-a', factsHash: 'a', snapshot: snapshot('run-a') });
    saveSelectionJourney({ userId: 'user-b', factsHash: 'b', snapshot: snapshot('run-b') });

    const req = {
      userId: 'user-a',
      query: { limit: '999' }
    } as unknown as Request;
    const res = {
      json: vi.fn()
    } as unknown as Response;
    createListSelectionJourneysHandler({
      now: () => new Date('2026-07-17T05:00:00.000Z')
    })(req, res);

    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      journeys: [expect.objectContaining({ runId: 'run-a' })]
    });
  });

  it('rejects an invalid limit instead of coercing ambiguous input', async () => {
    const { createListSelectionJourneysHandler } = await import(
      '../../src/server/http/routes/selection-journeys.js'
    );
    const req = { userId: 'user-a', query: { limit: 'nope' } } as unknown as Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    } as unknown as Response;
    createListSelectionJourneysHandler()(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ ok: false, error: 'invalid query' });
  });
});

function snapshot(runId: string): SelectionJourneySnapshot {
  return {
    schemaVersion: 1,
    runId,
    journeyVersion: 1,
    revision: 1,
    status: 'completed',
    summary: '这一轮已经选好。',
    startedAt: '2026-07-17T04:00:00.000Z',
    updatedAt: '2026-07-17T04:00:01.000Z',
    completedAt: '2026-07-17T04:00:01.000Z',
    stages: [],
    candidates: [],
    selections: [],
    narration: { status: 'pending' }
  };
}
