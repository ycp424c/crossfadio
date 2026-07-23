import { areMusicTrackDedupeKeysSimilar } from '../dedupe.js';
import {
  isCurrentExplicitRequest,
  type SelectionPolicyCandidate,
  type SelectionPolicyContext,
  type SelectionRotationPolicyContext,
  type SelectionRotationTrackState
} from './types.js';

export const SELECTION_ROTATION_TRACK_HARD_ROUNDS = 12;
export const SELECTION_ROTATION_TRACK_SOFT_ROUNDS = 40;

export function buildSelectionRotationPolicyContext(input: {
  currentRound: number;
  picks: readonly { trackKey: string; roundNumber: number }[];
}): SelectionRotationPolicyContext {
  const minimumRound = Math.max(
    0,
    input.currentRound - SELECTION_ROTATION_TRACK_SOFT_ROUNDS + 1
  );
  const byTrack = new Map<string, SelectionRotationTrackState>();
  for (const pick of input.picks) {
    if (pick.roundNumber < minimumRound) continue;
    const existing = byTrack.get(pick.trackKey);
    byTrack.set(pick.trackKey, {
      trackKey: pick.trackKey,
      lastSelectedRound: Math.max(existing?.lastSelectedRound ?? 0, pick.roundNumber),
      selectionsInWindow: (existing?.selectionsInWindow ?? 0) + 1
    });
  }
  return {
    currentRound: input.currentRound,
    tracks: [...byTrack.values()]
  };
}

export function rotationTrackState(
  candidate: SelectionPolicyCandidate,
  context: SelectionPolicyContext
): SelectionRotationTrackState | undefined {
  const matching = context.rotation?.tracks.filter((state) =>
    areMusicTrackDedupeKeysSimilar(state.trackKey, candidate.trackKey)
  );
  if (!matching || matching.length === 0) return undefined;
  return {
    trackKey: candidate.trackKey,
    lastSelectedRound: Math.max(...matching.map((state) => state.lastSelectedRound)),
    selectionsInWindow: matching.reduce(
      (count, state) => count + state.selectionsInWindow,
      0
    )
  };
}

export function isRotationTrackSuppressed(
  candidate: SelectionPolicyCandidate,
  context: SelectionPolicyContext
): boolean {
  if (isCurrentExplicitRequest(context, candidate)) return false;
  const state = rotationTrackState(candidate, context);
  if (!state || !context.rotation) return false;
  return Math.max(0, context.rotation.currentRound - state.lastSelectedRound)
    < SELECTION_ROTATION_TRACK_HARD_ROUNDS;
}
