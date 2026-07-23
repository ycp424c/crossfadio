import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  assertNoForbiddenReplayContent,
  assertSafeQualitySignals,
  type ReplayPhaseExpectationInput,
  type exportDjV2Replay,
} from './export-dj-v2-replay.js';
import { deriveListeningSignals } from '../src/server/listening/listening-signals.js';
import { evaluateAdmission } from '../src/server/music-agent/selection-policy/admission.js';
import { evaluateRecall } from '../src/server/music-agent/selection-policy/recall.js';
import { evaluateRanking } from '../src/server/music-agent/selection-policy/ranking.js';
import { selectDiverseBatch } from '../src/server/music-agent/selection-policy/batch.js';
import { evaluateFinal } from '../src/server/music-agent/selection-policy/final.js';
import {
  cloneReplayPressure,
  restoreReplayPressure
} from '../src/server/music-agent/selection-policy/replay-case.js';
import type { MusicCandidate } from '../src/server/music-agent/schema.js';
import type {
  SelectionPolicyCandidate,
  SelectionPolicyContext
} from '../src/server/music-agent/selection-policy/types.js';

type CurrentDjV2ReplayDataset = ReturnType<typeof exportDjV2Replay>;
export type DjV2ReplayDataset = Omit<CurrentDjV2ReplayDataset, 'schemaVersion'> & {
  schemaVersion: 2 | 3;
};

const HASHED_ID = /^h_[a-f0-9]{32}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{0,79}$/;
const SOURCE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const EPISODE_OUTCOMES = new Set(['completed', 'skipped', 'failed', 'interrupted']);
const SELECTION_OUTCOMES = new Set(['succeeded', 'failed', 'empty']);
const REQUEST_KINDS = new Set(['autonomous', 'explicit_request']);
const ROOT_FIELDS = new Set(['schemaVersion', 'episodes', 'selectionRuns', 'retrievalAttempts', 'policyCases']);
const EPISODE_FIELDS = new Set([
  'episodeId',
  'userId',
  'trackId',
  'primaryArtistId',
  'startedAt',
  'endedAt',
  'durationMs',
  'positionMs',
  'listenedMs',
  'outcome',
  'protocolVersion',
]);
const SELECTION_RUN_FIELDS = new Set([
  'runId',
  'userId',
  'startedAt',
  'completedAt',
  'selectedTrackIds',
  'candidateCount',
  'eligibleCount',
  'appendedCount',
  'latencyMs',
  'hardViolationCount',
  'promptJsonStatus',
  'journeyPublished',
  'narrationStatus',
  'narrationDeadlineAt',
  'outcome',
  'reasonCodes',
]);
const RETRIEVAL_ATTEMPT_FIELDS = new Set([
  'attemptId',
  'runId',
  'userId',
  'source',
  'requestKind',
  'queryFingerprint',
  'attemptedAt',
  'searchedCount',
  'resultCount',
  'addedCount',
  'selectedCount',
]);
const POLICY_CASE_FIELDS = new Set([
  'caseId', 'runId', 'userId', 'candidateId', 'candidateTrackKey', 'candidateArtistKey',
  'mode', 'identityValid', 'source', 'qualitySignals', 'titleMotifKeys',
  'baseScore', 'batchIndex', 'batchLimit', 'context', 'pressure', 'expected'
]);
const QUALITY_SIGNAL_FIELDS = new Set([
  'popularity', 'fee', 'copyright', 'noCopyrightRcmd', 'privilegeSt',
  'privilegeToast', 'originCoverType', 'mv', 'titlePollution'
]);
const POLICY_CONTEXT_FIELDS = new Set([
  'explicitlyRequested', 'explicitTrackExcluded', 'explicitArtistExcluded',
  'temporaryTrackExcluded', 'temporaryArtistExcluded', 'retrievalCooldown',
  'queueContainsTrack', 'playedTrack', 'rotationCurrentRound',
  'rotationLastSelectedRound', 'rotationRoundDistance',
  'rotationSelectionsInWindow', 'rotationSuppressed'
]);
const PRESSURE_FIELDS = new Set([
  'source', 'reasonCode', 'direction', 'amount', 'severity', 'bypassed',
  'temporaryExcluded', 'currentRound', 'lastSelectedRound', 'roundDistance',
  'hardRounds', 'softRounds', 'selectionsInWindow'
]);
const EXPECTED_FIELDS = new Set([
  'admission', 'recall', 'ranking', 'batch', 'final', 'finalContext'
]);
const PHASE_EXPECTATION_FIELDS = new Set(['action', 'reasonCodes']);
const RANKING_EXPECTATION_FIELDS = new Set([
  'action', 'reasonCodes', 'adjustedScore', 'contributions'
]);
const CANDIDATE_SOURCES = new Set(['liked', 'playlist', 'search', 'style_expansion', 'trend']);
const TITLE_MOTIF_KEYS = new Set(['afternoon']);

function assertObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not allowed`);
  }
}

function assertArray(value: unknown, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
}

function assertHashedId(value: unknown, path: string): void {
  if (typeof value !== 'string' || !HASHED_ID.test(value)) {
    throw new Error(`${path} must be a hashed identifier`);
  }
}

function assertNonNegativeInteger(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
}

export function assertValidDjV2ReplayDataset(value: unknown): asserts value is DjV2ReplayDataset {
  assertNoForbiddenReplayContent(value);
  assertObject(value, 'root');
  assertKnownKeys(value, ROOT_FIELDS, 'root');
  if (value.schemaVersion !== 2 && value.schemaVersion !== 3) {
    throw new Error('schemaVersion must be 2 or 3');
  }
  assertArray(value.episodes, 'episodes');
  assertArray(value.selectionRuns, 'selectionRuns');
  assertArray(value.retrievalAttempts, 'retrievalAttempts');
  assertArray(value.policyCases, 'policyCases');
  if (value.episodes.length > 1_000) throw new Error('episodes exceeds maximum of 1000 records');
  if (value.selectionRuns.length > 500) {
    throw new Error('selectionRuns exceeds maximum of 500 records');
  }
  if (value.retrievalAttempts.length > 1_000) {
    throw new Error('retrievalAttempts exceeds maximum of 1000 records');
  }
  if (value.policyCases.length > 2_000) throw new Error('policyCases exceeds maximum of 2000 records');

  value.episodes.forEach((episode, index) => {
    const path = `episodes[${index}]`;
    assertObject(episode, path);
    assertKnownKeys(episode, EPISODE_FIELDS, path);
    assertHashedId(episode.episodeId, `${path}.episodeId`);
    assertHashedId(episode.userId, `${path}.userId`);
    assertHashedId(episode.trackId, `${path}.trackId`);
    if (episode.primaryArtistId !== undefined) {
      assertHashedId(episode.primaryArtistId, `${path}.primaryArtistId`);
    }
    assertNonNegativeInteger(episode.startedAt, `${path}.startedAt`);
    if (episode.endedAt !== undefined) assertNonNegativeInteger(episode.endedAt, `${path}.endedAt`);
    if (episode.durationMs !== undefined) {
      assertNonNegativeInteger(episode.durationMs, `${path}.durationMs`);
    }
    assertNonNegativeInteger(episode.positionMs, `${path}.positionMs`);
    assertNonNegativeInteger(episode.listenedMs, `${path}.listenedMs`);
    assertNonNegativeInteger(episode.protocolVersion, `${path}.protocolVersion`);
    if (typeof episode.outcome !== 'string' || !EPISODE_OUTCOMES.has(episode.outcome)) {
      throw new Error(`${path}.outcome must be a known machine code`);
    }
  });

  value.selectionRuns.forEach((run, index) => {
    const path = `selectionRuns[${index}]`;
    assertObject(run, path);
    assertKnownKeys(run, SELECTION_RUN_FIELDS, path);
    assertHashedId(run.runId, `${path}.runId`);
    assertHashedId(run.userId, `${path}.userId`);
    assertArray(run.selectedTrackIds, `${path}.selectedTrackIds`);
    run.selectedTrackIds.forEach((trackId, trackIndex) => {
      assertHashedId(trackId, `${path}.selectedTrackIds[${trackIndex}]`);
    });
    assertArray(run.reasonCodes, `${path}.reasonCodes`);
    run.reasonCodes.forEach((reasonCode, reasonIndex) => {
      if (typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode)) {
        throw new Error(`${path}.reasonCodes[${reasonIndex}] must be a stable machine code`);
      }
    });
    assertNonNegativeInteger(run.startedAt, `${path}.startedAt`);
    assertNonNegativeInteger(run.completedAt, `${path}.completedAt`);
    if (run.completedAt < run.startedAt) {
      throw new Error(`${path}.completedAt must be greater than or equal to startedAt`);
    }
    if (run.narrationDeadlineAt !== undefined) {
      assertNonNegativeInteger(run.narrationDeadlineAt, `${path}.narrationDeadlineAt`);
    }
    for (const field of [
      'candidateCount',
      'eligibleCount',
      'appendedCount',
      'latencyMs',
      'hardViolationCount',
    ] as const) {
      assertNonNegativeInteger(run[field], `${path}.${field}`);
    }
    if (!['not_observed', 'valid', 'invalid'].includes(String(run.promptJsonStatus))) {
      throw new Error(`${path}.promptJsonStatus must be a known machine code`);
    }
    if (typeof run.journeyPublished !== 'boolean') {
      throw new Error(`${path}.journeyPublished must be a boolean`);
    }
    if (!['not_applicable', 'pending', 'succeeded', 'failed'].includes(String(run.narrationStatus))) {
      throw new Error(`${path}.narrationStatus must be a known machine code`);
    }
    if (typeof run.outcome !== 'string' || !SELECTION_OUTCOMES.has(run.outcome)) {
      throw new Error(`${path}.outcome must be a known machine code`);
    }
  });

  value.retrievalAttempts.forEach((attempt, index) => {
    const path = `retrievalAttempts[${index}]`;
    assertObject(attempt, path);
    assertKnownKeys(attempt, RETRIEVAL_ATTEMPT_FIELDS, path);
    assertHashedId(attempt.attemptId, `${path}.attemptId`);
    if (attempt.runId !== undefined) assertHashedId(attempt.runId, `${path}.runId`);
    assertHashedId(attempt.userId, `${path}.userId`);
    assertHashedId(attempt.queryFingerprint, `${path}.queryFingerprint`);
    if (typeof attempt.source !== 'string' || !SOURCE_CODE.test(attempt.source)) {
      throw new Error(`${path}.source must be a stable machine code`);
    }
    if (typeof attempt.requestKind !== 'string' || !REQUEST_KINDS.has(attempt.requestKind)) {
      throw new Error(`${path}.requestKind must be a known machine code`);
    }
    assertNonNegativeInteger(attempt.attemptedAt, `${path}.attemptedAt`);
    for (const field of ['searchedCount', 'resultCount', 'addedCount', 'selectedCount'] as const) {
      assertNonNegativeInteger(attempt[field], `${path}.${field}`);
    }
  });
  value.policyCases.forEach((policyCase, index) => {
    const path = `policyCases[${index}]`;
    assertObject(policyCase, path);
    assertKnownKeys(policyCase, POLICY_CASE_FIELDS, path);
    for (const field of [
      'caseId', 'runId', 'userId', 'candidateId', 'candidateTrackKey', 'candidateArtistKey'
    ] as const) assertHashedId(policyCase[field], `${path}.${field}`);
    if (!['autonomous', 'explicit_request'].includes(String(policyCase.mode))) {
      throw new Error(`${path}.mode must be a known machine code`);
    }
    if (!CANDIDATE_SOURCES.has(String(policyCase.source))) {
      throw new Error(`${path}.source must be a known candidate source`);
    }
    assertObject(policyCase.qualitySignals, `${path}.qualitySignals`);
    assertKnownKeys(policyCase.qualitySignals, QUALITY_SIGNAL_FIELDS, `${path}.qualitySignals`);
    assertSafeQualitySignals(policyCase.qualitySignals, `${path}.qualitySignals`);
    if (typeof policyCase.identityValid !== 'boolean') throw new Error(`${path}.identityValid must be a boolean`);
    assertNonNegativeNumber(policyCase.baseScore, `${path}.baseScore`);
    assertNonNegativeInteger(policyCase.batchIndex, `${path}.batchIndex`);
    assertNonNegativeInteger(policyCase.batchLimit, `${path}.batchLimit`);
    assertArray(policyCase.titleMotifKeys, `${path}.titleMotifKeys`);
    policyCase.titleMotifKeys.forEach((motif, motifIndex) => {
      if (typeof motif !== 'string' || !TITLE_MOTIF_KEYS.has(motif)) {
        throw new Error(`${path}.titleMotifKeys[${motifIndex}] must be a known machine code`);
      }
    });
    assertObject(policyCase.context, `${path}.context`);
    assertKnownKeys(policyCase.context, POLICY_CONTEXT_FIELDS, `${path}.context`);
    assertReplayPolicyContext(policyCase.context, `${path}.context`);
    assertArray(policyCase.pressure, `${path}.pressure`);
    policyCase.pressure.forEach((item, pressureIndex) => {
      assertReplayPressure(item, `${path}.pressure[${pressureIndex}]`);
    });
    assertObject(policyCase.expected, `${path}.expected`);
    assertKnownKeys(policyCase.expected, EXPECTED_FIELDS, `${path}.expected`);
    assertExpectedPolicy(policyCase.expected, `${path}.expected`);
    if ((policyCase.expected.final === null) !== (policyCase.expected.finalContext === null)) {
      throw new Error(`${path}.expected.final and finalContext must both be null or both be present`);
    }
    if (policyCase.expected.finalContext !== null) {
      assertObject(policyCase.expected.finalContext, `${path}.expected.finalContext`);
      assertKnownKeys(
        policyCase.expected.finalContext,
        POLICY_CONTEXT_FIELDS,
        `${path}.expected.finalContext`
      );
      assertReplayPolicyContext(policyCase.expected.finalContext, `${path}.expected.finalContext`);
    }
  });
}

function assertNonNegativeNumber(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative finite number`);
  }
}

