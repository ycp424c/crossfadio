import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface DjV2ReplayEpisodeInput {
  episodeId: string;
  userId: string;
  trackId: string;
  primaryArtistId?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  positionMs: number;
  listenedMs: number;
  outcome: 'completed' | 'skipped' | 'failed' | 'interrupted';
  protocolVersion: number;
}

export interface DjV2ReplaySelectionRunInput {
  runId: string;
  userId: string;
  startedAt: number;
  completedAt: number;
  selectedTrackIds: string[];
  candidateCount: number;
  eligibleCount: number;
  appendedCount: number;
  latencyMs: number;
  hardViolationCount: number;
  promptJsonStatus: 'not_observed' | 'valid' | 'invalid';
  journeyPublished: boolean;
  narrationStatus: 'not_applicable' | 'pending' | 'succeeded' | 'failed';
  narrationDeadlineAt?: number;
  outcome: 'succeeded' | 'failed' | 'empty';
  reasonCodes: string[];
}

export interface DjV2ReplayRetrievalAttemptInput {
  attemptId: string;
  runId?: string;
  userId: string;
  source: string;
  requestKind: 'autonomous' | 'explicit_request';
  normalizedQuery: string;
  attemptedAt: number;
  searchedCount: number;
  resultCount: number;
  addedCount: number;
  selectedCount: number;
}

export interface ReplayPressureInput {
  source: string;
  reasonCode: string;
  direction: 'boost' | 'penalty';
  amount: number;
  severity?: 'soft' | 'suppress';
  bypassed?: boolean;
  temporaryExcluded?: boolean;
}

export interface ReplayPolicyContextInput {
  explicitlyRequested: boolean;
  explicitTrackExcluded: boolean;
  explicitArtistExcluded: boolean;
  temporaryTrackExcluded: boolean;
  temporaryArtistExcluded: boolean;
  retrievalCooldown: boolean;
  queueContainsTrack: boolean;
  playedTrack: boolean;
}

export interface DjV2ReplayPolicyCaseInput {
  caseId: string;
  runId: string;
  userId: string;
  candidateId: string;
  candidateTrackKey: string;
  candidateArtistKey: string;
  mode: 'autonomous' | 'explicit_request';
  identityValid: boolean;
  source: string;
  qualitySignals: {
    popularity?: number;
    fee?: number;
    copyright?: number;
    noCopyrightRcmd?: boolean;
    privilegeSt?: number;
    privilegeToast?: boolean;
    originCoverType?: number;
    mv?: boolean;
    titlePollution?: 'none' | 'mild' | 'strong';
  };
  titleMotifKeys: string[];
  baseScore: number;
  batchIndex: number;
  batchLimit: number;
  context: ReplayPolicyContextInput;
  pressure: ReplayPressureInput[];
  expected: {
    admission: ReplayPhaseExpectationInput;
    recall: ReplayPhaseExpectationInput | null;
    ranking: (ReplayPhaseExpectationInput & {
      adjustedScore: number;
      contributions: ReplayPressureInput[];
    }) | null;
    batch: ReplayPhaseExpectationInput[] | null;
    final: ReplayPhaseExpectationInput | null;
    finalContext: ReplayPolicyContextInput | null;
  };
}

export interface ReplayPhaseExpectationInput {
  action: string;
  reasonCodes: string[];
}

export interface DjV2ReplayInput {
  episodes: DjV2ReplayEpisodeInput[];
  selectionRuns: DjV2ReplaySelectionRunInput[];
  retrievalAttempts: DjV2ReplayRetrievalAttemptInput[];
  policyCases?: DjV2ReplayPolicyCaseInput[];
}

export interface DjV2ReplayExportOptions {
  salt: string;
  timeShiftMs: number;
  nowMs?: number;
}

export interface DjV2ReplayFileOptions extends DjV2ReplayExportOptions {
  inputPath: string;
  outputPath: string;
}

