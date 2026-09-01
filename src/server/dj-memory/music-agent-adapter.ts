import { explicitArtistKeys, primaryArtistKey } from '../music-agent/artists.js';
import { buildMusicTrackDedupeKey, normalizeMusicTrackToken } from '../music-agent/dedupe.js';
import { explicitTrackExclusionPolicyKeys } from '../store/explicit-exclusions.js';
import { deriveListeningSignals } from '../listening/listening-signals.js';
import {
  calculateSelectionPressure,
  type EarlySkipObservation,
  type ExposureObservation,
  type SelectionPressureAggregate
} from '../music-agent/selection-pressure.js';
import {
  buildSelectionRotationPolicyContext,
  rotationTrackState
} from '../music-agent/selection-policy/rotation.js';
import type { MusicAgentRuntimeContext, MusicCandidate } from '../music-agent/schema.js';
import {
  isCurrentExplicitRequest,
  toSelectionPolicyCandidate,
  type SelectionExclusions,
  type SelectionPolicyContext,
  type SelectionPolicyMode,
  type SelectionPressureContribution
} from '../music-agent/selection-policy/types.js';
import type { SelectionIntent } from '../music-agent/selection-intent.js';
import {
  projectDjMemoryForSelection,
  projectDjMemoryToMusicAgentRuntime
} from './projections.js';
import type { DjMemorySnapshot } from './schema.js';

export type MusicAgentSelectionAdapter = {
  snapshotId: string;
  sourceReservoir: DjMemorySnapshot['sourceReservoir'];
  runtimeContext: MusicAgentRuntimeContext;
  policyContext: SelectionPolicyContext;
  pressureForCandidate: (candidate: MusicCandidate) => SelectionPressureContribution[];
  selectionModeForCandidate: (candidate: {
    id: string;
    name?: string;
    artist?: string;
  }) => SelectionPolicyMode;
};

type SelectionPressureIndex = {
  tracks: ReadonlyMap<
    string,
    DjMemorySnapshot['selectionPressure']['tracks'][number]
  >;
  artists: ReadonlyMap<
    string,
    DjMemorySnapshot['selectionPressure']['artists'][number]
  >;
};

const ACTIVE_DIRECTIVE_MIN_SOFT_AMOUNT = 0.06;

export function createMusicAgentSelectionAdapter(input: {
  snapshot: DjMemorySnapshot;
  request: MusicAgentRuntimeContext['request'];
  userText?: string;
  actionQueries?: string[];
  selectionIntent?: SelectionIntent;
  playedTrackIds?: ReadonlySet<string>;
  playedTrackKeys?: ReadonlySet<string>;
}): MusicAgentSelectionAdapter {
  const explicitRequest = input.selectionIntent?.type === 'explicit_request'
    ? explicitRequestMatch(input.selectionIntent.subject)
    : undefined;
  const mode = explicitRequest ? 'explicit_request' : 'autonomous';
  const projection = projectDjMemoryForSelection(input.snapshot);
  const runtimeContext = projectDjMemoryToMusicAgentRuntime(projection, {
    request: input.request,
    ...(input.userText !== undefined ? { userText: input.userText } : {}),
    ...(input.actionQueries !== undefined ? { actionQueries: input.actionQueries } : {})
  });
  const queue = selectionQueue(input.snapshot);
  const rotation = buildSelectionRotationPolicyContext(input.snapshot.rotation);
  const policyContext: SelectionPolicyContext = {
    mode,
    explicitlyRequested: mode === 'explicit_request',
    ...(explicitRequest ? { explicitRequest } : {}),
    explicitExclusions: explicitExclusions(input.snapshot),
    temporaryExclusions: temporaryExclusions(input.snapshot),
    rotation,
    queue,
    ...(input.playedTrackIds ? { playedTrackIds: input.playedTrackIds } : {}),
    ...(input.playedTrackKeys ? { playedTrackKeys: input.playedTrackKeys } : {})
  };
  const hasCompletePressureProjection = input.snapshot.selectionPressure.tracks.length > 0
    || input.snapshot.selectionPressure.artists.length > 0;
  const earlySkips = hasCompletePressureProjection ? undefined : earlySkipObservations(input.snapshot);
  const exposures = hasCompletePressureProjection ? undefined : exposureObservations(input.snapshot);
  const pressureIndex = createSelectionPressureIndex(input.snapshot);
  const now = new Date(input.snapshot.metadata.assembledAt);
  const activeDirective = input.selectionIntent?.type === 'active_directive'
    ? input.selectionIntent.text
    : input.snapshot.activeDirective?.text;

  return {
    snapshotId: input.snapshot.metadata.snapshotId,
    sourceReservoir: input.snapshot.sourceReservoir,
    runtimeContext,
    policyContext,
    selectionModeForCandidate(candidate) {
      return isCurrentExplicitRequest(policyContext, policyCandidateForIdentity(candidate))
        ? 'explicit_request'
        : 'autonomous';
    },
    pressureForCandidate(candidate) {
      const policyCandidate = toSelectionPolicyCandidate(candidate);
      const rotationState = rotationTrackState(policyCandidate, policyContext);
      return [
        ...calculateSelectionPressure({
          candidate: policyCandidate,
          now,
          earlySkips,
          exposures,
          queue,
          ...(rotationState
            ? { rotation: { currentRound: rotation.currentRound, ...rotationState } }
            : {}),
          ...(hasCompletePressureProjection
            ? { aggregate: pressureAggregateForCandidate(pressureIndex, policyCandidate) }
            : {})
        }).contributions,
        ...preferenceContributions(input.snapshot, candidate),
        ...activeDirectiveContributions(activeDirective, candidate)
      ];
    }
  };
}