function assertReplayPressure(value: unknown, path: string): void {
  assertObject(value, path);
  assertKnownKeys(value, PRESSURE_FIELDS, path);
  if (typeof value.source !== 'string' || !SOURCE_CODE.test(value.source)) {
    throw new Error(`${path}.source must be a stable machine code`);
  }
  if (typeof value.reasonCode !== 'string' || !REASON_CODE.test(value.reasonCode)) {
    throw new Error(`${path}.reasonCode must be a stable machine code`);
  }
  if (!['boost', 'penalty'].includes(String(value.direction))) {
    throw new Error(`${path}.direction must be a known machine code`);
  }
  if (value.severity !== undefined && !['soft', 'suppress'].includes(String(value.severity))) {
    throw new Error(`${path}.severity must be a known machine code`);
  }
  assertNonNegativeNumber(value.amount, `${path}.amount`);
  if (value.bypassed !== undefined && typeof value.bypassed !== 'boolean') {
    throw new Error(`${path}.bypassed must be a boolean`);
  }
  if (value.temporaryExcluded !== undefined && typeof value.temporaryExcluded !== 'boolean') {
    throw new Error(`${path}.temporaryExcluded must be a boolean`);
  }
  for (const field of [
    'currentRound',
    'lastSelectedRound',
    'roundDistance',
    'hardRounds',
    'softRounds',
    'selectionsInWindow'
  ]) {
    if (value[field] !== undefined) assertNonNegativeInteger(value[field], `${path}.${field}`);
  }
}

