import type { CandidateSource, MusicCandidate } from '../schema.js';
import type { PlaybackEligibilityReason } from '../playback-eligibility.js';
import { buildMusicTrackDedupeKey, normalizeMusicTrackToken } from '../dedupe.js';
import { explicitArtistKeys, primaryArtistKey } from '../artists.js';

export type SelectionPolicyMode = 'autonomous' | 'explicit_request';
export type SelectionPolicyPhase = 'admission' | 'recall' | 'ranking' | 'batch' | 'final';
export type SelectionPolicyAction = 'admit' | 'reject' | 'include' | 'suppress' | 'rank' | 'select' | 'defer';

export type SelectionReasonCode = PlaybackEligibilityReason
  | 'explicit_track_exclusion'
  | 'explicit_artist_exclusion'
  | 'admission_eligible'
  | 'explicit_request_soft_bypass'
  | 'temporary_queue_exclusion'
  | 'retrieval_cooldown'
  | 'early_skip_track_suppression'
  | 'early_skip_artist_suppression'
  | 'recall_included'
  | 'active_directive_match'
  | 'expressed_preference_match'
  | 'inferred_preference_match'
  | 'exposure_track'
  | 'exposure_artist'
  | 'early_skip_track'
  | 'early_skip_artist'
  | 'upcoming_queue_track'
  | 'upcoming_queue_artist'
  | 'rotation_track_suppression'
  | 'rotation_track_penalty'
  | 'rotation_frequency_penalty'
  | 'rotation_final_rejection'
  | 'batch_primary_artist_repeat'
  | 'batch_source_repeat'
  | 'batch_title_motif_repeat'
  | 'retrieval_pressure'
  | 'candidate_quality'
  | 'semantic_compatibility'
  | 'trend_match'
  | 'ranking_scored'
  | 'batch_selected'
  | 'queue_track_idempotency'
  | 'queue_target_reached'
  | 'played_track_idempotency'
  | 'final_eligible';

export type SelectionPressureSource =
  | 'active_directive'
  | 'fresh_preference'
  | 'inferred_preference'
  | 'exposure'
  | 'early_skip'
  | 'rotation'
  | 'upcoming_queue'
  | 'batch'
  | 'retrieval'
  | 'candidate_quality'
  | 'trend';

export type SelectionPressureContribution = {
  source: SelectionPressureSource;
  reasonCode: SelectionReasonCode;
  direction: 'boost' | 'penalty';
  amount: number;
  severity?: 'soft' | 'suppress';
  bypassed?: boolean;
  evidence?: Record<string, string | number | boolean>;
};

export type SelectionPolicyCandidate = {
  track: MusicCandidate;
  trackKey: string;
  primaryArtist: string;
  artistKeys?: readonly string[];
};

export type SelectionPolicyTrack = {
  id: string;
  trackKey: string;
  primaryArtist: string;
  source?: CandidateSource;
};

export type SelectionQueueState = {
  tracks: SelectionPolicyTrack[];
  currentIndex: number;
};

export type SelectionRotationTrackState = {
  trackKey: string;
  lastSelectedRound: number;
  selectionsInWindow: number;
};

export type SelectionRotationPolicyContext = {
  currentRound: number;
  tracks: readonly SelectionRotationTrackState[];
};

export type SelectionExclusions = {
  trackIds?: ReadonlySet<string>;
  trackKeys?: ReadonlySet<string>;
  trackTokens?: ReadonlySet<string>;
  primaryArtists?: ReadonlySet<string>;
  artistKeys?: ReadonlySet<string>;
};

export type SelectionPolicyContext = {
  mode: SelectionPolicyMode;
  explicitlyRequested: boolean;
  explicitRequest?: SelectionExclusions;
  explicitExclusions?: SelectionExclusions;
  temporaryExclusions?: SelectionExclusions;
  retrievalCooldownTrackKeys?: ReadonlySet<string>;
  rotation?: SelectionRotationPolicyContext;
  queue?: SelectionQueueState;
  playedTrackIds?: ReadonlySet<string>;
  playedTrackKeys?: ReadonlySet<string>;
};

export type SelectionPhaseDecision = {
  phase: SelectionPolicyPhase;
  action: SelectionPolicyAction;
  reasonCodes: SelectionReasonCode[];
  contributions?: SelectionPressureContribution[];
};

export const SELECTION_PRESSURE_PRIORITY: Record<SelectionPressureSource, number> = {
  active_directive: 3,
  fresh_preference: 4,
  inferred_preference: 5,
  exposure: 6,
  early_skip: 6,
  rotation: 6,
  upcoming_queue: 6,
  batch: 6,
  retrieval: 6,
  candidate_quality: 6,
  trend: 7
};

export function isCurrentExplicitRequest(
  context: SelectionPolicyContext,
  candidate?: SelectionPolicyCandidate
): boolean {
  if (context.mode !== 'explicit_request' || !context.explicitlyRequested) return false;
  if (!context.explicitRequest) return true;
  return candidate ? matchesExclusion(candidate, context.explicitRequest) !== null : false;
}

export function matchesExclusion(
  candidate: SelectionPolicyCandidate,
  exclusions: SelectionExclusions | undefined
): 'track' | 'artist' | null {
  if (!exclusions) return null;
  if (exclusions.trackIds?.has(candidate.track.id) || exclusions.trackKeys?.has(candidate.trackKey)) {
    return 'track';
  }
  if (exclusions.trackTokens) {
    const candidateTokens = [candidate.track.id, candidate.track.name, candidate.trackKey]
      .map(normalizeMusicTrackToken)
      .filter(Boolean);
    if (candidateTokens.some((token) => exclusions.trackTokens?.has(token))) return 'track';
  }
  if (candidate.artistKeys?.some((key) => exclusions.artistKeys?.has(key))) return 'artist';
  return exclusions.primaryArtists?.has(candidate.primaryArtist) ? 'artist' : null;
}

export function toSelectionPolicyCandidate(candidate: MusicCandidate): SelectionPolicyCandidate {
  return {
    track: candidate,
    trackKey: buildMusicTrackDedupeKey({ name: candidate.name, artist: candidate.artist }),
    primaryArtist: primaryArtistKey(candidate.artist),
    artistKeys: explicitArtistKeys(candidate.artist)
  };
}