function policyCandidateForIdentity(candidate: {
  id: string;
  name?: string;
  artist?: string;
}): ReturnType<typeof toSelectionPolicyCandidate> {
  return toSelectionPolicyCandidate({
    id: candidate.id,
    name: candidate.name?.trim() ?? '',
    artist: candidate.artist?.trim() ?? '',
    sources: ['search'],
    evidence: [],
    scores: {
      intentMatch: 0,
      tasteMatch: 0,
      timeFit: 0,
      contextFit: 0,
      novelty: 0,
      sourceConfidence: 0
    }
  });
}

function explicitRequestMatch(
  subject: Extract<SelectionIntent, { type: 'explicit_request' }>['subject']
): SelectionExclusions {
  if (subject.type === 'artist') {
    return {
      artistKeys: new Set([
        ...explicitArtistKeys(subject.key),
        ...explicitArtistKeys(subject.label)
      ])
    };
  }
  const trackKey = buildMusicTrackDedupeKey({
    name: subject.label,
    artist: subject.artist ?? ''
  });
  return {
    trackKeys: new Set(trackKey ? [trackKey] : []),
    trackTokens: new Set(
      [subject.key, ...(subject.artist ? [] : [subject.label])]
        .map(normalizeMusicTrackToken)
        .filter(Boolean)
    )
  };
}

function activeDirectiveContributions(
  directive: string | undefined,
  candidate: MusicCandidate
): SelectionPressureContribution[] {
  if (!directive || !matchesActiveDirective(directive, candidate)) {
    return [];
  }
  return [{
    source: 'active_directive',
    reasonCode: 'active_directive_match',
    direction: isExplicitNegativeActiveDirective(directive) ? 'penalty' : 'boost',
    amount: round(Math.max(
      ACTIVE_DIRECTIVE_MIN_SOFT_AMOUNT,
      Math.max(0, Math.min(1, candidate.scores.intentMatch)) * 0.12
    )),
    severity: 'soft'
  }];
}

function matchesActiveDirective(directive: string, candidate: MusicCandidate): boolean {
  const terms = activeDirectiveTerms(directive);
  if (terms.length === 0) return false;
  const candidateText = [
    candidate.name,
    candidate.artist,
    ...candidate.evidence,
    ...(candidate.provenance ?? []).flatMap((item) => item.detail ? [item.detail] : [])
  ].map(normalizeDirectiveToken).filter(Boolean).join(' ');
  return terms.some((term) => candidateText.includes(term));
}

