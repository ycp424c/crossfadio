import type {
  SelectionPolicyCandidate,
  SelectionPressureContribution,
  SelectionQueueState
} from './selection-policy/types.js';
import {
  SELECTION_ROTATION_TRACK_HARD_ROUNDS,
  SELECTION_ROTATION_TRACK_SOFT_ROUNDS
} from './selection-policy/rotation.js';

export {
  SELECTION_ROTATION_TRACK_HARD_ROUNDS,
  SELECTION_ROTATION_TRACK_SOFT_ROUNDS
} from './selection-policy/rotation.js';

export const SELECTION_PRESSURE_WINDOW_DAYS = 60;
export const SELECTION_PRESSURE_HALF_LIFE_DAYS = 21;
export const EARLY_SKIP_TRACK_SUPPRESSION_THRESHOLD = 1.5;
export const EARLY_SKIP_ARTIST_SUPPRESSION_THRESHOLD = 2.25;
export const EARLY_SKIP_TEMPORARY_EXCLUSION_HOURS = 24;

const UPCOMING_QUEUE_WEIGHTS = [0.36, 0.28, 0.2, 0.14, 0.1, 0.08];

export type EarlySkipObservation = {
  id: string;
  trackKey: string;
  primaryArtist: string;
  occurredAt: string;
  artists?: string[];
};

export type ExposureObservation = {
  id: string;
  trackKey: string;
  primaryArtist: string;
  exposure: number;
  occurredAt: string;
};

export type SelectionRotationObservation = {
  currentRound: number;
  lastSelectedRound: number;
  selectionsInWindow: number;
};

export type SelectionPressureAggregate = {
  trackEarlySkipObservationCount: number;
  trackEarlySkipEffectiveCount: number;
  latestTrackEarlySkipAt: string | null;
  artistEarlySkipDistinctTrackCount: number;
  artistEarlySkipEffectiveCount: number;
  trackExposureEffective: number;
  artistExposureEffective: number;
};

export type SelectionPressureResult = {
  contributions: SelectionPressureContribution[];
  earlySkip: {
    trackObservationCount: number;
    trackEffectiveCount: number;
    artistDistinctTrackCount: number;
    artistEffectiveCount: number;
    temporaryExcluded: boolean;
    autonomousSuppressed: boolean;
  };
};

