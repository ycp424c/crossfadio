import type { MusicCandidate } from './schema.js';

export type PlaybackEligibilityReason =
  | 'invalid_track_identity'
  | 'copyright_unavailable'
  | 'privilege_unavailable'
  | 'privilege_notice';

export type PlaybackEligibilityDecision = {
  eligible: boolean;
  reasons: PlaybackEligibilityReason[];
};

export function evaluatePlaybackEligibility(
  candidate: Pick<MusicCandidate, 'id' | 'name' | 'artist' | 'qualitySignals'>
): PlaybackEligibilityDecision {
  const reasons: PlaybackEligibilityReason[] = [];
  if (!hasValidTrackIdentity(candidate)) {
    reasons.push('invalid_track_identity');
  }
  if (candidate.qualitySignals?.copyright === 0) {
    reasons.push('copyright_unavailable');
  }
  if (candidate.qualitySignals?.privilegeSt !== undefined && candidate.qualitySignals.privilegeSt < 0) {
    reasons.push('privilege_unavailable');
  }
  if (candidate.qualitySignals?.privilegeToast === true) {
    reasons.push('privilege_notice');
  }
  return {
    eligible: reasons.length === 0,
    reasons
  };
}

// Keep this hard gate deliberately high precision: numbered titles such as
// "Song 2" and "Track 10" can be legitimate releases and belong in soft
// quality assessment, not source-independent playback rejection.
const GENERIC_IDENTITY_PATTERN = /^(?:unknown(?: artist)?|untitled)$/i;

export function hasValidTrackIdentity(
  candidate: Pick<MusicCandidate, 'id' | 'name' | 'artist'>
): boolean {
  const id = clean(candidate.id);
  const name = clean(candidate.name);
  const artist = clean(candidate.artist);
  if (!id || !name || !artist || id.length > 200 || name.length > 180 || artist.length > 180) return false;
  if (GENERIC_IDENTITY_PATTERN.test(name) || GENERIC_IDENTITY_PATTERN.test(artist)) return false;
  if (!/[\p{L}\p{N}]/u.test(name) || !/[\p{L}\p{N}]/u.test(artist)) return false;
  return name.toLocaleLowerCase() !== artist.toLocaleLowerCase();
}

function clean(value: string | null | undefined): string {
  return value?.normalize('NFKC').trim() ?? '';
}