function assertReplayPolicyContext(value: Record<string, unknown>, path: string): void {
  for (const field of [
    'explicitlyRequested',
    'explicitTrackExcluded',
    'explicitArtistExcluded',
    'temporaryTrackExcluded',
    'temporaryArtistExcluded',
    'retrievalCooldown',
    'queueContainsTrack',
    'playedTrack'
  ]) {
    if (typeof value[field] !== 'boolean') throw new Error(`${path}.${field} must be a boolean`);
  }
  if (value.rotationSuppressed !== undefined && typeof value.rotationSuppressed !== 'boolean') {
    throw new Error(`${path}.rotationSuppressed must be a boolean`);
  }
  if (value.rotationCurrentRound !== undefined) {
    assertNonNegativeInteger(value.rotationCurrentRound, `${path}.rotationCurrentRound`);
  }
  if (value.rotationSelectionsInWindow !== undefined) {
    assertNonNegativeInteger(value.rotationSelectionsInWindow, `${path}.rotationSelectionsInWindow`);
  }
  for (const field of ['rotationLastSelectedRound', 'rotationRoundDistance']) {
    if (value[field] !== undefined && value[field] !== null) {
      assertNonNegativeInteger(value[field], `${path}.${field}`);
    }
  }
}

function assertExpectedPolicy(value: Record<string, unknown>, path: string): void {
  assertPhaseExpectation(value.admission, `${path}.admission`);
  if (value.recall !== null) assertPhaseExpectation(value.recall, `${path}.recall`);
  if (value.ranking !== null) {
    assertObject(value.ranking, `${path}.ranking`);
    assertKnownKeys(value.ranking, RANKING_EXPECTATION_FIELDS, `${path}.ranking`);
    assertPhaseExpectation(value.ranking, `${path}.ranking`, RANKING_EXPECTATION_FIELDS);
    assertNonNegativeNumber(value.ranking.adjustedScore, `${path}.ranking.adjustedScore`);
    assertArray(value.ranking.contributions, `${path}.ranking.contributions`);
    value.ranking.contributions.forEach((item, index) => {
      assertReplayPressure(item, `${path}.ranking.contributions[${index}]`);
    });
  }
  if (value.batch !== null) {
    assertArray(value.batch, `${path}.batch`);
    value.batch.forEach((item, index) => assertPhaseExpectation(item, `${path}.batch[${index}]`));
  }
  if (value.final !== null) assertPhaseExpectation(value.final, `${path}.final`);
}

