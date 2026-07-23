import { describe, expect, it } from 'vitest';
import {
  calculateSelectionPressure,
  EARLY_SKIP_ARTIST_SUPPRESSION_THRESHOLD,
  EARLY_SKIP_TRACK_SUPPRESSION_THRESHOLD,
  SELECTION_ROTATION_TRACK_HARD_ROUNDS
} from '../../src/server/music-agent/selection-pressure.js';
import { evaluateRecall } from '../../src/server/music-agent/selection-policy/recall.js';
import type {
  SelectionPolicyCandidate,
  SelectionPolicyContext
} from '../../src/server/music-agent/selection-policy/types.js';
import type { MusicCandidate } from '../../src/server/music-agent/schema.js';

const NOW = new Date('2026-07-17T12:00:00.000Z');

describe('selection pressure', () => {
  it('suppresses an autonomously selected track until twelve successful rotation rounds have passed', () => {
    const result = calculateSelectionPressure({
      candidate: candidate('same-track', 'Lead Artist'),
      now: new Date('2027-07-17T12:00:00.000Z'),
      rotation: {
        currentRound: 20,
        lastSelectedRound: 20 - SELECTION_ROTATION_TRACK_HARD_ROUNDS + 1,
        selectionsInWindow: 1
      }
    });

    expect(result.contributions).toContainEqual(expect.objectContaining({
      source: 'rotation',
      reasonCode: 'rotation_track_suppression',
      severity: 'suppress',
      evidence: expect.objectContaining({ roundDistance: SELECTION_ROTATION_TRACK_HARD_ROUNDS - 1 })
    }));
    expect(evaluateRecall({
      candidate: candidate('same-track', 'Lead Artist'),
      context: policyContext('autonomous'),
      pressure: result.contributions
    })).toMatchObject({
      action: 'suppress',
      reasonCodes: ['rotation_track_suppression']
    });
    expect(evaluateRecall({
      candidate: candidate('same-track', 'Lead Artist'),
      context: policyContext('explicit_request'),
      pressure: result.contributions
    })).toMatchObject({
      action: 'include',
      reasonCodes: ['explicit_request_soft_bypass']
    });
  });

  it('keeps a decaying rotation penalty from round twelve through round forty', () => {
    const atHardBoundary = calculateSelectionPressure({
      candidate: candidate('same-track', 'Lead Artist'),
      now: NOW,
      rotation: {
        currentRound: 20,
        lastSelectedRound: 8,
        selectionsInWindow: 1
      }
    });
    const afterSoftWindow = calculateSelectionPressure({
      candidate: candidate('same-track', 'Lead Artist'),
      now: NOW,
      rotation: {
        currentRound: 48,
        lastSelectedRound: 8,
        selectionsInWindow: 1
      }
    });

    expect(atHardBoundary.contributions).toContainEqual(expect.objectContaining({
      source: 'rotation',
      reasonCode: 'rotation_track_penalty',
      severity: 'soft',
      amount: expect.any(Number),
      evidence: expect.objectContaining({ roundDistance: 12, softRounds: 40 })
    }));
    expect(atHardBoundary.contributions.find((item) =>
      item.reasonCode === 'rotation_track_penalty'
    )?.amount).toBeGreaterThan(0.25);
    expect(afterSoftWindow.contributions.map((item) => item.reasonCode))
      .not.toContain('rotation_track_penalty');
  });

  it('adds rolling frequency pressure when a track appeared more than once in the soft window', () => {
    const result = calculateSelectionPressure({
      candidate: candidate('same-track', 'Lead Artist'),
      now: NOW,
      rotation: {
        currentRound: 40,
        lastSelectedRound: 20,
        selectionsInWindow: 3
      }
    });

    expect(result.contributions).toContainEqual(expect.objectContaining({
      source: 'rotation',
      reasonCode: 'rotation_frequency_penalty',
      direction: 'penalty',
      amount: 0.2,
      severity: 'soft',
      evidence: expect.objectContaining({ selectionsInWindow: 3 })
    }));
  });

  it('applies queue pressure only to tracks after currentIndex', () => {
    const currentArtist = calculateSelectionPressure({
      candidate: candidate('candidate-current', 'Current Artist'),
      now: NOW,
      queue: {
        currentIndex: 1,
        tracks: [
          queueTrack('past', 'Past Artist'),
          queueTrack('current', 'Current Artist'),
          queueTrack('upcoming', 'Upcoming Artist')
        ]
      }
    });
    const upcomingArtist = calculateSelectionPressure({
      candidate: candidate('candidate-upcoming', 'Upcoming Artist'),
      now: NOW,
      queue: {
        currentIndex: 1,
        tracks: [
          queueTrack('past', 'Past Artist'),
          queueTrack('current', 'Current Artist'),
          queueTrack('upcoming', 'Upcoming Artist')
        ]
      }
    });

    expect(currentArtist.contributions.map((item) => item.reasonCode)).not.toContain('upcoming_queue_artist');
    expect(upcomingArtist.contributions.map((item) => item.reasonCode)).toContain('upcoming_queue_artist');
  });

  it('turns the first fresh track early-skip into soft pressure plus a 24h temporary exclusion', () => {
    const result = calculateSelectionPressure({
      candidate: candidate('same-track', 'Lead Artist'),
      now: NOW,
      earlySkips: [earlySkip('same-track', 'Lead Artist', hoursAgo(1))]
    });

    expect(result.earlySkip.trackEffectiveCount).toBeGreaterThan(0);
    expect(result.earlySkip.trackEffectiveCount).toBeLessThan(EARLY_SKIP_TRACK_SUPPRESSION_THRESHOLD);
    expect(result.earlySkip.temporaryExcluded).toBe(true);
    expect(result.earlySkip.autonomousSuppressed).toBe(false);
    expect(result.contributions.map((item) => item.reasonCode)).toContain('early_skip_track');
    expect(evaluateRecall({
      candidate: candidate('same-track', 'Lead Artist'),
      context: policyContext('autonomous'),
      pressure: result.contributions
    })).toMatchObject({ action: 'suppress', reasonCodes: ['temporary_queue_exclusion'] });
    expect(evaluateRecall({
      candidate: candidate('same-track', 'Lead Artist'),
      context: policyContext('explicit_request'),
      pressure: result.contributions
    })).toMatchObject({ action: 'include', reasonCodes: ['explicit_request_soft_bypass'] });
  });

  it('expires the temporary exclusion at the exact 24 hour boundary', () => {
    const result = calculateSelectionPressure({
      candidate: candidate('same-track', 'Lead Artist'),
      now: NOW,
      earlySkips: [earlySkip('same-track', 'Lead Artist', hoursAgo(24))]
    });

    expect(result.earlySkip.temporaryExcluded).toBe(false);
    expect(result.contributions).toContainEqual(expect.objectContaining({
      reasonCode: 'early_skip_track',
      evidence: expect.objectContaining({ temporaryExcluded: false })
    }));
    expect(evaluateRecall({
      candidate: candidate('same-track', 'Lead Artist'),
      context: policyContext('autonomous'),
      pressure: result.contributions
    })).toMatchObject({ action: 'include', reasonCodes: ['recall_included'] });
  });

  it('suppresses after two fresh track skips and decays back to soft pressure', () => {
    const observations = [
      earlySkip('same-track', 'Lead Artist', hoursAgo(1)),
      earlySkip('same-track', 'Lead Artist', hoursAgo(6), 'episode-2')
    ];
    const fresh = calculateSelectionPressure({ candidate: candidate('same-track', 'Lead Artist'), now: NOW, earlySkips: observations });
    const decayed = calculateSelectionPressure({
      candidate: candidate('same-track', 'Lead Artist'),
      now: new Date(NOW.getTime() + 30 * 86_400_000),
      earlySkips: observations
    });

    expect(fresh.earlySkip.trackEffectiveCount).toBeGreaterThanOrEqual(EARLY_SKIP_TRACK_SUPPRESSION_THRESHOLD);
    expect(fresh.earlySkip.autonomousSuppressed).toBe(true);
    expect(decayed.earlySkip.trackEffectiveCount).toBeLessThan(EARLY_SKIP_TRACK_SUPPRESSION_THRESHOLD);
    expect(decayed.earlySkip.autonomousSuppressed).toBe(false);
  });

  it('suppresses a primary artist only after three distinct primary-artist tracks', () => {
    const twoTracks = [
      earlySkip('lead-1', 'Lead Artist', hoursAgo(1)),
      earlySkip('lead-2', 'Lead Artist', hoursAgo(2))
    ];
    const threeTracks = [...twoTracks, earlySkip('lead-3', 'Lead Artist', hoursAgo(3))];

    const soft = calculateSelectionPressure({ candidate: candidate('new', 'Lead Artist'), now: NOW, earlySkips: twoTracks });
    const suppressed = calculateSelectionPressure({ candidate: candidate('new', 'Lead Artist'), now: NOW, earlySkips: threeTracks });

    expect(soft.earlySkip.artistEffectiveCount).toBeLessThan(EARLY_SKIP_ARTIST_SUPPRESSION_THRESHOLD);
    expect(soft.earlySkip.autonomousSuppressed).toBe(false);
    expect(suppressed.earlySkip.artistDistinctTrackCount).toBe(3);
    expect(suppressed.earlySkip.artistEffectiveCount).toBeGreaterThanOrEqual(EARLY_SKIP_ARTIST_SUPPRESSION_THRESHOLD);
    expect(suppressed.earlySkip.autonomousSuppressed).toBe(true);
  });

  it('does not aggregate collaborator appearances into primary-artist skip pressure', () => {
    const result = calculateSelectionPressure({
      candidate: candidate('guest-track', 'Guest Artist'),
      now: NOW,
      earlySkips: [
        { ...earlySkip('lead-1', 'Lead One', hoursAgo(1)), artists: ['Lead One', 'Guest Artist'] },
        { ...earlySkip('lead-2', 'Lead Two', hoursAgo(2)), artists: ['Lead Two', 'Guest Artist'] },
        { ...earlySkip('lead-3', 'Lead Three', hoursAgo(3)), artists: ['Lead Three', 'Guest Artist'] }
      ]
    });

    expect(result.earlySkip.artistDistinctTrackCount).toBe(0);
    expect(result.earlySkip.artistEffectiveCount).toBe(0);
    expect(result.earlySkip.autonomousSuppressed).toBe(false);
  });
});

function candidate(id: string, primaryArtist: string): SelectionPolicyCandidate {
  const track: MusicCandidate = {
    id,
    name: `Song ${id}`,
    artist: primaryArtist,
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
  return { track, trackKey: id, primaryArtist: primaryArtist.toLocaleLowerCase() };
}

function queueTrack(id: string, primaryArtist: string) {
  return { id, trackKey: id, primaryArtist: primaryArtist.toLocaleLowerCase(), source: 'search' as const };
}

function earlySkip(trackKey: string, primaryArtist: string, occurredAt: string, id = `episode-${trackKey}`) {
  return { id, trackKey, primaryArtist: primaryArtist.toLocaleLowerCase(), occurredAt };
}

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

function policyContext(mode: SelectionPolicyContext['mode']): SelectionPolicyContext {
  return { mode, explicitlyRequested: mode === 'explicit_request' };
}
