import { describe, expect, it } from 'vitest';
import type { SelectionJourneySnapshot } from '../../src/shared/selection';
import {
  applyPlayerSelectionJourneySnapshot,
  mergePlayerSelectionJourneyHistoryRestore,
  mergePlayerSelectionJourney,
  mergePlayerSelectionJourneyHistory,
  parsePlayerSelectionJourney,
  restorePlayerSelectionJourneyRecoverySnapshot
} from '../../src/renderer/playerSelectionJourney';

describe('player Selection Journey reducer', () => {
  it('accepts a valid snapshot and ignores duplicate or stale direct/SSE delivery', () => {
    const revision2 = snapshot(2);
    expect(parsePlayerSelectionJourney({ type: 'selection.journey', snapshot: revision2 })).toEqual(revision2);
    expect(mergePlayerSelectionJourney(null, revision2)).toEqual(revision2);
    expect(mergePlayerSelectionJourney(revision2, snapshot(2))).toBe(revision2);
    expect(mergePlayerSelectionJourney(revision2, snapshot(1))).toBe(revision2);
    expect(mergePlayerSelectionJourney(revision2, snapshot(3))).toEqual(snapshot(3));
  });

  it('accepts a newer run and rejects malformed public data', () => {
    const current = snapshot(4);
    const nextRun = { ...snapshot(0), runId: 'run-next', startedAt: '2026-07-17T04:01:00.000Z' };
    expect(mergePlayerSelectionJourney(current, nextRun)).toEqual(nextRun);
    expect(parsePlayerSelectionJourney({
      type: 'selection.journey',
      snapshot: { ...snapshot(1), summary: '', privatePrompt: 'secret' }
    })).toBeNull();
    expect(parsePlayerSelectionJourney({ type: 'other', snapshot: snapshot(1) })).toBeNull();
  });

  it('accepts a higher journey version for the same run even when startedAt is unchanged', () => {
    const current = snapshot(8);
    const nextVersion = { ...snapshot(0), journeyVersion: 2 };

    expect(mergePlayerSelectionJourney(current, nextVersion)).toEqual(nextVersion);
    expect(mergePlayerSelectionJourney(nextVersion, current)).toBe(nextVersion);
  });

  it('keeps recent runs and updates each run only with a newer version or revision', () => {
    const olderRun = {
      ...snapshot(2),
      runId: 'run-older',
      startedAt: '2026-07-17T03:00:00.000Z'
    };
    const currentRun = snapshot(2);
    const newerCurrentRevision = snapshot(3);
    const staleCurrentRevision = snapshot(1);

    let history = mergePlayerSelectionJourneyHistory([], olderRun);
    history = mergePlayerSelectionJourneyHistory(history, currentRun);
    history = mergePlayerSelectionJourneyHistory(history, newerCurrentRevision);
    history = mergePlayerSelectionJourneyHistory(history, staleCurrentRevision);

    expect(history.map((journey) => `${journey.runId}:${journey.revision}`)).toEqual([
      'run-player:3',
      'run-older:2'
    ]);
  });

  it('merges delayed history into live state without dropping or downgrading SSE snapshots', () => {
    const live = {
      ...snapshot(4),
      runId: 'run-live',
      startedAt: '2026-07-17T05:00:00.000Z'
    };
    const staleLive = { ...live, revision: 2 };
    const restored = mergePlayerSelectionJourneyHistoryRestore({
      journeys: [live],
      selectedRunId: live.runId
    }, [
      snapshot(3),
      staleLive
    ]);

    expect(restored.journeys.map((journey) => `${journey.runId}:${journey.revision}`)).toEqual([
      'run-live:4',
      'run-player:3'
    ]);
    expect(restored.selectedRunId).toBe('run-live');
  });

  it('replaces stale local history with the authoritative reconnect snapshot while preserving valid focus', () => {
    const retained = snapshot(3);
    const staleLocal = {
      ...snapshot(1),
      runId: 'run-expired',
      startedAt: '2026-07-16T01:00:00.000Z'
    };
    const recovered = restorePlayerSelectionJourneyRecoverySnapshot({
      journeys: [retained, staleLocal],
      selectedRunId: retained.runId
    }, [retained]);

    expect(recovered).toEqual({
      journeys: [retained],
      selectedRunId: retained.runId
    });
    expect(restorePlayerSelectionJourneyRecoverySnapshot({
      journeys: [staleLocal],
      selectedRunId: staleLocal.runId
    }, [retained]).selectedRunId).toBe(retained.runId);
  });

  it('does not let asynchronous narration for an existing unselected run steal history focus', () => {
    const latest = {
      ...snapshot(3),
      runId: 'run-latest',
      startedAt: '2026-07-17T05:00:00.000Z'
    };
    const older = {
      ...snapshot(1),
      runId: 'run-older',
      startedAt: '2026-07-17T03:00:00.000Z'
    };
    const polishedOlder = applyPlayerSelectionJourneySnapshot({
      journeys: [latest, older],
      selectedRunId: latest.runId
    }, {
      ...older,
      revision: 2,
      narration: { status: 'polished', text: '旧 run 的异步润色' }
    });

    expect(polishedOlder.selectedRunId).toBe('run-latest');
    expect(polishedOlder.journeys.find((journey) => journey.runId === older.runId)?.revision).toBe(2);
  });

  it('focuses a genuinely new latest run while preserving focus for ordinary run updates', () => {
    const current = snapshot(2);
    const updatedCurrent = applyPlayerSelectionJourneySnapshot({
      journeys: [current],
      selectedRunId: current.runId
    }, snapshot(3));
    expect(updatedCurrent.selectedRunId).toBe(current.runId);

    const newLatest = {
      ...snapshot(1),
      runId: 'run-new-latest',
      startedAt: '2026-07-17T05:00:00.000Z'
    };
    expect(applyPlayerSelectionJourneySnapshot(updatedCurrent, newLatest).selectedRunId)
      .toBe(newLatest.runId);
  });

});

function snapshot(revision: number): SelectionJourneySnapshot {
  return {
    schemaVersion: 1,
    runId: 'run-player',
    journeyVersion: 1,
    revision,
    status: 'running',
    summary: '正在选歌。',
    startedAt: '2026-07-17T04:00:00.000Z',
    updatedAt: `2026-07-17T04:00:0${Math.min(revision, 9)}.000Z`,
    stages: [],
    candidates: [],
    selections: [],
    narration: { status: 'pending' }
  };
}