function assertPhaseExpectation(
  value: unknown,
  path: string,
  allowedFields: ReadonlySet<string> = PHASE_EXPECTATION_FIELDS
): void {
  assertObject(value, path);
  assertKnownKeys(value, allowedFields, path);
  if (typeof value.action !== 'string' || !SOURCE_CODE.test(value.action)) {
    throw new Error(`${path}.action must be a stable machine code`);
  }
  assertArray(value.reasonCodes, `${path}.reasonCodes`);
  value.reasonCodes.forEach((reasonCode, index) => {
    if (typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode)) {
      throw new Error(`${path}.reasonCodes[${index}] must be a stable machine code`);
    }
  });
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[index]!;
}

export function replayDjV2(dataset: DjV2ReplayDataset) {
  assertValidDjV2ReplayDataset(dataset);
  const policyReplay = replayCurrentSelectionPolicy(dataset);
  const narrationEligibleRuns = dataset.selectionRuns.filter((run) => (
    run.narrationStatus === 'succeeded' || run.narrationStatus === 'failed'
  ));
  const promptObservedRuns = dataset.selectionRuns.filter((run) => (
    run.promptJsonStatus !== 'not_observed'
  ));
  const successfulRuns = dataset.selectionRuns.filter((run) => run.appendedCount > 0).length;
  return {
    schemaVersion: dataset.schemaVersion,
    counts: {
      episodes: dataset.episodes.length,
      selectionRuns: dataset.selectionRuns.length,
      retrievalAttempts: dataset.retrievalAttempts.length,
      policyCases: dataset.policyCases.length,
    },
    baseline: {
      hardViolationCount: policyReplay.hardViolationCount + dataset.selectionRuns.reduce(
        (total, run) => total + run.hardViolationCount,
        0,
      ),
      queueSuccessRate:
        dataset.selectionRuns.length === 0 ? null : successfulRuns / dataset.selectionRuns.length,
      p95LatencyMs: percentile95(dataset.selectionRuns.map((run) => run.latencyMs)),
      promptJsonValidityRate: promptObservedRuns.length === 0
        ? null
        : promptObservedRuns.filter((run) => run.promptJsonStatus === 'valid').length
          / promptObservedRuns.length,
      journeyAvailabilityRate: dataset.selectionRuns.length === 0
        ? null
        : dataset.selectionRuns.filter((run) => run.journeyPublished).length / dataset.selectionRuns.length,
      narrationSuccessWithin24hRate: narrationEligibleRuns.length === 0
        ? null
        : narrationEligibleRuns.filter((run) => run.narrationStatus === 'succeeded').length
          / narrationEligibleRuns.length,
    },
    policyReplay
  };
}

