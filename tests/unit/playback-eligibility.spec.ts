import { describe, expect, it } from 'vitest';
import { evaluatePlaybackEligibility } from '../../src/server/music-agent/playback-eligibility.js';
import type { MusicCandidate } from '../../src/server/music-agent/schema.js';

describe('playback eligibility', () => {
  it('rejects copyright=0 even when the candidate comes from liked music', () => {
    const decision = evaluatePlaybackEligibility(candidate({ copyright: 0 }));

    expect(decision).toEqual({
      eligible: false,
      reasons: ['copyright_unavailable']
    });
  });

  it('rejects negative playback privilege', () => {
    expect(evaluatePlaybackEligibility(candidate({ privilegeSt: -1 }))).toEqual({
      eligible: false,
      reasons: ['privilege_unavailable']
    });
  });

  it('rejects a playback privilege notice', () => {
    expect(evaluatePlaybackEligibility(candidate({ privilegeToast: true }))).toEqual({
      eligible: false,
      reasons: ['privilege_notice']
    });
  });

  it('rejects a malformed track identity', () => {
    expect(evaluatePlaybackEligibility(candidate(undefined, { name: 'unknown' }))).toEqual({
      eligible: false,
      reasons: ['invalid_track_identity']
    });
  });

  it('keeps numbered release titles eligible instead of treating them as placeholders', () => {
    expect(evaluatePlaybackEligibility(candidate(undefined, { name: 'Song 101' }))).toEqual({
      eligible: true,
      reasons: []
    });
  });

  it('does not turn soft candidate quality signals into playback rejection', () => {
    expect(evaluatePlaybackEligibility(candidate({
      popularity: 0,
      noCopyrightRcmd: true,
      titlePollution: 'strong'
    }))).toEqual({
      eligible: true,
      reasons: []
    });
  });
});

function candidate(
  qualitySignals: MusicCandidate['qualitySignals'],
  overrides: Partial<Pick<MusicCandidate, 'id' | 'name' | 'artist'>> = {}
): MusicCandidate {
  return {
    id: 'track-1',
    name: 'Valid Song',
    artist: 'Valid Artist',
    ...overrides,
    sources: ['liked'],
    evidence: [],
    scores: {
      intentMatch: 1,
      tasteMatch: 1,
      timeFit: 1,
      contextFit: 1,
      novelty: 0,
      sourceConfidence: 1
    },
    qualitySignals
  };
}