export function calculateSelectionPressure(input: {
  candidate: SelectionPolicyCandidate;
  now: Date;
  earlySkips?: EarlySkipObservation[];
  exposures?: ExposureObservation[];
  queue?: SelectionQueueState;
  retrievalCooldown?: boolean;
  trendMatch?: number;
  aggregate?: SelectionPressureAggregate;
  rotation?: SelectionRotationObservation;
}): SelectionPressureResult {
  const contributions: SelectionPressureContribution[] = [];
  const earlySkips = recentWeighted(input.earlySkips ?? [], input.now);
  const matchingTrackSkips = earlySkips.filter((item) => item.observation.trackKey === input.candidate.trackKey);
  const trackObservationCount = input.aggregate?.trackEarlySkipObservationCount
    ?? matchingTrackSkips.length;
  const trackEffectiveCount = input.aggregate?.trackEarlySkipEffectiveCount
    ?? sum(matchingTrackSkips.map((item) => item.weight));
  const trackSuppressed = trackObservationCount >= 2
    && trackEffectiveCount >= EARLY_SKIP_TRACK_SUPPRESSION_THRESHOLD;
  const latestTrackSkipAgeHours = input.aggregate
    ? ageHours(input.aggregate.latestTrackEarlySkipAt, input.now)
    : Math.min(
        Number.POSITIVE_INFINITY,
        ...matchingTrackSkips.map((item) => item.ageDays * 24)
      );

  const artistByTrack = new Map<string, number>();
  for (const item of earlySkips) {
    if (normalize(item.observation.primaryArtist) !== normalize(input.candidate.primaryArtist)) continue;
    artistByTrack.set(
      item.observation.trackKey,
      Math.max(artistByTrack.get(item.observation.trackKey) ?? 0, item.weight)
    );
  }
  const artistDistinctTrackCount = input.aggregate?.artistEarlySkipDistinctTrackCount
    ?? artistByTrack.size;
  const artistEffectiveCount = input.aggregate?.artistEarlySkipEffectiveCount
    ?? sum([...artistByTrack.values()]);
  const artistSuppressed = artistDistinctTrackCount >= 3
    && artistEffectiveCount >= EARLY_SKIP_ARTIST_SUPPRESSION_THRESHOLD;

  if (trackObservationCount > 0) {
    contributions.push({
      source: 'early_skip',
      reasonCode: 'early_skip_track',
      direction: 'penalty',
      amount: round(Math.min(0.3, 0.12 * trackEffectiveCount)),
      severity: trackSuppressed ? 'suppress' : 'soft',
      evidence: {
        effectiveCount: round(trackEffectiveCount),
        observations: trackObservationCount,
        temporaryExcluded: latestTrackSkipAgeHours < EARLY_SKIP_TEMPORARY_EXCLUSION_HOURS
      }
    });
  }
  if (artistDistinctTrackCount >= 2) {
    contributions.push({
      source: 'early_skip',
      reasonCode: 'early_skip_artist',
      direction: 'penalty',
      amount: round(Math.min(0.24, 0.07 * artistEffectiveCount)),
      severity: artistSuppressed ? 'suppress' : 'soft',
      evidence: { effectiveCount: round(artistEffectiveCount), distinctTracks: artistDistinctTrackCount }
    });
  }

  addRotationContributions(contributions, input.rotation);
  addExposureContributions(contributions, input);
  addUpcomingQueueContributions(contributions, input.candidate, input.queue);
  if (input.retrievalCooldown) {
    contributions.push({
      source: 'retrieval',
      reasonCode: 'retrieval_pressure',
      direction: 'penalty',
      amount: 0.16,
      severity: 'suppress'
    });
  }
  if (input.trendMatch && input.trendMatch > 0) {
    contributions.push({
      source: 'trend',
      reasonCode: 'trend_match',
      direction: 'boost',
      amount: round(Math.min(0.12, input.trendMatch * 0.12))
    });
  }

  return {
    contributions,
    earlySkip: {
      trackObservationCount,
      trackEffectiveCount: round(trackEffectiveCount),
      artistDistinctTrackCount,
      artistEffectiveCount: round(artistEffectiveCount),
      temporaryExcluded: latestTrackSkipAgeHours < EARLY_SKIP_TEMPORARY_EXCLUSION_HOURS,
      autonomousSuppressed: trackSuppressed || artistSuppressed
    }
  };
}

function addRotationContributions(
  contributions: SelectionPressureContribution[],
  rotation: SelectionRotationObservation | undefined
): void {
  if (!rotation) return;
  const roundDistance = Math.max(
    0,
    Math.trunc(rotation.currentRound) - Math.trunc(rotation.lastSelectedRound)
  );
  const evidence = {
    currentRound: Math.max(0, Math.trunc(rotation.currentRound)),
    lastSelectedRound: Math.max(0, Math.trunc(rotation.lastSelectedRound)),
    roundDistance,
    hardRounds: SELECTION_ROTATION_TRACK_HARD_ROUNDS,
    softRounds: SELECTION_ROTATION_TRACK_SOFT_ROUNDS,
    selectionsInWindow: Math.max(0, Math.trunc(rotation.selectionsInWindow))
  };
  if (roundDistance < SELECTION_ROTATION_TRACK_HARD_ROUNDS) {
    contributions.push({
      source: 'rotation',
      reasonCode: 'rotation_track_suppression',
      direction: 'penalty',
      amount: 1,
      severity: 'suppress',
      evidence
    });
    return;
  }
  if (roundDistance >= SELECTION_ROTATION_TRACK_SOFT_ROUNDS) return;
  const remaining = SELECTION_ROTATION_TRACK_SOFT_ROUNDS - roundDistance;
  const softWindow = SELECTION_ROTATION_TRACK_SOFT_ROUNDS
    - SELECTION_ROTATION_TRACK_HARD_ROUNDS;
  contributions.push({
    source: 'rotation',
    reasonCode: 'rotation_track_penalty',
    direction: 'penalty',
    amount: round(0.32 * remaining / softWindow),
    severity: 'soft',
    evidence
  });
  const selectionsInWindow = Math.max(0, Math.trunc(rotation.selectionsInWindow));
  if (selectionsInWindow > 1) {
    contributions.push({
      source: 'rotation',
      reasonCode: 'rotation_frequency_penalty',
      direction: 'penalty',
      amount: round(Math.min(0.3, (selectionsInWindow - 1) * 0.1)),
      severity: 'soft',
      evidence
    });
  }
}