function replayCurrentSelectionPolicy(dataset: DjV2ReplayDataset) {
  let decisionMismatchCount = 0;
  let hardViolationCount = 0;
  const phaseExecutions = { admission: 0, recall: 0, ranking: 0, batch: 0, final: 0 };
  const phaseMismatchCounts = { admission: 0, recall: 0, ranking: 0, batch: 0, final: 0 };
  const casesByRun = new Map<string, DjV2ReplayDataset['policyCases']>();
  for (const policyCase of dataset.policyCases) {
    const runKey = selectionPolicyRunKey(policyCase);
    const cases = casesByRun.get(runKey) ?? [];
    cases.push(policyCase);
    casesByRun.set(runKey, cases);
  }
  const runsWithIncompletePolicyCases = dataset.selectionRuns.filter((run) => (
    (casesByRun.get(selectionPolicyRunKey(run))?.length ?? 0) !== run.candidateCount
  )).length;

  const mismatch = (phase: keyof typeof phaseMismatchCounts): void => {
    phaseMismatchCounts[phase] += 1;
    decisionMismatchCount += 1;
  };

  for (const runCases of casesByRun.values()) {
    const evaluated = runCases.map((policyCase) => {
      const track = replayTrack(policyCase);
      const candidate = replayCandidate(policyCase, track);
      const context = replayContext(policyCase);
      const pressure = restoreReplayPressure(policyCase.pressure);
      const admission = evaluateAdmission({ candidate, context });
      phaseExecutions.admission += 1;
      if (!sameExpectation(admission, policyCase.expected.admission)) mismatch('admission');
      if (policyCase.expected.admission.action === 'reject' && admission.action !== 'reject') {
        hardViolationCount += 1;
      }

      const recall = admission.action === 'admit'
        ? evaluateRecall({ candidate, context, pressure })
        : null;
      if (recall) phaseExecutions.recall += 1;
      if (!sameOptionalExpectation(recall, policyCase.expected.recall)) mismatch('recall');

      const ranking = recall?.action === 'include'
        ? evaluateRanking({ candidate, context, baseScore: policyCase.baseScore, pressure })
        : null;
      if (ranking) phaseExecutions.ranking += 1;
      if (!sameRankingExpectation(ranking, policyCase.expected.ranking)) mismatch('ranking');
      return { policyCase, track, candidate, context, ranking };
    });

    const ranked = evaluated
      .filter((item): item is typeof item & { ranking: NonNullable<typeof item.ranking> } => item.ranking !== null)
      .sort((left, right) => (
        right.ranking.adjustedScore - left.ranking.adjustedScore
        || left.policyCase.batchIndex - right.policyCase.batchIndex
      ));
    const actualBatch = new Map<string, ReplayPhaseExpectationInput[]>();
    const batchLimit = runCases[0]?.batchLimit ?? 0;
    selectDiverseBatch(ranked.map((item) => item.track), batchLimit, {
      recordDecision: (track, decision) => {
        phaseExecutions.batch += 1;
        const decisions = actualBatch.get(track.id) ?? [];
        decisions.push({ action: decision.action, reasonCodes: [...decision.reasonCodes] });
        actualBatch.set(track.id, decisions);
      }
    });
    for (const item of evaluated) {
      const actualBatchDecisions = item.ranking ? actualBatch.get(item.track.id) ?? null : null;
      if (!sameExpectationList(actualBatchDecisions, item.policyCase.expected.batch)) mismatch('batch');
      const final = item.policyCase.expected.finalContext
        ? evaluateFinal({
            candidate: item.candidate,
            context: replayContext(item.policyCase, item.policyCase.expected.finalContext)
          })
        : null;
      if (final) phaseExecutions.final += 1;
      if (!sameOptionalExpectation(final, item.policyCase.expected.final)) mismatch('final');
      if (item.policyCase.expected.final?.action === 'reject' && final?.action === 'select') {
        hardViolationCount += 1;
      }
    }
  }
  return {
    decisionMismatchCount,
    hardViolationCount,
    runsWithIncompletePolicyCases,
    phaseExecutions,
    phaseMismatchCounts
  };
}

function selectionPolicyRunKey(value: { userId: string; runId: string }): string {
  return `${value.userId}\0${value.runId}`;
}

