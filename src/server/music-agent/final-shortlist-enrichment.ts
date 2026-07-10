import type { NcmLyric } from '../../shared/schema.js';
import { extractTagsFromWikiSummary } from '../agent/segue-context.js';
import type { NcmRequestOptions } from '../ncm/client.js';
import {
  getMusicTrackAnalysisCaches,
  recordMusicTrackLyricRefresh,
  saveMusicTrackSemanticProfile,
  type MusicTrackAnalysisCacheRecord
} from '../store/music-track-analysis-cache.js';
import {
  createUnknownLyricEvidence,
  prepareLyricEvidence,
  type PreparedLyricEvidence
} from './lyric-evidence.js';
import type { MusicAgentContextSummary, MusicCandidate } from './schema.js';
import {
  trackAssessmentSchema,
  type FinalShortlistEnrichmentDiagnostics,
  type LyricsSelectionMode,
  type ShortlistBasePromptPacket,
  type ShortlistPromptPacket,
  type TrackAssessment
} from './track-understanding.js';

const MAX_SHORTLIST_SIZE = 12;
const MAX_CANDIDATE_CONCURRENCY = 6;
const MAX_PER_MISS_LYRIC_CHARS = 3_000;
const MISSING_LYRIC_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const PROFILE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export type FinalShortlistEnrichmentResult = {
  shortlist: MusicCandidate[];
  promptPackets: ShortlistPromptPacket[];
  expectedLyricVersions: ExpectedLyricVersion[];
  diagnostics: FinalShortlistEnrichmentDiagnostics;
};

export type ExpectedLyricVersion = {
  id: string;
  lyricHash: string | null;
  lyricRefreshedAt: string;
};

export type FinalShortlistEnricher = (
  candidates: MusicCandidate[],
  options?: { signal?: AbortSignal; requestScope?: string }
) => Promise<FinalShortlistEnrichmentResult>;

export type PersistTrackAssessmentsInput = {
  assessments: TrackAssessment[];
  enrichment: FinalShortlistEnrichmentResult;
  context?: MusicAgentContextSummary;
};

export type TrackAssessmentPersister = (
  input: PersistTrackAssessmentsInput
) => Promise<void> | void;

export type FinalShortlistNcmClient = {
  getLyric(id: string, options?: NcmRequestOptions): Promise<NcmLyric | null>;
  getSongWikiSummary(
    id: string,
    options?: NcmRequestOptions
  ): Promise<Record<string, unknown> | null>;
};

export type CreateFinalShortlistEnricherOptions = {
  ncmClient: FinalShortlistNcmClient;
  mode: LyricsSelectionMode;
  analyzerVersion: string;
  analysisModel: string;
  shortlistSize?: number;
  maxConcurrency?: number;
  deadlineMs?: number;
  maxLyricEvidenceChars?: number;
  now?: () => number;
};

export function createFinalShortlistAssessmentPersister({
  analyzerVersion,
  analysisModel
}: {
  analyzerVersion: string;
  analysisModel: string;
}): TrackAssessmentPersister {
  return ({ assessments, enrichment, context }) => {
    const packetsById = new Map(enrichment.promptPackets.map((packet) => [packet.id, packet]));
    const expectedById = new Map(enrichment.expectedLyricVersions.map((item) => [item.id, item]));
    for (const assessment of assessments) {
      const packet = packetsById.get(assessment.id);
      if (packet?.kind !== 'evidence') continue;
      const expected = expectedById.get(assessment.id);
      if (!expected) continue;
      const sanitized = sanitizeAssessment(assessment, packet, context);
      const saved = saveMusicTrackSemanticProfile({
        provider: 'ncm',
        trackId: assessment.id,
        analyzerVersion,
        analysisModel,
        lyricHash: expected.lyricHash,
        lyricRefreshedAt: expected.lyricRefreshedAt,
        profile: sanitized.profile,
        confidence: assessment.confidence,
        evidence: sanitized.evidence,
        extractionSummary: stableExtractionSummary(packet)
      });
      if (!saved) enrichment.diagnostics.cacheWriteFailed += 1;
    }
  };
}