function writeReplayFile(outputPath: string, exported: ReturnType<typeof exportDjV2Replay>): void {
  fs.writeFileSync(outputPath, `${JSON.stringify(exported, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

const ROOT_FIELDS = new Set(['episodes', 'selectionRuns', 'retrievalAttempts', 'policyCases']);
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
  'normalizedQuery',
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
const QUALITY_SIGNAL_ENUMS = {
  fee: new Set([0, 1, 4, 8]),
  copyright: new Set([0, 1, 2]),
  originCoverType: new Set([0, 1, 2]),
  titlePollution: new Set(['none', 'mild', 'strong'])
} as const;
const POLICY_CONTEXT_FIELDS = new Set([
  'explicitlyRequested', 'explicitTrackExcluded', 'explicitArtistExcluded',
  'temporaryTrackExcluded', 'temporaryArtistExcluded', 'retrievalCooldown',
  'queueContainsTrack', 'playedTrack'
]);
const PRESSURE_FIELDS = new Set([
  'source', 'reasonCode', 'direction', 'amount', 'severity', 'bypassed', 'temporaryExcluded'
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

const FORBIDDEN_KEY_PARTS = [
  'authorization',
  'chat',
  'cookie',
  'logbody',
  'logtext',
  'lyric',
  'message',
  'pdc',
  'personaldjcontext',
  'prompt',
  'rawlog',
  'secret',
  'token',
  'url',
];
const ALLOWED_MACHINE_KEYS = new Set(['promptjsonstatus']);
const FORBIDDEN_STRING_PATTERNS = [
  /(?:https?|wss?):\/\//i,
  /\bwww\./i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  /\b(?:cookie|set-cookie)\s*:/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const REPLAY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const REASON_CODE = /^[a-z][a-z0-9_]{0,79}$/;
const SOURCE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function assertNoForbiddenReplayContent(value: unknown, path = 'root'): void {
  if (typeof value === 'string') {
    if (FORBIDDEN_STRING_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error(`${path} contains forbidden content`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenReplayContent(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    const compactKey = normalizedKey(key);
    if (
      !ALLOWED_MACHINE_KEYS.has(compactKey)
      && FORBIDDEN_KEY_PARTS.some((part) => compactKey.includes(part))
    ) {
      throw new Error(`${path}.${key} is forbidden`);
    }
    assertNoForbiddenReplayContent(child, path === 'root' ? key : `${path}.${key}`);
  }
}

function assertKnownKeys(value: unknown, allowed: ReadonlySet<string>, path: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path || 'root'} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${path ? `${path}.` : ''}${key} is not allowed`);
    }
  }
}

function assertArray(value: unknown, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
}

function assertNonNegativeInteger(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
}

function assertWhitelistedFields(input: DjV2ReplayInput): void {
  assertKnownKeys(input, ROOT_FIELDS, '');
  assertArray(input.episodes, 'episodes');
  assertArray(input.selectionRuns, 'selectionRuns');
  assertArray(input.retrievalAttempts, 'retrievalAttempts');
  const policyCases = input.policyCases ?? [];
  assertArray(policyCases, 'policyCases');
  if (input.episodes.length > 1_000) {
    throw new Error('episodes exceeds maximum of 1000 records');
  }
  if (input.selectionRuns.length > 500) {
    throw new Error('selectionRuns exceeds maximum of 500 records');
  }
  if (input.retrievalAttempts.length > 1_000) {
    throw new Error('retrievalAttempts exceeds maximum of 1000 records');
  }
  if (policyCases.length > 2_000) throw new Error('policyCases exceeds maximum of 2000 records');
  input.episodes.forEach((episode, index) => {
    assertKnownKeys(episode, EPISODE_FIELDS, `episodes[${index}]`);
  });
  input.selectionRuns.forEach((run, index) => {
    assertKnownKeys(run, SELECTION_RUN_FIELDS, `selectionRuns[${index}]`);
  });
  input.retrievalAttempts.forEach((attempt, index) => {
    assertKnownKeys(attempt, RETRIEVAL_ATTEMPT_FIELDS, `retrievalAttempts[${index}]`);
  });
  policyCases.forEach((policyCase, index) => {
    const path = `policyCases[${index}]`;
    assertKnownKeys(policyCase, POLICY_CASE_FIELDS, path);
    assertKnownKeys(policyCase.qualitySignals, QUALITY_SIGNAL_FIELDS, `${path}.qualitySignals`);
    assertKnownKeys(policyCase.context, POLICY_CONTEXT_FIELDS, `${path}.context`);
    assertKnownKeys(policyCase.expected, EXPECTED_FIELDS, `${path}.expected`);
    assertPhaseExpectationKeys(policyCase.expected.admission, `${path}.expected.admission`);
    if (policyCase.expected.recall !== null) {
      assertPhaseExpectationKeys(policyCase.expected.recall, `${path}.expected.recall`);
    }
    if (policyCase.expected.ranking !== null) {
      assertKnownKeys(policyCase.expected.ranking, RANKING_EXPECTATION_FIELDS, `${path}.expected.ranking`);
      policyCase.expected.ranking.contributions.forEach((item, pressureIndex) => {
        assertKnownKeys(item, PRESSURE_FIELDS, `${path}.expected.ranking.contributions[${pressureIndex}]`);
      });
    }
    if (policyCase.expected.batch !== null) {
      policyCase.expected.batch.forEach((item, batchIndex) => {
        assertPhaseExpectationKeys(item, `${path}.expected.batch[${batchIndex}]`);
      });
    }
    if (policyCase.expected.final !== null) {
      assertPhaseExpectationKeys(policyCase.expected.final, `${path}.expected.final`);
    }
    if (policyCase.expected.finalContext !== null) {
      assertKnownKeys(
        policyCase.expected.finalContext,
        POLICY_CONTEXT_FIELDS,
        `${path}.expected.finalContext`
      );
    }
    policyCase.pressure.forEach((item, pressureIndex) => {
      assertKnownKeys(item, PRESSURE_FIELDS, `${path}.pressure[${pressureIndex}]`);
    });
  });
}