type ReplayPolicyCase = DjV2ReplayDataset['policyCases'][number];

function replayTrack(policyCase: ReplayPolicyCase): MusicCandidate {
  const motifName = policyCase.titleMotifKeys.includes('afternoon') ? 'afternoon track' : 'valid track';
  return {
    id: policyCase.candidateId,
    name: policyCase.identityValid ? `${motifName} ${policyCase.candidateId}` : '',
    artist: policyCase.candidateArtistKey,
    sources: [policyCase.source],
    evidence: [],
    scores: {
      intentMatch: 0.5, tasteMatch: 0.5, timeFit: 0.5,
      contextFit: 0.5, novelty: 0.5, sourceConfidence: 0.5
    },
    qualitySignals: { ...policyCase.qualitySignals }
  };
}

function replayCandidate(
  policyCase: ReplayPolicyCase,
  track: MusicCandidate
): SelectionPolicyCandidate {
  return {
    track,
    trackKey: policyCase.candidateTrackKey,
    primaryArtist: policyCase.candidateArtistKey,
    artistKeys: [policyCase.candidateArtistKey]
  };
}

function replayContext(
  policyCase: ReplayPolicyCase,
  context = policyCase.context
): SelectionPolicyContext {
  return {
    mode: policyCase.mode,
    explicitlyRequested: context.explicitlyRequested,
    explicitExclusions: {
      trackIds: context.explicitTrackExcluded ? new Set([policyCase.candidateId]) : new Set(),
      artistKeys: context.explicitArtistExcluded ? new Set([policyCase.candidateArtistKey]) : new Set()
    },
    temporaryExclusions: {
      trackIds: context.temporaryTrackExcluded ? new Set([policyCase.candidateId]) : new Set(),
      artistKeys: context.temporaryArtistExcluded ? new Set([policyCase.candidateArtistKey]) : new Set()
    },
    retrievalCooldownTrackKeys: context.retrievalCooldown
      ? new Set([policyCase.candidateTrackKey])
      : new Set(),
    queue: {
      currentIndex: 0,
      tracks: context.queueContainsTrack ? [{
        id: policyCase.candidateId,
        trackKey: policyCase.candidateTrackKey,
        primaryArtist: policyCase.candidateArtistKey
      }] : []
    },
    playedTrackIds: context.playedTrack ? new Set([policyCase.candidateId]) : new Set(),
    playedTrackKeys: context.playedTrack ? new Set([policyCase.candidateTrackKey]) : new Set(),
    rotation: {
      currentRound: context.rotationCurrentRound ?? 0,
      tracks: context.rotationLastSelectedRound == null ? [] : [{
        trackKey: policyCase.candidateTrackKey,
        lastSelectedRound: context.rotationLastSelectedRound,
        selectionsInWindow: context.rotationSelectionsInWindow ?? 0
      }]
    }
  };
}

function sameExpectation(
  actual: { action: string; reasonCodes: readonly string[] },
  expected: ReplayPhaseExpectationInput
): boolean {
  return actual.action === expected.action
    && JSON.stringify(actual.reasonCodes) === JSON.stringify(expected.reasonCodes);
}

function sameOptionalExpectation(
  actual: { action: string; reasonCodes: readonly string[] } | null,
  expected: ReplayPhaseExpectationInput | null
): boolean {
  return actual === null || expected === null
    ? actual === null && expected === null
    : sameExpectation(actual, expected);
}

function sameRankingExpectation(
  actual: ReturnType<typeof evaluateRanking> | null,
  expected: ReplayPolicyCase['expected']['ranking']
): boolean {
  if (actual === null || expected === null) return actual === null && expected === null;
  const actualContributions = cloneReplayPressure(actual.contributions);
  return sameExpectation(actual, expected)
    && actual.adjustedScore === expected.adjustedScore
    && JSON.stringify(actualContributions) === JSON.stringify(expected.contributions);
}

