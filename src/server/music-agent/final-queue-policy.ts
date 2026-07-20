import { getCurrentIndex, getQueue } from '../store/queue.js';
import { findMatchingExplicitExclusion } from '../store/explicit-exclusions.js';
import { explicitArtistKeys, primaryArtistKey } from './artists.js';
import { buildMusicTrackDedupeKey } from './dedupe.js';
import type { FinalPick, MusicCandidate } from './schema.js';
import { evaluateFinal } from './selection-policy/final.js';
import {
  selectionPolicyReplayContext,
  type SelectionPolicyReplayContext
} from './selection-policy/replay-case.js';
import type {
  SelectionExclusions,
  SelectionPhaseDecision,
  SelectionPolicyContext,
  SelectionPolicyMode
} from './selection-policy/types.js';

export type FinalQueueEvaluation = {
  decision: SelectionPhaseDecision;
  replayContext: SelectionPolicyReplayContext;
};

/**
 * Rebuild the authoritative hard-gate context immediately before queue mutation.
 * This deliberately reads only live queue/exclusion state; historical pressure
 * belongs to recall/ranking and must not become a final hard gate.
 */
export function evaluateFinalQueuePick(input: {
  userId: string;
  pick: FinalPick;
  mode: SelectionPolicyMode;
  runId?: string;
  evaluatedAt?: string;
}): SelectionPhaseDecision {
  return evaluateFinalQueuePickWithContext(input).decision;
}

export function evaluateFinalQueuePickWithContext(input: {
  userId: string;
  pick: FinalPick;
  mode: SelectionPolicyMode;
  runId?: string;
  evaluatedAt?: string;
  playedTrackIds?: ReadonlySet<string>;
  playedTrackKeys?: ReadonlySet<string>;
}): FinalQueueEvaluation {
  const candidate = candidateFromFinalPick(input.pick);
  const policyCandidate = {
    track: candidate,
    trackKey: buildMusicTrackDedupeKey({ name: candidate.name, artist: candidate.artist }),
    primaryArtist: primaryArtistKey(candidate.artist),
    artistKeys: explicitArtistKeys(candidate.artist)
  };
  const context = liveFinalContext(input.userId, input.mode, candidate, {
    playedTrackIds: input.playedTrackIds,
    playedTrackKeys: input.playedTrackKeys
  });
  return {
    decision: evaluateFinal({ candidate: policyCandidate, context }),
    replayContext: selectionPolicyReplayContext(policyCandidate, context)
  };
}

function liveFinalContext(
  userId: string,
  mode: SelectionPolicyMode,
  candidate: MusicCandidate,
  idempotency: {
    playedTrackIds?: ReadonlySet<string>;
    playedTrackKeys?: ReadonlySet<string>;
  }
): SelectionPolicyContext {
  const queue = getQueue(userId);
  return {
    mode,
    explicitlyRequested: mode === 'explicit_request',
    explicitExclusions: liveExplicitExclusions(userId, candidate),
    queue: {
      currentIndex: getCurrentIndex(userId),
      tracks: queue.map((track) => ({
        id: track.ncmId,
        trackKey: buildMusicTrackDedupeKey({
          name: track.name,
          artists: track.artists
        }),
        primaryArtist: primaryArtistKey(track.artists?.[0] ?? '')
      }))
    },
    playedTrackIds: idempotency.playedTrackIds
      ? new Set(idempotency.playedTrackIds)
      : undefined,
    playedTrackKeys: idempotency.playedTrackKeys
      ? new Set(idempotency.playedTrackKeys)
      : undefined
  };
}

function liveExplicitExclusions(
  userId: string,
  candidate: MusicCandidate
): SelectionExclusions {
  const match = findMatchingExplicitExclusion(userId, {
    id: candidate.id,
    name: candidate.name,
    artists: explicitArtistLabels(candidate.artist)
  });
  if (!match) return {};
  return match.entityType === 'track'
    ? { trackIds: new Set([candidate.id]) }
    : { artistKeys: new Set(explicitArtistKeys(candidate.artist)) };
}

function explicitArtistLabels(value: string): string[] {
  const labels = /\s+\/\s+/u.test(value) ? value.split(/\s+\/\s+/u) : [value];
  return [...new Set([value, ...labels].map((artist) => artist.trim()).filter(Boolean))];
}

function candidateFromFinalPick(pick: FinalPick): MusicCandidate {
  return {
    id: pick.id,
    name: pick.name?.trim() ?? '',
    artist: pick.artist?.trim() ?? '',
    sources: [pick.source],
    evidence: [],
    scores: {
      intentMatch: 0,
      tasteMatch: 0,
      timeFit: 0,
      contextFit: 0,
      novelty: 0,
      sourceConfidence: 0
    },
    ...(pick.qualitySignals ? { qualitySignals: pick.qualitySignals } : {})
  };
}
