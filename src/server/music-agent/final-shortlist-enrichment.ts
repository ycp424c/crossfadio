import type { NcmLyric } from '../../shared/schema.js';
import { extractTagsFromWikiSummary } from '../agent/segue-context.js';
import type { NcmRequestOptions } from '../ncm/client.js';
import {
  getMusicTrackAnalysisCaches,
  recordMusicTrackLyricRefresh,
  type MusicTrackAnalysisCacheRecord
} from '../store/music-track-analysis-cache.js';
import { prepareLyricEvidence, type PreparedLyricEvidence } from './lyric-evidence.js';
import type { MusicCandidate } from './schema.js';
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

export type FinalShortlistEnrichmentResult = {
  shortlist: MusicCandidate[];
  promptPackets: ShortlistPromptPacket[];
  diagnostics: FinalShortlistEnrichmentDiagnostics;
};

export type FinalShortlistEnricher = (
  candidates: MusicCandidate[],
  options?: { signal?: AbortSignal }
) => Promise<FinalShortlistEnrichmentResult>;

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

  return async (candidates, options = {}) => {
    const startedAt = now();
    const shortlist = candidates.slice(0, boundedShortlistSize);
    const diagnostics = emptyDiagnostics(shortlist.length);
    const promptPackets: ShortlistPromptPacket[] = shortlist.map(basePacket);

    if (mode === 'off' || shortlist.length === 0) {
      diagnostics.elapsedMs = elapsedMs(startedAt, now());
      return { shortlist, promptPackets, diagnostics };
    }

    const cachedById = getMusicTrackAnalysisCaches('ncm', shortlist.map((candidate) => candidate.id));
    const misses: Array<{ candidate: MusicCandidate; packetIndex: number; cached: MusicTrackAnalysisCacheRecord | null }> = [];

    shortlist.forEach((candidate, packetIndex) => {
      const cached = cachedById.get(candidate.id) ?? null;
      const assessment = cachedAssessment(candidate.id, cached, analyzerVersion);
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
      return { shortlist, promptPackets, diagnostics };
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

        let lyricEvidence: PreparedLyricEvidence;
        const cachedMissing = isFreshMissingCache(item.cached, now());
        if (cachedMissing) {
          lyricEvidence = prepareLyricEvidence(null, { charBudget: lyricCharBudget });
          diagnostics.lyricMissing += 1;
        } else {
          try {
            const lyric = await abortable(
              ncmClient.getLyric(
                item.candidate.id,
                requestOptions(deadlineController.signal, boundedDeadlineMs)
              ),
              deadlineController.signal
            );
            lyricEvidence = prepareLyricEvidence(lyric, { charBudget: lyricCharBudget });
            if (lyricEvidence.lyricStatus === 'available') diagnostics.lyricSuccess += 1;
            else diagnostics.lyricMissing += 1;
            diagnostics.sampledChars += lyricEvidence.sampledCharCount;
            recordMusicTrackLyricRefresh({
              provider: 'ncm',
              trackId: item.candidate.id,
              lyricStatus: lyricEvidence.lyricStatus,
              lyricHash: lyricEvidence.lyricStatus === 'available' ? lyricEvidence.lyricHash : null,
              extractionSummary: extractionSummary(lyricEvidence),
              refreshedAt: new Date(now()).toISOString()
            });
          } catch {
            if (deadlineReached) diagnostics.lyricTimeout += 1;
            else diagnostics.lyricFail += 1;
            return;
          }
        }

        let wikiTags: string[] = [];
        try {
          const wikiSummary = await abortable(
            ncmClient.getSongWikiSummary(
              item.candidate.id,
              requestOptions(deadlineController.signal, boundedDeadlineMs)
            ),
            deadlineController.signal
          );
          wikiTags = extractTagsFromWikiSummary(wikiSummary);
          diagnostics.wikiSuccess += 1;
        } catch {
          if (deadlineReached) diagnostics.wikiTimeout += 1;
          else diagnostics.wikiFail += 1;
        }

        promptPackets[item.packetIndex] = {
          ...packetFacts(item.candidate),
          kind: 'evidence',
          lyricEvidence,
          wikiTags
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
    return { shortlist, promptPackets, diagnostics };
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
  analyzerVersion: string
): TrackAssessment | null {
  if (
    !cached ||
    cached.analyzerVersion !== analyzerVersion ||
    cached.profile === null ||
    cached.confidence === null
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
  const refreshedAt = Date.parse(cached.lastLyricRefreshAt);
  return Number.isFinite(refreshedAt) && nowMs - refreshedAt < MISSING_LYRIC_CACHE_TTL_MS;
}

function extractionSummary(evidence: PreparedLyricEvidence): Record<string, unknown> {
  return {
    lyricStatus: evidence.lyricStatus,
    sampleMode: evidence.sampleMode,
    credits: evidence.credits,
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

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
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

function emptyDiagnostics(shortlistCount: number): FinalShortlistEnrichmentDiagnostics {
  return {
    shortlistCount,
    cacheHits: 0,
    cacheMisses: 0,
    lyricSuccess: 0,
    lyricMissing: 0,
    lyricFail: 0,
    lyricTimeout: 0,
    wikiSuccess: 0,
    wikiFail: 0,
    wikiTimeout: 0,
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