function sanitizeAssessment(
  assessment: TrackAssessment,
  packet: Extract<ShortlistPromptPacket, { kind: 'evidence' }>,
  context: MusicAgentContextSummary | undefined
): TrackAssessment {
  const rawText = packet.lyricEvidence.sampledLines
    .flatMap((line) => [line.text, line.translation])
    .filter((value): value is string => Boolean(value))
    .map(normalizedText)
    .filter(Boolean);
  const contextText = collectContextStrings(context).map(normalizedText).filter(Boolean);
  const safe = (value: string): boolean => isSafeStableText(value, rawText, contextText);
  return {
    ...assessment,
    profile: {
      ...assessment.profile,
      genres: assessment.profile.genres.filter(safe),
      moods: assessment.profile.moods.filter(safe),
      lyricThemes: assessment.profile.lyricThemes.filter(safe),
      language: safe(assessment.profile.language) ? assessment.profile.language : 'unknown'
    },
    evidence: assessment.evidence.filter(({ claim }) => safe(claim))
  };
}

function isSafeStableText(value: string, rawText: string[], contextText: string[]): boolean {
  const trimmed = value.trim();
  const normalized = normalizedText(trimmed);
  if (!trimmed
    || /[\r\n]/.test(trimmed)
    || /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/.test(trimmed)
    || /[“”"「」『』]/.test(trimmed)) return false;
  const overlapsRaw = rawText.some((source) =>
    normalized === source
    || (normalized.length >= 2 && source.length >= 2
      && (source.includes(normalized) || normalized.includes(source)))
  );
  if (overlapsRaw) return false;
  return !contextText.some((source) => {
    if (normalized === source) return true;
    return normalized.length >= 8
      && source.length >= 8
      && (source.includes(normalized) || normalized.includes(source));
  });
}

function collectContextStrings(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(collectContextStrings);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap(collectContextStrings);
}

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function stableExtractionSummary(
  packet: Extract<ShortlistPromptPacket, { kind: 'evidence' }>
): Record<string, unknown> {
  const evidence = packet.lyricEvidence;
  return {
    lyricStatus: evidence.lyricStatus,
    sampleMode: evidence.sampleMode,
    lineCount: evidence.lineCount,
    hasTranslation: evidence.hasTranslation,
    repeatedHookCount: evidence.repeatedHookCount,
    sampledCharCount: evidence.sampledCharCount,
    creditRoleCount: Object.values(evidence.credits).filter((names) => names.length > 0).length,
    wikiTags: packet.wikiTags.slice(0, 8)
  };
}

export function createFinalShortlistEnricher({
  ncmClient,
  mode,
  analyzerVersion,
  analysisModel: _analysisModel,
  shortlistSize = MAX_SHORTLIST_SIZE,
  maxConcurrency = MAX_CANDIDATE_CONCURRENCY,
  deadlineMs = 2_500,
  maxLyricEvidenceChars = 36_000,
  now = Date.now
}: CreateFinalShortlistEnricherOptions): FinalShortlistEnricher {
  const boundedShortlistSize = clampInteger(shortlistSize, 0, MAX_SHORTLIST_SIZE);
  const boundedConcurrency = clampInteger(maxConcurrency, 1, MAX_CANDIDATE_CONCURRENCY);
  const boundedDeadlineMs = Math.max(0, finiteNumber(deadlineMs, 2_500));
  const boundedEvidenceChars = Math.max(0, Math.floor(finiteNumber(maxLyricEvidenceChars, 36_000)));
  const requestSemaphore = new RequestSemaphore(boundedConcurrency);
  const defaultRequestScope = `enricher-instance:${nextEnricherScope += 1}`;

  return async (candidates, options = {}) => {
    const requestScope = options.requestScope?.trim() || defaultRequestScope;
    const startedAt = now();
    const shortlist = candidates.slice(0, boundedShortlistSize);
    const diagnostics = emptyDiagnostics(shortlist.length);
    const promptPackets: ShortlistPromptPacket[] = shortlist.map(basePacket);
    const expectedLyricVersions = new Map<string, ExpectedLyricVersion>();

    const result = (): FinalShortlistEnrichmentResult => ({
      shortlist,
      promptPackets,
      expectedLyricVersions: [...expectedLyricVersions.values()],
      diagnostics
    });

    if (mode === 'off' || shortlist.length === 0) {
      diagnostics.elapsedMs = elapsedMs(startedAt, now());
      return result();
    }

    const cachedById = getMusicTrackAnalysisCaches('ncm', shortlist.map((candidate) => candidate.id));
    const misses: Array<{ candidate: MusicCandidate; packetIndex: number; cached: MusicTrackAnalysisCacheRecord | null }> = [];

    shortlist.forEach((candidate, packetIndex) => {
      const cached = cachedById.get(candidate.id) ?? null;
      const assessment = cachedAssessment(candidate.id, cached, analyzerVersion, now());
      if (assessment) {
        diagnostics.cacheHits += 1;
        promptPackets[packetIndex] = {
          ...packetFacts(candidate),
          kind: 'profile',
          assessment
        };
        return;
      }

      diagnostics.cacheMisses += 1;
      misses.push({ candidate, packetIndex, cached });
    });

    if (misses.length === 0 || options.signal?.aborted) {
      diagnostics.elapsedMs = elapsedMs(startedAt, now());
      return result();
    }

    const lyricCharBudget = Math.min(
      MAX_PER_MISS_LYRIC_CHARS,
      Math.floor(boundedEvidenceChars / misses.length)
    );
    const deadlineController = new AbortController();
    let deadlineReached = false;
    const onParentAbort = () => deadlineController.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => {
      deadlineReached = true;
      deadlineController.abort(new Error('final shortlist enrichment deadline reached'));
    }, boundedDeadlineMs);

    try {
      let nextIndex = 0;
      const enrichOne = async (item: typeof misses[number]): Promise<void> => {
        if (deadlineController.signal.aborted) return;
        const candidateAbort = createLinkedAbortSignal(deadlineController.signal);

        const cachedMissing = isFreshMissingCache(item.cached, now());
        const loadLyricEvidence = async (): Promise<{
          evidence: PreparedLyricEvidence;
          settled: boolean;
        }> => {
          if (cachedMissing) {
            diagnostics.lyricMissing += 1;
            if (item.cached?.lastLyricRefreshAt) {
              expectedLyricVersions.set(item.candidate.id, {
                id: item.candidate.id,
                lyricHash: item.cached.lyricHash,
                lyricRefreshedAt: item.cached.lastLyricRefreshAt
              });
            }
            return {
              evidence: prepareLyricEvidence(null, { charBudget: lyricCharBudget }),
              settled: true
            };
          }

          let lyric: NcmLyric | null;
          try {
            lyric = await sharedFinalShortlistSingleFlight.run(
              `${requestScope}:lyric:ncm:${item.candidate.id}`,
              candidateAbort.signal,
              () => { diagnostics.lyricAttempted += 1; },
              (sharedSignal) => requestSemaphore.run(
                sharedSignal,
                () => globalFinalShortlistRequestSemaphore.run(
                  sharedSignal,
                  () => ncmClient.getLyric(
                    item.candidate.id,
                    requestOptions(sharedSignal, boundedDeadlineMs)
                  )
                )
              )
            );
          } catch (error) {
            if (error instanceof NcmRequestNotStartedError) {
              return { evidence: createUnknownLyricEvidence(), settled: false };
            }
            if (error instanceof CallerWaitCancelledError && deadlineReached) {
              diagnostics.lyricTimeout += 1;
            } else if (error instanceof CallerWaitCancelledError && options.signal?.aborted) {
              diagnostics.lyricCancelled += 1;
            } else if (deadlineReached) diagnostics.lyricTimeout += 1;
            else diagnostics.lyricFail += 1;
            return { evidence: createUnknownLyricEvidence(), settled: false };
          }

          const lyricEvidence = prepareLyricEvidence(lyric, { charBudget: lyricCharBudget });
          if (lyricEvidence.lyricStatus === 'available') diagnostics.lyricSuccess += 1;
          else diagnostics.lyricMissing += 1;
          diagnostics.sampledChars += lyricEvidence.sampledCharCount;
          try {
            const refreshedAt = new Date(now()).toISOString();
            recordMusicTrackLyricRefresh({
              provider: 'ncm',
              trackId: item.candidate.id,
              lyricStatus: lyricEvidence.lyricStatus,
              lyricHash: lyricEvidence.lyricStatus === 'available' ? lyricEvidence.lyricHash : null,
              extractionSummary: extractionSummary(lyricEvidence),
              refreshedAt
            });
            expectedLyricVersions.set(item.candidate.id, {
              id: item.candidate.id,
              lyricHash: lyricEvidence.lyricStatus === 'available' ? lyricEvidence.lyricHash : null,
              lyricRefreshedAt: refreshedAt
            });
          } catch {
            diagnostics.cacheWriteFailed += 1;
          }
          return { evidence: lyricEvidence, settled: true };
        };

        const loadWikiTags = async (): Promise<{ tags: string[]; settled: boolean }> => {
          try {
            const wikiSummary = await sharedFinalShortlistSingleFlight.run(
              `${requestScope}:wiki:ncm:${item.candidate.id}`,
              candidateAbort.signal,
              () => { diagnostics.wikiAttempted += 1; },
              (sharedSignal) => requestSemaphore.run(
                sharedSignal,
                () => globalFinalShortlistRequestSemaphore.run(
                  sharedSignal,
                  () => ncmClient.getSongWikiSummary(
                    item.candidate.id,
                    requestOptions(sharedSignal, boundedDeadlineMs)
                  )
                )
              )
            );
            diagnostics.wikiSuccess += 1;
            return { tags: extractTagsFromWikiSummary(wikiSummary), settled: true };
          } catch (error) {
            if (error instanceof NcmRequestNotStartedError) {
              return { tags: [], settled: false };
            }
            if (error instanceof CallerWaitCancelledError && deadlineReached) {
              diagnostics.wikiTimeout += 1;
            } else if (error instanceof CallerWaitCancelledError && options.signal?.aborted) {
              diagnostics.wikiCancelled += 1;
            } else if (deadlineReached) diagnostics.wikiTimeout += 1;
            else diagnostics.wikiFail += 1;
            return { tags: [], settled: false };
          }
        };

        const [lyricOutcome, wikiOutcome] = await Promise.all([
          loadLyricEvidence(),
          loadWikiTags()
        ]).finally(candidateAbort.dispose);

        if (!lyricOutcome.settled && !wikiOutcome.settled) return;

        promptPackets[item.packetIndex] = {
          ...packetFacts(item.candidate),
          kind: 'evidence',
          lyricEvidence: lyricOutcome.evidence,
          wikiTags: wikiOutcome.tags
        };
      };

      const worker = async (): Promise<void> => {
        while (!deadlineController.signal.aborted) {
          const itemIndex = nextIndex;
          nextIndex += 1;
          const item = misses[itemIndex];
          if (!item) return;
          await enrichOne(item);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(boundedConcurrency, misses.length) }, () => worker())
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onParentAbort);
    }

    diagnostics.deadlineReached = deadlineReached;
    diagnostics.elapsedMs = elapsedMs(startedAt, now());
    return result();
  };
}