function activeDirectiveTerms(value: string): string[] {
  const cleaned = value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(
      /^(?:(?:今天|现在|这会儿|接下来|后面|这次|本次|下午|晚上|今晚|通勤时|工作时|写代码时)\s*)*(?:请|帮我)?(?:把下一首)?(?:来点|放点|听点|加点|来一些|放一些|听一些|加一些|来几首|放几首|听几首|加几首|来一首|放一首|听一首|加一首|多放|换得|换成|来|放|听|加)?/u,
      ''
    )
    .replace(/^(?:不想听|不想要|不要(?:再)?(?:放|听|来|加)?|别(?:再)?(?:放|听|来|加)?|避免|少放|少来|少听)/u, '')
    .replace(/(?:一点|一些|几首|歌曲|音乐|吧|呢)$/u, '')
    .trim();
  const chunks = cleaned.split(/[^\p{L}\p{N}]+/u).map(normalizeDirectiveToken).filter((item) => (
    item.length >= 2
  ));
  const semanticTerms = cleaned
    .replace(/^(?:的)?(?:自动选歌)?(?:优先选择|优先|尽量选择|尽量)?/u, '')
    .split(/[^\p{L}\p{N}]+/u)
    .flatMap((item) => item.split(/(?:或|以及|和)/u))
    .map((item) => item.replace(/(?:作品|歌曲|音乐)$/u, ''))
    .filter((item) => item.length >= 2 && !/^(?:除非|否则)/u.test(item))
    .map(normalizeDirectiveToken);
  const compact = normalizeDirectiveToken(cleaned);
  return [...new Set([
    ...(compact.length >= 2 ? [compact] : []),
    ...semanticTerms,
    ...chunks
  ])];
}

function isExplicitNegativeActiveDirective(value: string): boolean {
  const normalized = value.normalize('NFKC').toLocaleLowerCase().trim();
  return /^(?:(?:今天|现在|这会儿|接下来|后面|这次|本次|下午|晚上|今晚|通勤时|工作时|写代码时)\s*)*(?:请|帮我)?\s*(?:不想听|不想要|不要(?:再)?(?:放|听|来|加)?|别(?:再)?(?:放|听|来|加)?|避免|少放|少来|少听)/u.test(normalized);
}

