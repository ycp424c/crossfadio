import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDbForTest, getDb, initDb } from '../../src/server/store/db';
import { createListeningEpisode } from '../../src/server/store/listening-episodes';
import { appendDjEvent } from '../../src/server/store/dj-events';
import { appendRetrievalAttempts } from '../../src/server/store/retrieval-attempts';
import { savePreferenceEvidence } from '../../src/server/store/preference-evidence';
import { saveSelectionJourney } from '../../src/server/store/selection-journeys';
import {
  runRetentionMaintenance,
  startRetentionMaintenance
} from '../../src/server/maintenance/retention';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-retention-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  _resetDbForTest();
  initDb();
});

afterEach(() => {
  vi.useRealTimers();
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.CROSSFADIO_DATA_DIR;
});

describe('unified retention maintenance', () => {
  it('applies every retention window from one entry point', () => {
    const now = new Date('2026-07-17T12:00:00.000Z');
    createEpisode('episode-expired', new Date(now.getTime() - 91 * day));
    createEpisode('episode-stale', new Date(now.getTime() - 25 * hour));

    getDb().prepare(`
      INSERT INTO personal_dj_contexts (
        id, user_id, payload_json, payload_hash, source_kind, uploaded_at,
        generated_at, expires_at
      ) VALUES ('context-old', 'user-1', '{}', 'hash', 'test', ?, ?, ?)
    `).run(
      new Date(now.getTime() - 2 * day).toISOString(),
      new Date(now.getTime() - 2 * day).toISOString(),
      new Date(now.getTime() - day).toISOString()
    );
    appendDjEvent({
      userId: 'user-1', type: 'selection_started',
      payload: { trigger: 'system' },
      createdAt: new Date(now.getTime() - 31 * day).toISOString()
    });
    saveSelectionJourney({
      userId: 'user-1',
      factsHash: 'facts-old',
      snapshot: {
        schemaVersion: 1, runId: 'run-old', journeyVersion: 1, revision: 1,
        status: 'completed', summary: '完成',
        startedAt: new Date(now.getTime() - 31 * day).toISOString(),
        updatedAt: new Date(now.getTime() - 31 * day).toISOString(),
        completedAt: new Date(now.getTime() - 31 * day).toISOString(),
        stages: [], candidates: [], selections: [], narration: { status: 'pending' }
      }
    });
    appendRetrievalAttempts({
      userId: 'user-1', runId: 'run-old', requestKind: 'autonomous',
      attemptedAt: new Date(now.getTime() - 31 * day),
      entries: [{
        source: 'ncm_search', query: 'city pop', normalizedQuery: 'city pop',
        searchedCount: 1, resultCount: 1, addedCount: 0, selectedCount: 0
      }]
    });
    getDb().prepare(`
      INSERT INTO selection_debug_traces (
        id, user_id, run_id, schema_version, trace_json, created_at, expires_at
      ) VALUES ('trace-old', 'user-1', 'run-old', 1, '{}', ?, ?)
    `).run(
      new Date(now.getTime() - 8 * day).toISOString(),
      new Date(now.getTime() - day).toISOString()
    );
    savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'inferred', subjectType: 'track',
      subjectKey: 'expired-track', polarity: 'negative', strength: 'weak', confidence: 0.5,
      sourceKind: 'early_skip', sourceRefs: [{ episodeId: 'episode-expired' }],
      observedAt: new Date(now.getTime() - 61 * day).toISOString()
    });
    savePreferenceEvidence({
      userId: 'user-1', evidenceKind: 'expressed', subjectType: 'track',
      subjectKey: 'kept-track', polarity: 'negative', strength: 'strong', confidence: 1,
      sourceKind: 'listener_instruction', sourceRefs: [{ sourceId: 'message-1' }],
      observedAt: new Date(now.getTime() - 61 * day).toISOString(),
      expiresAt: new Date(now.getTime() - day).toISOString()
    });

    expect(runRetentionMaintenance(now)).toEqual(expect.objectContaining({
      expiredEpisodes: 1,
      staleEpisodes: 1,
      personalDjContexts: 1,
      djEvents: 1,
      selectionJourneys: 1,
      retrievalAttempts: 1,
      debugTraces: 1,
      inferredPreferenceEvidence: 1
    }));
    expect(count('listening_episodes')).toBe(1);
    expect(getDb().prepare(`SELECT outcome FROM listening_episodes`).get()).toEqual({ outcome: 'interrupted' });
    expect(count('personal_dj_contexts')).toBe(0);
    expect(count('dj_events')).toBe(0);
    expect(count('selection_journeys')).toBe(0);
    expect(count('retrieval_attempts')).toBe(0);
    expect(count('selection_debug_traces')).toBe(0);
    expect(getDb().prepare(`SELECT evidence_kind FROM preference_evidence`).all()).toEqual([
      { evidence_kind: 'expressed' }
    ]);
  });

  it('runs immediately, repeats, unrefs its timer and stops cleanly', () => {
    const run = vi.fn();
    const unref = vi.fn();
    let tick: (() => void) | undefined;
    const timer = { unref } as unknown as NodeJS.Timeout;
    const schedule = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
      tick = callback as () => void;
      return timer;
    });
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const maintenance = startRetentionMaintenance({ run, intervalMs: 1_000 });

    expect(run).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalled();
    tick?.();
    expect(run).toHaveBeenCalledTimes(2);
    maintenance.stop();
    expect(clear).toHaveBeenCalledWith(timer);
    schedule.mockRestore();
    clear.mockRestore();
  });
});

const hour = 60 * 60 * 1_000;
const day = 24 * hour;

function createEpisode(id: string, startedAt: Date): void {
  createListeningEpisode('user-1', id, {
    playerInstanceId: 'player-1', deckId: 'main',
    track: { id: `track-${id}`, name: id, artists: ['artist'] },
    durationMs: 180_000, checkpointSeq: 0
  }, { now: startedAt });
}

function count(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}