function packetFacts(candidate: MusicCandidate) {
  return {
    id: candidate.id,
    name: candidate.name,
    artist: candidate.artist,
    sources: candidate.sources,
    ...(candidate.qualitySignals ? { qualitySignals: candidate.qualitySignals } : {})
  };
}

function basePacket(candidate: MusicCandidate): ShortlistBasePromptPacket {
  return { ...packetFacts(candidate), kind: 'base' };
}

function cachedAssessment(
  id: string,
  cached: MusicTrackAnalysisCacheRecord | null,
  analyzerVersion: string,
  nowMs: number
): TrackAssessment | null {
  const profileTtlMs = cached?.lyricStatus === 'available'
    ? PROFILE_CACHE_TTL_MS
    : cached?.lyricStatus === 'missing'
      ? MISSING_LYRIC_CACHE_TTL_MS
      : 0;
  if (
    !cached ||
    cached.analyzerVersion !== analyzerVersion ||
    cached.profile === null ||
    cached.confidence === null ||
    profileTtlMs === 0 ||
    !isFreshTimestamp(cached.lastLyricRefreshAt, nowMs, profileTtlMs)
  ) {
    return null;
  }
  const parsed = trackAssessmentSchema.safeParse({
    id,
    profile: cached.profile,
    confidence: cached.confidence,
    evidence: cached.evidence
  });
  return parsed.success ? parsed.data : null;
}

