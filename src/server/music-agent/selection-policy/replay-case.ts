import { candidateTitleMotifKeys, selectDiverseBatch } from './batch.js';
import { evaluateAdmission } from './admission.js';
import { evaluateRanking } from './ranking.js';
import { evaluateRecall } from './recall.js';
import { isCurrentExplicitRequest, matchesExclusion, toSelectionPolicyCandidate } from './types.js';
import { scoreCandidateForRanking, type RankCandidatesOptions } from '../rank.js';
import { hasValidTrackIdentity } from '../playback-eligibility.js';
import type {
  CandidateSource,
  MusicCandidate,
  MusicCandidateQualitySignals
} from '../schema.js';
import type {
  SelectionPhaseDecision,
  SelectionPolicyContext,
  SelectionPressureContribution
} from './types.js';

export type ReplayPressureContribution = {
  source: SelectionPressureContribution['source'];
  reasonCode: SelectionPressureContribution['reasonCode'];
  direction: SelectionPressureContribution['direction'];
  amount: number;
  severity?: NonNullable<SelectionPressureContribution['severity']>;
  bypassed?: boolean;
  temporaryExcluded?: boolean;
};

export type ReplayPhaseExpectation = {
  action: SelectionPhaseDecision['action'];
  reasonCodes: SelectionPhaseDecision['reasonCodes'];
};

export type ReplayRankingExpectation = ReplayPhaseExpectation & {
  adjustedScore: number;
  contributions: ReplayPressureContribution[];
};

export type SelectionPolicyReplayContext = {
  explicitlyRequested: boolean;
  explicitTrackExcluded: boolean;
  explicitArtistExcluded: boolean;
  temporaryTrackExcluded: boolean;
  temporaryArtistExcluded: boolean;
  retrievalCooldown: boolean;
  queueContainsTrack: boolean;
  playedTrack: boolean;
};

export type SelectionPolicyReplayCase = {
  candidateId: string;
  candidateTrackKey: string;
  candidateArtistKey: string;
  identityValid: boolean;
  source: CandidateSource;
  qualitySignals: MusicCandidateQualitySignals;
  titleMotifKeys: string[];
  baseScore: number;
  batchIndex: number;
  batchLimit: number;
  context: SelectionPolicyReplayContext;
  pressure: ReplayPressureContribution[];
  expected: {
    admission: ReplayPhaseExpectation;
    recall: ReplayPhaseExpectation | null;
    ranking: ReplayRankingExpectation | null;
    batch: ReplayPhaseExpectation[] | null;
    final: ReplayPhaseExpectation | null;
    finalContext: SelectionPolicyReplayContext | null;
  };
};

export function buildSelectionPolicyReplayCases(input: {
  candidates: MusicCandidate[];
  context: SelectionPolicyContext;
  batchLimit: number;
  pressureForCandidate?: (candidate: MusicCandidate) => SelectionPressureContribution[];
  rankingOptions?: RankCandidatesOptions;
}): SelectionPolicyReplayCase[] {
  const evaluated = input.candidates.map((track, inputIndex) => {
    const candidate = toSelectionPolicyCandidate(track);
    const breakdown = scoreCandidateForRanking(track, input.rankingOptions ?? {
      mode: input.context.mode,
      explicitlyRequested: input.context.explicitlyRequested,
      ...(input.context.explicitRequest ? { explicitRequest: input.context.explicitRequest } : {}),
      pressureForCandidate: input.pressureForCandidate
    });
    const pressure = cloneReplayPressure(breakdown.pressureContributions);
    const admission = evaluateAdmission({ candidate, context: input.context });
    const recall = admission.action === 'admit'
      ? evaluateRecall({ candidate, context: input.context, pressure: restoreReplayPressure(pressure) })
      : null;
    const ranking = recall?.action === 'include'
      ? evaluateRanking({
          candidate,
          context: input.context,
          baseScore: breakdown.baseScore,
          pressure: restoreReplayPressure(pressure)
        })
      : null;
    return { track, candidate, pressure, admission, recall, ranking, breakdown, inputIndex };
  });
  const ranked = evaluated
    .filter((item): item is typeof item & { ranking: NonNullable<typeof item.ranking> } => item.ranking !== null)
    .sort((left, right) => right.ranking.adjustedScore - left.ranking.adjustedScore || left.inputIndex - right.inputIndex);
  const batchDecisions = new Map<string, ReplayPhaseExpectation[]>();
  selectDiverseBatch(
    ranked.map((item) => item.track),
    input.batchLimit,
    {
      recordDecision: (track, decision) => {
        const existing = batchDecisions.get(track.id) ?? [];
        existing.push(phaseExpectation(decision));
        batchDecisions.set(track.id, existing);
      }
    }
  );
  const batchIndex = new Map(ranked.map((item, index) => [item.track.id, index]));

  return evaluated.map((item) => ({
    candidateId: item.track.id,
    candidateTrackKey: item.candidate.trackKey,
    candidateArtistKey: item.candidate.primaryArtist,
    identityValid: hasValidTrackIdentity(item.track),
    source: item.track.sources[0]!,
    qualitySignals: replayQualitySignals(item.track.qualitySignals),
    titleMotifKeys: candidateTitleMotifKeys(item.track),
    baseScore: item.breakdown.baseScore,
    batchIndex: batchIndex.get(item.track.id) ?? input.candidates.length + item.inputIndex,
    batchLimit: Math.max(0, Math.trunc(input.batchLimit)),
    context: selectionPolicyReplayContext(item.candidate, input.context),
    pressure: item.pressure,
    expected: {
      admission: phaseExpectation(item.admission),
      recall: item.recall ? phaseExpectation(item.recall) : null,
      ranking: item.ranking ? {
        ...phaseExpectation(item.ranking),
        adjustedScore: item.ranking.adjustedScore,
        contributions: cloneReplayPressure(item.ranking.contributions)
      } : null,
      batch: batchIndex.has(item.track.id) ? batchDecisions.get(item.track.id) ?? null : null,
      // Final is authoritative only at the live queue-mutation boundary. It is
      // deliberately backfilled after that gate has actually executed.
      final: null,
      finalContext: null
    }
  }));
}