function sameExpectationList(
  actual: ReplayPhaseExpectationInput[] | null,
  expected: ReplayPhaseExpectationInput[] | null
): boolean {
  if (actual === null || expected === null) return actual === null && expected === null;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function assertReplayReleaseGates(
  current: ReturnType<typeof replayDjV2>,
  baseline: ReturnType<typeof replayDjV2>
) {
  const failures: string[] = [];
  if (current.policyReplay.runsWithIncompletePolicyCases !== 0) {
    failures.push('policy_case_coverage_incomplete');
  }
  if (baseline.policyReplay.runsWithIncompletePolicyCases !== 0) {
    failures.push('baseline_policy_case_coverage_incomplete');
  }
  if (current.policyReplay.decisionMismatchCount !== 0) failures.push('policy_decision_mismatch');
  if (baseline.policyReplay.decisionMismatchCount !== 0) {
    failures.push('baseline_policy_decision_mismatch');
  }
  if (baseline.policyReplay.hardViolationCount !== 0) {
    failures.push('baseline_policy_hard_violation');
  }
  if (current.baseline.hardViolationCount !== 0) failures.push('hard_violation_count_nonzero');
  if (
    current.baseline.queueSuccessRate === null
    || baseline.baseline.queueSuccessRate === null
    || current.baseline.queueSuccessRate < baseline.baseline.queueSuccessRate
  ) failures.push('queue_success_rate_regressed');
  if (
    current.baseline.p95LatencyMs === null
    || baseline.baseline.p95LatencyMs === null
    || current.baseline.p95LatencyMs > baseline.baseline.p95LatencyMs * 1.15
  ) failures.push('p95_latency_regressed_over_15_percent');
  if (
    current.baseline.promptJsonValidityRate !== null
    && current.baseline.promptJsonValidityRate !== 1
  ) failures.push('prompt_json_validity_below_100_percent');
  if (current.baseline.journeyAvailabilityRate !== 1) {
    failures.push('journey_availability_below_100_percent');
  }
  if (
    current.baseline.narrationSuccessWithin24hRate === null
    || current.baseline.narrationSuccessWithin24hRate < 0.98
  ) {
    failures.push('narration_success_within_24h_below_98_percent');
  }
  if (failures.length > 0) {
    throw new Error(`DJ_V2_RELEASE_GATE_FAILED:${failures.join(',')}`);
  }
  return { passed: true as const, failures: [] as string[] };
}

export function replayListeningFeedback(dataset: DjV2ReplayDataset) {
  assertValidDjV2ReplayDataset(dataset);
  const manualSkips = dataset.episodes.filter((episode) => episode.outcome === 'skipped');
  let earlySkipNegativeCount = 0;
  let midpointOrLaterSkipCount = 0;
  let unknownDurationSkipCount = 0;

  for (const episode of manualSkips) {
    const durationMs = episode.durationMs && episode.durationMs > 0
      ? episode.durationMs
      : null;
    if (durationMs === null) {
      unknownDurationSkipCount += 1;
      continue;
    }
    const signals = deriveListeningSignals({
      outcome: 'skipped',
      durationMs,
      positionMs: episode.positionMs,
      listenedMs: episode.listenedMs
    });
    if (signals.earlySkip) earlySkipNegativeCount += 1;
    else midpointOrLaterSkipCount += 1;
  }

  return {
    manualSkipCount: manualSkips.length,
    earlySkipNegativeCount,
    midpointOrLaterSkipCount,
    unknownDurationSkipCount
  };
}

export function runReplayDjV2Cli(argv = process.argv.slice(2)): void {
  const inputIndex = argv.indexOf('--input');
  const inputPath = inputIndex === -1 ? undefined : argv[inputIndex + 1];
  const baselineIndex = argv.indexOf('--baseline');
  const baselinePath = baselineIndex === -1 ? undefined : argv[baselineIndex + 1];
  if (!inputPath || !baselinePath) {
    throw new Error('usage: replay-dj-v2 --input <sanitized-replay.json> --baseline <baseline-replay.json>');
  }

  const dataset = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as DjV2ReplayDataset;
  const baselineDataset = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as DjV2ReplayDataset;
  const current = replayDjV2(dataset);
  const baseline = replayDjV2(baselineDataset);
  const releaseGates = assertReplayReleaseGates(current, baseline);
  process.stdout.write(`${JSON.stringify({ current, baseline, releaseGates }, null, 2)}\n`);
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
  try {
    runReplayDjV2Cli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