function isFreshMissingCache(cached: MusicTrackAnalysisCacheRecord | null, nowMs: number): boolean {
  if (cached?.lyricStatus !== 'missing' || !cached.lastLyricRefreshAt) return false;
  return isFreshTimestamp(cached.lastLyricRefreshAt, nowMs, MISSING_LYRIC_CACHE_TTL_MS);
}

function isFreshTimestamp(timestamp: string | null, nowMs: number, ttlMs: number): boolean {
  if (!timestamp) return false;
  const timestampMs = Date.parse(timestamp);
  const ageMs = nowMs - timestampMs;
  return Number.isFinite(timestampMs) && ageMs >= 0 && ageMs < ttlMs;
}

function extractionSummary(evidence: PreparedLyricEvidence): Record<string, unknown> {
  const creditRoleCounts = Object.fromEntries(
    Object.entries(evidence.credits)
      .filter(([, names]) => names.length > 0)
      .map(([role, names]) => [role, names.length])
  );
  return {
    lyricStatus: evidence.lyricStatus,
    sampleMode: evidence.sampleMode,
    creditRoleCounts,
    lineCount: evidence.lineCount,
    hasTranslation: evidence.hasTranslation,
    repeatedHookCount: evidence.repeatedHookCount,
    sampledCharCount: evidence.sampledCharCount
  };
}