function assertPhaseExpectationKeys(value: ReplayPhaseExpectationInput, path: string): void {
  assertKnownKeys(value, PHASE_EXPECTATION_FIELDS, path);
}

function assertInputNumbers(input: DjV2ReplayInput): void {
  input.episodes.forEach((episode, index) => {
    const path = `episodes[${index}]`;
    assertNonNegativeInteger(episode.startedAt, `${path}.startedAt`);
    if (episode.endedAt !== undefined) assertNonNegativeInteger(episode.endedAt, `${path}.endedAt`);
    if (episode.durationMs !== undefined) {
      assertNonNegativeInteger(episode.durationMs, `${path}.durationMs`);
    }
    assertNonNegativeInteger(episode.positionMs, `${path}.positionMs`);
    assertNonNegativeInteger(episode.listenedMs, `${path}.listenedMs`);
    assertNonNegativeInteger(episode.protocolVersion, `${path}.protocolVersion`);
  });
  input.selectionRuns.forEach((run, index) => {
    const path = `selectionRuns[${index}]`;
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
    if (!['not_observed', 'valid', 'invalid'].includes(run.promptJsonStatus)) {
      throw new Error(`${path}.promptJsonStatus must be a known machine code`);
    }
    if (typeof run.journeyPublished !== 'boolean') {
      throw new Error(`${path}.journeyPublished must be a boolean`);
    }
  });
  input.retrievalAttempts.forEach((attempt, index) => {
    const path = `retrievalAttempts[${index}]`;
    assertNonNegativeInteger(attempt.attemptedAt, `${path}.attemptedAt`);
    for (const field of ['searchedCount', 'resultCount', 'addedCount', 'selectedCount'] as const) {
      assertNonNegativeInteger(attempt[field], `${path}.${field}`);
    }
  });
  (input.policyCases ?? []).forEach((policyCase, index) => {
    const path = `policyCases[${index}]`;
    if (typeof policyCase.identityValid !== 'boolean') {
      throw new Error(`${path}.identityValid must be a boolean`);
    }
    assertNonNegativeFinite(policyCase.baseScore, `${path}.baseScore`);
    assertNonNegativeInteger(policyCase.batchIndex, `${path}.batchIndex`);
    assertNonNegativeInteger(policyCase.batchLimit, `${path}.batchLimit`);
    assertArray(policyCase.titleMotifKeys, `${path}.titleMotifKeys`);
    assertArray(policyCase.pressure, `${path}.pressure`);
    for (const [field, value] of Object.entries(policyCase.context)) {
      if (typeof value !== 'boolean') throw new Error(`${path}.context.${field} must be a boolean`);
    }
    if ((policyCase.expected.final === null) !== (policyCase.expected.finalContext === null)) {
      throw new Error(`${path}.expected.final and finalContext must both be null or both be present`);
    }
    if (policyCase.expected.finalContext) {
      for (const [field, value] of Object.entries(policyCase.expected.finalContext)) {
        if (typeof value !== 'boolean') {
          throw new Error(`${path}.expected.finalContext.${field} must be a boolean`);
        }
      }
    }
    policyCase.pressure.forEach((item, pressureIndex) => {
      assertPressure(item, `${path}.pressure[${pressureIndex}]`);
    });
    assertExpectedPolicy(policyCase.expected, `${path}.expected`);
    assertSafeQualitySignals(policyCase.qualitySignals, `${path}.qualitySignals`);
  });
}