function addExposureContributions(
  contributions: SelectionPressureContribution[],
  input: {
    candidate: SelectionPolicyCandidate;
    now: Date;
    exposures?: ExposureObservation[];
    aggregate?: SelectionPressureAggregate;
  }
): void {
  const exposures = recentWeighted(input.exposures ?? [], input.now);
  const trackExposure = input.aggregate?.trackExposureEffective ?? sum(exposures
    .filter((item) => item.observation.trackKey === input.candidate.trackKey)
    .map((item) => item.weight * clamp01(item.observation.exposure)));
  const artistExposure = input.aggregate?.artistExposureEffective ?? sum(exposures
    .filter((item) => normalize(item.observation.primaryArtist) === normalize(input.candidate.primaryArtist))
    .map((item) => item.weight * clamp01(item.observation.exposure)));
  if (trackExposure > 0) {
    contributions.push({
      source: 'exposure',
      reasonCode: 'exposure_track',
      direction: 'penalty',
      amount: round(Math.min(0.28, trackExposure * 0.12))
    });
  }
  if (artistExposure > 0) {
    contributions.push({
      source: 'exposure',
      reasonCode: 'exposure_artist',
      direction: 'penalty',
      amount: round(Math.min(0.24, artistExposure * 0.06))
    });
  }
}

function addUpcomingQueueContributions(
  contributions: SelectionPressureContribution[],
  candidate: SelectionPolicyCandidate,
  queue: SelectionQueueState | undefined
): void {
  if (!queue || queue.tracks.length === 0) return;
  const start = Math.min(queue.tracks.length, Math.max(0, Math.trunc(queue.currentIndex) + 1));
  const upcoming = queue.tracks.slice(start);
  const exactIndex = upcoming.findIndex((track) =>
    track.id === candidate.track.id || (track.trackKey.length > 0 && track.trackKey === candidate.trackKey)
  );
  if (exactIndex >= 0) {
    contributions.push({
      source: 'upcoming_queue',
      reasonCode: 'upcoming_queue_track',
      direction: 'penalty',
      amount: UPCOMING_QUEUE_WEIGHTS[Math.min(exactIndex, UPCOMING_QUEUE_WEIGHTS.length - 1)] ?? 0.08
    });
  }
  const artistIndex = upcoming.findIndex((track) =>
    normalize(track.primaryArtist) === normalize(candidate.primaryArtist)
  );
  if (artistIndex >= 0) {
    contributions.push({
      source: 'upcoming_queue',
      reasonCode: 'upcoming_queue_artist',
      direction: 'penalty',
      amount: UPCOMING_QUEUE_WEIGHTS[Math.min(artistIndex, UPCOMING_QUEUE_WEIGHTS.length - 1)] ?? 0.08
    });
  }
}

function recentWeighted<T extends { occurredAt: string }>(
  observations: T[],
  now: Date
): Array<{ observation: T; ageDays: number; weight: number }> {
  return observations.flatMap((observation) => {
    const occurredAt = Date.parse(observation.occurredAt);
    if (!Number.isFinite(occurredAt)) return [];
    const ageDays = Math.max(0, (now.getTime() - occurredAt) / 86_400_000);
    if (occurredAt > now.getTime() || ageDays > SELECTION_PRESSURE_WINDOW_DAYS) return [];
    return [{ observation, ageDays, weight: Math.pow(0.5, ageDays / SELECTION_PRESSURE_HALF_LIFE_DAYS) }];
  });
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

function ageHours(value: string | null, now: Date): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > now.getTime()) return Number.POSITIVE_INFINITY;
  return (now.getTime() - timestamp) / 3_600_000;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