function requestOptions(signal: AbortSignal, deadlineMs: number): NcmRequestOptions {
  return {
    signal,
    timeoutMs: Math.max(1, Math.floor(deadlineMs))
  };
}

function waitForCaller<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new CallerWaitCancelledError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CallerWaitCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function createLinkedAbortSignal(parent: AbortSignal): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) onAbort();
  else parent.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => parent.removeEventListener('abort', onAbort)
  };
}

function emptyDiagnostics(shortlistCount: number): FinalShortlistEnrichmentDiagnostics {
  return {
    shortlistCount,
    cacheHits: 0,
    cacheMisses: 0,
    lyricAttempted: 0,
    lyricSuccess: 0,
    lyricMissing: 0,
    lyricFail: 0,
    lyricTimeout: 0,
    lyricCancelled: 0,
    wikiAttempted: 0,
    wikiSuccess: 0,
    wikiFail: 0,
    wikiTimeout: 0,
    wikiCancelled: 0,
    cacheWriteFailed: 0,
    sampledChars: 0,
    elapsedMs: 0,
    deadlineReached: false
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(finiteNumber(value, minimum))));
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function elapsedMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, finishedAt - startedAt);
}

class NcmRequestNotStartedError extends Error {
  constructor() {
    super('NCM request was aborted before acquiring a concurrency slot');
    this.name = 'NcmRequestNotStartedError';
  }
}

class CallerWaitCancelledError extends Error {
  constructor() {
    super('Final shortlist enrichment caller stopped waiting');
    this.name = 'CallerWaitCancelledError';
  }
}

type SemaphoreWaiter = {
  signal: AbortSignal;
  resolve: () => void;
  reject: (error: NcmRequestNotStartedError) => void;
  onAbort: () => void;
};

class RequestSemaphore {
  private active = 0;
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new NcmRequestNotStartedError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new NcmRequestNotStartedError());
        }
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.active -= 1;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(new NcmRequestNotStartedError());
        continue;
      }
      this.active += 1;
      waiter.resolve();
      return;
    }
  }
}

type SingleFlightWaiter = {
  onStarted: () => void;
};

type SingleFlightEntry<T> = {
  controller: AbortController;
  promise: Promise<T>;
  settled: boolean;
  waiters: Set<SingleFlightWaiter>;
};

class SingleFlightRequestCoordinator {
  private readonly inFlight = new Map<string, SingleFlightEntry<unknown>>();

  run<T>(
    key: string,
    callerSignal: AbortSignal,
    onStarted: () => void,
    request: (sharedSignal: AbortSignal) => Promise<T>
  ): Promise<T> {
    let entry = this.inFlight.get(key) as SingleFlightEntry<T> | undefined;
    if (!entry) {
      entry = this.createEntry(key, request);
    }

    const waiter: SingleFlightWaiter = { onStarted };
    entry.waiters.add(waiter);
    return waitForCaller(entry.promise, callerSignal).finally(() => {
      entry!.waiters.delete(waiter);
      if (entry!.waiters.size === 0 && !entry!.settled) {
        entry!.controller.abort(new CallerWaitCancelledError());
      }
    });
  }

  private createEntry<T>(
    key: string,
    request: (sharedSignal: AbortSignal) => Promise<T>
  ): SingleFlightEntry<T> {
    const controller = new AbortController();
    const entry: SingleFlightEntry<T> = {
      controller,
      promise: Promise.resolve(undefined as T) as Promise<T>,
      settled: false,
      waiters: new Set<SingleFlightWaiter>()
    };

    entry.promise = Promise.resolve().then(() => {
      const diagnosticsOwner = entry.waiters.values().next().value;
      diagnosticsOwner?.onStarted();
      return request(controller.signal);
    });
    this.inFlight.set(key, entry as SingleFlightEntry<unknown>);
    void entry.promise.then(
      () => this.settleEntry(key, entry),
      () => this.settleEntry(key, entry)
    );
    return entry;
  }

  private settleEntry<T>(key: string, entry: SingleFlightEntry<T>): void {
    entry.settled = true;
    if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
  }
}

let nextEnricherScope = 0;
const globalFinalShortlistRequestSemaphore = new RequestSemaphore(MAX_CANDIDATE_CONCURRENCY);
const sharedFinalShortlistSingleFlight = new SingleFlightRequestCoordinator();
