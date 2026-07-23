import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MusicCandidate } from '../../src/server/music-agent/schema';
import {
  buildSelectionPolicyReplayCases,
  type SelectionPolicyReplayContext
} from '../../src/server/music-agent/selection-policy/replay-case';
import { _resetDbForTest, getDb, initDb } from '../../src/server/store/db';
import {
  finalizeSelectionPolicyReplayCases,
  recordSelectionPolicyReplayCases
} from '../../src/server/store/selection-replay';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-selection-replay-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  initDb();
});

afterEach(() => {
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('selection replay persistence', () => {
  it('captures logical rotation distance so hard-window decisions can be replayed', () => {
    const track = candidate('rotation');
    const cases = buildSelectionPolicyReplayCases({
      candidates: [track],
      context: {
        mode: 'autonomous',
        explicitlyRequested: false,
        rotation: {
          currentRound: 20,
          tracks: [{
            trackKey: 'songrotation::artistrotation',
            lastSelectedRound: 15,
            selectionsInWindow: 2
          }]
        }
      },
      batchLimit: 1,
      pressureForCandidate: () => [{
        source: 'rotation',
        reasonCode: 'rotation_track_suppression',
        direction: 'penalty',
        amount: 1,
        severity: 'suppress',
        evidence: {
          currentRound: 20,
          lastSelectedRound: 15,
          roundDistance: 5,
          hardRounds: 12,
          softRounds: 40,
          selectionsInWindow: 2
        }
      }]
    });

    expect(cases[0]).toMatchObject({
      context: {
        rotationCurrentRound: 20,
        rotationLastSelectedRound: 15,
        rotationRoundDistance: 5,
        rotationSelectionsInWindow: 2,
        rotationSuppressed: true
      },
      pressure: [{
        reasonCode: 'rotation_track_suppression',
        roundDistance: 5,
        selectionsInWindow: 2
      }],
      expected: {
        recall: {
          action: 'suppress',
          reasonCodes: ['rotation_track_suppression']
        }
      }
    });
  });

  it('keeps early-phase context and writes only the last replayable live Final evaluation', () => {
    const initialContext = { mode: 'autonomous' as const, explicitlyRequested: false };
    const cases = buildSelectionPolicyReplayCases({
      candidates: [candidate('one'), candidate('two'), candidate('three')],
      context: initialContext,
      batchLimit: 2
    });
    recordSelectionPolicyReplayCases({
      userId: 'user-1',
      runId: 'run-1',
      mode: 'autonomous',
      cases
    });

    finalizeSelectionPolicyReplayCases({
      userId: 'user-1',
      runId: 'run-1',
      decisions: [
        {
          candidateId: 'one',
          decision: { phase: 'final', action: 'select', reasonCodes: ['final_eligible'] },
          replayContext: replayContext()
        },
        {
          candidateId: 'one',
          decision: { phase: 'final', action: 'reject', reasonCodes: ['explicit_track_exclusion'] },
          replayContext: replayContext({ explicitTrackExcluded: true })
        },
        {
          candidateId: 'two',
          decision: { phase: 'final', action: 'reject', reasonCodes: ['played_track_idempotency'] },
          replayContext: replayContext({ playedTrack: true })
        },
        {
          candidateId: 'three',
          decision: { phase: 'final', action: 'reject', reasonCodes: ['queue_target_reached'] }
        }
      ]
    });

    const rows = getDb().prepare(`
      SELECT candidate_id AS candidateId, context_json AS contextJson,
             expected_json AS expectedJson
      FROM selection_policy_replay_cases
      WHERE user_id = ? AND run_id = ?
      ORDER BY candidate_id
    `).all('user-1', 'run-1') as Array<{
      candidateId: string;
      contextJson: string;
      expectedJson: string;
    }>;
    const byCandidate = new Map(rows.map((row) => [row.candidateId, {
      context: JSON.parse(row.contextJson),
      expected: JSON.parse(row.expectedJson)
    }]));

    expect(byCandidate.get('one')).toMatchObject({
      context: { explicitTrackExcluded: false },
      expected: {
        admission: { action: 'admit' },
        final: { action: 'reject', reasonCodes: ['explicit_track_exclusion'] },
        finalContext: { explicitTrackExcluded: true }
      }
    });
    expect(byCandidate.get('two')).toMatchObject({
      context: { playedTrack: false },
      expected: {
        final: { action: 'reject', reasonCodes: ['played_track_idempotency'] },
        finalContext: { playedTrack: true }
      }
    });
    expect(byCandidate.get('three')).toMatchObject({
      expected: { final: null, finalContext: null }
    });
  });
});

function candidate(id: string): MusicCandidate {
  return {
    id,
    name: `Song ${id}`,
    artist: `Artist ${id}`,
    sources: ['search'],
    evidence: [],
    scores: {
      intentMatch: 0.5,
      tasteMatch: 0.5,
      timeFit: 0.5,
      contextFit: 0.5,
      novelty: 0.5,
      sourceConfidence: 0.5
    }
  };
}

function replayContext(
  overrides: Partial<SelectionPolicyReplayContext> = {}
): SelectionPolicyReplayContext {
  return {
    explicitlyRequested: false,
    explicitTrackExcluded: false,
    explicitArtistExcluded: false,
    temporaryTrackExcluded: false,
    temporaryArtistExcluded: false,
    retrievalCooldown: false,
    queueContainsTrack: false,
    playedTrack: false,
    rotationCurrentRound: 0,
    rotationLastSelectedRound: null,
    rotationRoundDistance: null,
    rotationSelectionsInWindow: 0,
    rotationSuppressed: false,
    ...overrides
  };
}