function assertCompletePolicyCaseCoverage(input: DjV2ReplayInput): void {
  const caseCounts = new Map<string, number>();
  for (const policyCase of input.policyCases ?? []) {
    const key = `${policyCase.userId}\0${policyCase.runId}`;
    caseCounts.set(key, (caseCounts.get(key) ?? 0) + 1);
  }
  input.selectionRuns.forEach((run, index) => {
    const actual = caseCounts.get(`${run.userId}\0${run.runId}`) ?? 0;
    if (actual !== run.candidateCount) {
      throw new Error(
        `selectionRuns[${index}] policy case coverage incomplete: expected ${run.candidateCount}, got ${actual}`
      );
    }
  });
}

function assertNonNegativeFinite(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative finite number`);
  }
}

function assertPressure(value: ReplayPressureInput, path: string): void {
  if (!SOURCE_CODE.test(value.source)) throw new Error(`${path}.source must be a stable machine code`);
  if (!REASON_CODE.test(value.reasonCode)) throw new Error(`${path}.reasonCode must be a stable machine code`);
  if (!['boost', 'penalty'].includes(value.direction)) {
    throw new Error(`${path}.direction must be a known machine code`);
  }
  if (value.severity !== undefined && !['soft', 'suppress'].includes(value.severity)) {
    throw new Error(`${path}.severity must be a known machine code`);
  }
  assertNonNegativeFinite(value.amount, `${path}.amount`);
  if (value.bypassed !== undefined && typeof value.bypassed !== 'boolean') {
    throw new Error(`${path}.bypassed must be a boolean`);
  }
  if (value.temporaryExcluded !== undefined && typeof value.temporaryExcluded !== 'boolean') {
    throw new Error(`${path}.temporaryExcluded must be a boolean`);
  }
}

function assertExpectedPolicy(value: DjV2ReplayPolicyCaseInput['expected'], path: string): void {
  assertPhaseExpectation(value.admission, `${path}.admission`);
  if (value.recall !== null) assertPhaseExpectation(value.recall, `${path}.recall`);
  if (value.ranking !== null) {
    assertPhaseExpectation(value.ranking, `${path}.ranking`);
    assertNonNegativeFinite(value.ranking.adjustedScore, `${path}.ranking.adjustedScore`);
    assertArray(value.ranking.contributions, `${path}.ranking.contributions`);
    value.ranking.contributions.forEach((item, index) => {
      assertPressure(item, `${path}.ranking.contributions[${index}]`);
    });
  }
  if (value.batch !== null) {
    assertArray(value.batch, `${path}.batch`);
    value.batch.forEach((item, index) => assertPhaseExpectation(item, `${path}.batch[${index}]`));
  }
  if (value.final !== null) assertPhaseExpectation(value.final, `${path}.final`);
}

function assertPhaseExpectation(value: ReplayPhaseExpectationInput, path: string): void {
  if (!SOURCE_CODE.test(value.action)) throw new Error(`${path}.action must be a stable machine code`);
  assertArray(value.reasonCodes, `${path}.reasonCodes`);
  value.reasonCodes.forEach((reasonCode, index) => {
    if (!REASON_CODE.test(reasonCode)) {
      throw new Error(`${path}.reasonCodes[${index}] must be a stable machine code`);
    }
  });
}

export function assertSafeQualitySignals(
  signals: DjV2ReplayPolicyCaseInput['qualitySignals'],
  path: string
): void {
  if (signals.popularity !== undefined && (
    typeof signals.popularity !== 'number'
    || !Number.isFinite(signals.popularity)
    || signals.popularity < 0
    || signals.popularity > 100
  )) throw new Error(`${path}.popularity must be between 0 and 100`);
  for (const key of ['fee', 'copyright', 'originCoverType'] as const) {
    const value = signals[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || !QUALITY_SIGNAL_ENUMS[key].has(value as never))) {
      throw new Error(`${path}.${key} must be a known enum value`);
    }
  }
  if (signals.privilegeSt !== undefined && (
    !Number.isSafeInteger(signals.privilegeSt)
    || signals.privilegeSt < -1_000
    || signals.privilegeSt > 1_000
  )) throw new Error(`${path}.privilegeSt must be an integer between -1000 and 1000`);
  for (const key of ['noCopyrightRcmd', 'privilegeToast', 'mv'] as const) {
    if (signals[key] !== undefined && typeof signals[key] !== 'boolean') {
      throw new Error(`${path}.${key} must be a boolean`);
    }
  }
  if (
    signals.titlePollution !== undefined
    && !QUALITY_SIGNAL_ENUMS.titlePollution.has(signals.titlePollution)
  ) throw new Error(`${path}.titlePollution must be a known enum value`);
}

function assertWithinReplayWindow(input: DjV2ReplayInput, nowMs: number): void {
  const cutoff = nowMs - REPLAY_WINDOW_MS;
  const assertTime = (value: number, path: string) => {
    if (value < cutoff || value > nowMs) {
      throw new Error(`${path} is outside the 30-day window`);
    }
  };

  input.episodes.forEach((episode, index) => {
    assertTime(episode.startedAt, `episodes[${index}].startedAt`);
  });
  input.selectionRuns.forEach((run, index) => {
    assertTime(run.startedAt, `selectionRuns[${index}].startedAt`);
  });
  input.retrievalAttempts.forEach((attempt, index) => {
    assertTime(attempt.attemptedAt, `retrievalAttempts[${index}].attemptedAt`);
  });
  (input.policyCases ?? []).forEach((policyCase, index) => {
    if (!CANDIDATE_SOURCES.has(policyCase.source)) {
      throw new Error(`policyCases[${index}].source must be a known candidate source`);
    }
    if (!['autonomous', 'explicit_request'].includes(policyCase.mode)) {
      throw new Error(`policyCases[${index}].mode must be a known machine code`);
    }
    policyCase.titleMotifKeys.forEach((motif, motifIndex) => {
      if (typeof motif !== 'string' || !TITLE_MOTIF_KEYS.has(motif)) {
        throw new Error(`policyCases[${index}].titleMotifKeys[${motifIndex}] must be a known machine code`);
      }
    });
  });
}

function assertSafeOutputStrings(input: DjV2ReplayInput): void {
  const episodeOutcomes = new Set(['completed', 'skipped', 'failed', 'interrupted']);
  const selectionOutcomes = new Set(['succeeded', 'failed', 'empty']);
  const requestKinds = new Set(['autonomous', 'explicit_request']);

  input.episodes.forEach((episode, index) => {
    if (!episodeOutcomes.has(episode.outcome)) {
      throw new Error(`episodes[${index}].outcome must be a known machine code`);
    }
  });
  input.selectionRuns.forEach((run, index) => {
    if (!selectionOutcomes.has(run.outcome)) {
      throw new Error(`selectionRuns[${index}].outcome must be a known machine code`);
    }
    if (!['not_applicable', 'pending', 'succeeded', 'failed'].includes(run.narrationStatus)) {
      throw new Error(`selectionRuns[${index}].narrationStatus must be a known machine code`);
    }
    run.reasonCodes.forEach((reasonCode, reasonIndex) => {
      if (!REASON_CODE.test(reasonCode)) {
        throw new Error(
          `selectionRuns[${index}].reasonCodes[${reasonIndex}] must be a stable machine code`,
        );
      }
    });
  });
  input.retrievalAttempts.forEach((attempt, index) => {
    if (!SOURCE_CODE.test(attempt.source)) {
      throw new Error(`retrievalAttempts[${index}].source must be a stable machine code`);
    }
    if (!requestKinds.has(attempt.requestKind)) {
      throw new Error(`retrievalAttempts[${index}].requestKind must be a known machine code`);
    }
  });
}

function hashId(namespace: string, value: string, salt: string): string {
  const digest = createHash('sha256')
    .update(salt)
    .update('\0')
    .update(namespace)
    .update('\0')
    .update(value)
    .digest('hex')
    .slice(0, 32);
  return `h_${digest}`;
}

function shiftTimestamp(value: number | undefined, offset: number): number | undefined {
  if (value === undefined) return undefined;
  const shifted = value + offset;
  if (!Number.isSafeInteger(shifted) || shifted < 0) {
    throw new Error('shifted timestamp must be a non-negative safe integer');
  }
  return shifted;
}

export function exportDjV2Replay(input: DjV2ReplayInput, options: DjV2ReplayExportOptions) {
  if (options.salt.length < 32) {
    throw new Error('salt must contain at least 32 characters');
  }
  if (!Number.isSafeInteger(options.timeShiftMs)) {
    throw new Error('timeShiftMs must be a safe integer');
  }
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('nowMs must be a non-negative safe integer');
  }
  assertNoForbiddenReplayContent(input);
  assertWhitelistedFields(input);
  assertSafeOutputStrings(input);
  assertInputNumbers(input);
  assertWithinReplayWindow(input, nowMs);
  assertCompletePolicyCaseCoverage(input);
  return {
    schemaVersion: 2 as const,
    episodes: input.episodes.map((episode) => ({
      ...episode,
      episodeId: hashId('episode', episode.episodeId, options.salt),
      userId: hashId('user', episode.userId, options.salt),
      trackId: hashId('track', episode.trackId, options.salt),
      primaryArtistId: episode.primaryArtistId
        ? hashId('artist', episode.primaryArtistId, options.salt)
        : undefined,
      startedAt: shiftTimestamp(episode.startedAt, options.timeShiftMs)!,
      endedAt: shiftTimestamp(episode.endedAt, options.timeShiftMs),
    })),
    selectionRuns: input.selectionRuns.map((run) => ({
      ...run,
      runId: hashId('run', run.runId, options.salt),
      userId: hashId('user', run.userId, options.salt),
      startedAt: shiftTimestamp(run.startedAt, options.timeShiftMs)!,
      completedAt: shiftTimestamp(run.completedAt, options.timeShiftMs)!,
      narrationDeadlineAt: shiftTimestamp(run.narrationDeadlineAt, options.timeShiftMs),
      selectedTrackIds: run.selectedTrackIds.map((trackId) => hashId('track', trackId, options.salt)),
    })),
    retrievalAttempts: input.retrievalAttempts.map(({ normalizedQuery, ...attempt }) => ({
      ...attempt,
      attemptId: hashId('attempt', attempt.attemptId, options.salt),
      runId: attempt.runId ? hashId('run', attempt.runId, options.salt) : undefined,
      userId: hashId('user', attempt.userId, options.salt),
      queryFingerprint: hashId('query', normalizedQuery, options.salt),
      attemptedAt: shiftTimestamp(attempt.attemptedAt, options.timeShiftMs)!,
    })),
    policyCases: (input.policyCases ?? []).map((policyCase) => ({
      ...policyCase,
      caseId: hashId('policy_case', policyCase.caseId, options.salt),
      runId: hashId('run', policyCase.runId, options.salt),
      userId: hashId('user', policyCase.userId, options.salt),
      candidateId: hashId('track', policyCase.candidateId, options.salt),
      candidateTrackKey: hashId('track_key', policyCase.candidateTrackKey, options.salt),
      candidateArtistKey: hashId('artist', policyCase.candidateArtistKey, options.salt)
    }))
  };
}

export function exportDjV2ReplayFile(options: DjV2ReplayFileOptions) {
  const input = JSON.parse(fs.readFileSync(options.inputPath, 'utf8')) as DjV2ReplayInput;
  const exported = exportDjV2Replay(input, options);
  writeReplayFile(options.outputPath, exported);
  return exported;
}

function cliArgument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

export function runExportDjV2ReplayCli(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): void {
  const inputPath = cliArgument(argv, '--input') ?? '-';
  const outputPath = cliArgument(argv, '--output');
  const shiftRaw = cliArgument(argv, '--shift-ms');
  const salt = env.DJ_V2_REPLAY_SALT;

  if (!outputPath || !shiftRaw) {
    throw new Error(
      'usage: export-dj-v2-replay --input <path|-> --output <path> --shift-ms <integer>',
    );
  }
  if (!salt) throw new Error('DJ_V2_REPLAY_SALT is required');
  const timeShiftMs = Number(shiftRaw);
  if (!Number.isSafeInteger(timeShiftMs)) throw new Error('--shift-ms must be a safe integer');
  if (timeShiftMs === 0) throw new Error('--shift-ms must be non-zero');

  const rawJson = fs.readFileSync(inputPath === '-' ? 0 : inputPath, 'utf8');
  const input = JSON.parse(rawJson) as DjV2ReplayInput;
  const exported = exportDjV2Replay(input, { salt, timeShiftMs });
  writeReplayFile(outputPath, exported);
  process.stdout.write(`wrote sanitized replay to ${outputPath}\n`);
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
  try {
    runExportDjV2ReplayCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