export function restoreReplayPressure(
  pressure: ReplayPressureContribution[]
): SelectionPressureContribution[] {
  return pressure.map((item) => ({
    source: item.source,
    reasonCode: item.reasonCode,
    direction: item.direction,
    amount: item.amount,
    ...(item.severity ? { severity: item.severity } : {}),
    ...(item.bypassed !== undefined ? { bypassed: item.bypassed } : {}),
    ...(item.temporaryExcluded !== undefined
      ? { evidence: { temporaryExcluded: item.temporaryExcluded } }
      : {})
  }));
}

function cloneReplayPressure(
  pressure: readonly SelectionPressureContribution[]
): ReplayPressureContribution[] {
  return pressure.map((item) => ({
    source: item.source,
    reasonCode: item.reasonCode,
    direction: item.direction,
    amount: item.amount,
    ...(item.severity ? { severity: item.severity } : {}),
    ...(item.bypassed !== undefined ? { bypassed: item.bypassed } : {}),
    ...(typeof item.evidence?.temporaryExcluded === 'boolean'
      ? { temporaryExcluded: item.evidence.temporaryExcluded }
      : {})
  }));
}

function phaseExpectation(decision: SelectionPhaseDecision): ReplayPhaseExpectation {
  return { action: decision.action, reasonCodes: [...decision.reasonCodes] };
}

export function selectionPolicyReplayContext(
  candidate: ReturnType<typeof toSelectionPolicyCandidate>,
  context: SelectionPolicyContext
): SelectionPolicyReplayContext {
  const explicit = matchesExclusion(candidate, context.explicitExclusions);
  const temporary = matchesExclusion(candidate, context.temporaryExclusions);
  return {
    explicitlyRequested: isCurrentExplicitRequest(context, candidate),
    explicitTrackExcluded: explicit === 'track',
    explicitArtistExcluded: explicit === 'artist',
    temporaryTrackExcluded: temporary === 'track',
    temporaryArtistExcluded: temporary === 'artist',
    retrievalCooldown: context.retrievalCooldownTrackKeys?.has(candidate.trackKey) ?? false,
    queueContainsTrack: context.queue?.tracks.some((track) => (
      track.id === candidate.track.id
      || (track.trackKey.length > 0 && track.trackKey === candidate.trackKey)
    )) ?? false,
    playedTrack: context.playedTrackIds?.has(candidate.track.id)
      || context.playedTrackKeys?.has(candidate.trackKey)
      || false
  };
}

function replayQualitySignals(
  input: MusicCandidateQualitySignals | undefined
): MusicCandidateQualitySignals {
  if (!input) return {};
  return {
    ...(input.popularity !== undefined ? { popularity: input.popularity } : {}),
    ...(input.fee !== undefined ? { fee: input.fee } : {}),
    ...(input.copyright !== undefined ? { copyright: input.copyright } : {}),
    ...(input.noCopyrightRcmd !== undefined ? { noCopyrightRcmd: input.noCopyrightRcmd } : {}),
    ...(input.privilegeSt !== undefined ? { privilegeSt: input.privilegeSt } : {}),
    ...(input.privilegeToast !== undefined ? { privilegeToast: input.privilegeToast } : {}),
    ...(input.originCoverType !== undefined ? { originCoverType: input.originCoverType } : {}),
    ...(input.mv !== undefined ? { mv: input.mv } : {}),
    ...(input.titlePollution !== undefined ? { titlePollution: input.titlePollution } : {})
  };
}