function normalizeDirectiveToken(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function createSelectionPressureIndex(snapshot: DjMemorySnapshot): SelectionPressureIndex {
  return {
    tracks: new Map(snapshot.selectionPressure.tracks.map((item) => [item.trackKey, item])),
    artists: new Map(snapshot.selectionPressure.artists.map((item) => [item.primaryArtist, item]))
  };
}

function pressureAggregateForCandidate(
  index: SelectionPressureIndex,
  candidate: ReturnType<typeof toSelectionPolicyCandidate>
): SelectionPressureAggregate {
  const track = index.tracks.get(candidate.trackKey);
  const artist = index.artists.get(candidate.primaryArtist);
  return {
    trackEarlySkipObservationCount: track?.earlySkipObservationCount ?? 0,
    trackEarlySkipEffectiveCount: track?.earlySkipEffectiveCount ?? 0,
    latestTrackEarlySkipAt: track?.latestEarlySkipAt ?? null,
    artistEarlySkipDistinctTrackCount: artist?.earlySkipDistinctTrackCount ?? 0,
    artistEarlySkipEffectiveCount: artist?.earlySkipEffectiveCount ?? 0,
    trackExposureEffective: track?.exposureEffective ?? 0,
    artistExposureEffective: artist?.exposureEffective ?? 0
  };
}

function selectionQueue(snapshot: DjMemorySnapshot): NonNullable<SelectionPolicyContext['queue']> {
  const tracks = [
    ...(snapshot.queue.currentTrack ? [snapshot.queue.currentTrack] : []),
    ...snapshot.queue.upcoming
  ].map((track) => ({
    id: track.id,
    trackKey: buildMusicTrackDedupeKey({ name: track.name, artist: primaryArtist(track.artists) }),
    primaryArtist: primaryArtistKey(primaryArtist(track.artists))
  }));
  return { tracks, currentIndex: snapshot.queue.currentTrack ? 0 : -1 };
}

function explicitExclusions(snapshot: DjMemorySnapshot): SelectionExclusions {
  const tracks = snapshot.explicitExclusions.filter((item) => item.entityType === 'track');
  const trackIdentities = tracks.map(explicitTrackExclusionPolicyKeys);
  return {
    trackIds: new Set(trackIdentities.flatMap((item) => item.trackIds)),
    trackKeys: new Set(trackIdentities.flatMap((item) => item.trackKeys)),
    artistKeys: new Set(snapshot.explicitExclusions
      .filter((item) => item.entityType === 'artist')
      .flatMap((item) => explicitArtistKeys(item.entityKey)))
  };
}

function temporaryExclusions(snapshot: DjMemorySnapshot): SelectionExclusions {
  return {
    trackIds: new Set(snapshot.temporaryExclusions.map((item) => item.id)),
    trackKeys: new Set(snapshot.temporaryExclusions.flatMap((item) => {
      const key = buildMusicTrackDedupeKey({ name: item.name, artist: primaryArtist(item.artists) });
      return key ? [key] : [];
    }))
  };
}

function earlySkipObservations(snapshot: DjMemorySnapshot): EarlySkipObservation[] {
  return snapshot.listeningEpisodes.flatMap((episode) => {
    if (episode.outcome !== 'skipped') return [];
    const signals = deriveListeningSignals({
      outcome: episode.outcome,
      durationMs: episode.durationMs,
      positionMs: episode.positionMs ?? episode.listenedMs,
      listenedMs: episode.listenedMs,
      legacyExposureOverride: episode.legacyExposureOverride
    });
    if (!signals.earlySkip) return [];
    const primaryArtist = episode.primaryArtist ?? '';
    const trackKey = buildMusicTrackDedupeKey({ name: episode.trackName, artist: primaryArtist });
    if (!trackKey) return [];
    return [{
      id: episode.id,
      trackKey,
      primaryArtist: primaryArtistKey(primaryArtist),
      occurredAt: episode.startedAt
    }];
  });
}

function exposureObservations(snapshot: DjMemorySnapshot): ExposureObservation[] {
  return snapshot.listeningEpisodes.flatMap((episode) => {
    const primaryArtist = episode.primaryArtist ?? '';
    const trackKey = buildMusicTrackDedupeKey({ name: episode.trackName, artist: primaryArtist });
    if (!trackKey) return [];
    if (!episode.outcome) return [];
    const exposure = deriveListeningSignals({
      outcome: episode.outcome,
      durationMs: episode.durationMs,
      positionMs: episode.positionMs ?? episode.listenedMs,
      listenedMs: episode.listenedMs,
      legacyExposureOverride: episode.legacyExposureOverride
    }).exposure;
    return [{
      id: episode.id,
      trackKey,
      primaryArtist: primaryArtistKey(primaryArtist),
      exposure,
      occurredAt: episode.startedAt
    }];
  });
}

function preferenceContributions(
  snapshot: DjMemorySnapshot,
  candidate: MusicCandidate
): SelectionPressureContribution[] {
  return snapshot.preferences.flatMap((preference) => {
    if (!preferenceMatchesCandidate(preference, candidate)) return [];
    const expressed = preference.kind === 'expressed';
    return [{
      source: expressed ? 'fresh_preference' : 'inferred_preference',
      reasonCode: expressed ? 'expressed_preference_match' : 'inferred_preference_match',
      direction: preference.polarity === 'positive' ? 'boost' : 'penalty',
      amount: round(preference.score * (expressed ? 0.2 : 0.12)),
      severity: 'soft',
      evidence: { evidenceId: preference.evidenceIds[0] ?? preference.id }
    }];
  });
}

function preferenceMatchesCandidate(
  preference: DjMemorySnapshot['preferences'][number],
  candidate: MusicCandidate
): boolean {
  const key = normalizeMusicTrackToken(preference.subjectKey);
  if (!key) return false;
  const subjectType = preference.subjectType.toLocaleLowerCase();
  if (subjectType === 'track' || subjectType === 'song') {
    const trackKey = buildMusicTrackDedupeKey({ name: candidate.name, artist: candidate.artist });
    return key === normalizeMusicTrackToken(candidate.id)
      || key === normalizeMusicTrackToken(trackKey)
      || key === normalizeMusicTrackToken(candidate.name);
  }
  if (subjectType === 'artist') {
    const preferenceKeys = new Set(explicitArtistKeys(preference.subjectKey));
    return explicitArtistKeys(candidate.artist).some((candidateKey) => preferenceKeys.has(candidateKey));
  }
  return candidate.evidence.some((evidence) => normalizeMusicTrackToken(evidence).includes(key));
}

function primaryArtist(artists: string[]): string {
  return artists[0]?.trim() ?? '';
}

function round(value: number): number {
  return Number(value.toFixed(4));
}
