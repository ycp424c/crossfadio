import {
  type MusicAgentContextSummary,
  type MusicCandidate,
  type QueryFunnelEntry,
  type WebMusicDiscoveryInput,
  webMusicDiscoveryInputSchema
} from './schema.js';
import { normalizeSearchQuery } from './query-stats.js';
import { countCandidateArtistKeys } from './candidate-admission.js';
import {
  DEFAULT_WEB_DISCOVERY_HINT_LIMIT,
  isExplicitWebExploreIntent,
  parseWebMusicDiscoveryInput,
  WEB_DISCOVERY_MAX_HINT_LIMIT
} from './web-discovery-planning.js';
import { parseMusicEntityHints } from './web-discovery-hints.js';
import type { WebMusicDiscoveryProvider } from './web-discovery.js';

export type WebMusicDiscoveryRunOptions = {
  toolInput: Record<string, unknown>;
  userId: string;
  context: MusicAgentContextSummary;
  candidates: MusicCandidate[];
  queryFunnel: QueryFunnelEntry[];
  webDiscoveryProvider?: WebMusicDiscoveryProvider | null;
  webDiscoveryCalled: boolean;
  ncmSearches: number;
  targetExternalCandidateCount: number;
  maxWebDiscoveryMs?: number;
  maxWebDiscoveryHints?: number;
  signal?: AbortSignal;
};

export type WebMusicDiscoveryRunResult = {
  summary: string;
  problems: string[];
  data: Record<string, unknown>;
  called: boolean;
  aborted?: boolean;
};

export async function runWebMusicDiscovery(options: WebMusicDiscoveryRunOptions): Promise<WebMusicDiscoveryRunResult> {
  const discoveryInput = parseWebMusicDiscoveryInput(options.toolInput, options);
  const gate = evaluateWebMusicDiscoveryGate({
    discoveryInput,
    context: options.context,
    userId: options.userId,
    candidates: options.candidates,
    queryFunnel: options.queryFunnel,
    webDiscoveryCalled: options.webDiscoveryCalled,
    ncmSearches: options.ncmSearches,
    targetExternalCandidateCount: options.targetExternalCandidateCount
  });
  const baseData = {
    allowed: gate.allowed,
    signals: gate.signals,
    intentCluster: gate.intentCluster
  };

  if (!gate.allowed) {
    return {
      summary: `web discovery skipped: ${gate.reason}.`,
      problems: [`web discovery denied: ${gate.reason}`],
      data: baseData,
      called: false
    };
  }
  if (!options.webDiscoveryProvider) {
    return {
      summary: 'web discovery unavailable: provider is not configured.',
      problems: ['web discovery unavailable: provider is not configured'],
      data: baseData,
      called: false
    };
  }

  const maxHints = boundedPositiveInt(
    options.toolInput.maxHints,
    options.maxWebDiscoveryHints ?? DEFAULT_WEB_DISCOVERY_HINT_LIMIT,
    Math.min(options.maxWebDiscoveryHints ?? WEB_DISCOVERY_MAX_HINT_LIMIT, WEB_DISCOVERY_MAX_HINT_LIMIT)
  );
  const request = webMusicDiscoveryInputSchema.parse({
    ...discoveryInput,
    maxHints
  });

  try {
    const result = await withTimeout(
      options.webDiscoveryProvider.discover(request, { signal: options.signal }),
      options.maxWebDiscoveryMs ?? 6_000
    );
    if (options.signal?.aborted) {
      return { summary: 'aborted', problems: ['aborted'], data: baseData, called: true, aborted: true };
    }
    if (result.timedOut) {
      return {
        summary: 'web discovery timed out before returning hints.',
        problems: ['web discovery timeout'],
        data: { ...baseData, hints: [] },
        called: true
      };
    }

    const parsed = parseMusicEntityHints(result.value, maxHints);
    return {
      summary: `web discovery returned ${parsed.hints.length} hints from ${result.value.length} raw hints.`,
      problems: parsed.problems,
      data: { ...baseData, hints: parsed.hints },
      called: true
    };
  } catch (error) {
    return {
      summary: 'web discovery failed before returning hints.',
      problems: [`web discovery failed: ${formatError(error)}`],
      data: { ...baseData, hints: [] },
      called: true
    };
  }
}

export function evaluateWebMusicDiscoveryGate(options: {
  discoveryInput: WebMusicDiscoveryInput;
  context: MusicAgentContextSummary;
  userId: string;
  candidates: MusicCandidate[];
  queryFunnel: QueryFunnelEntry[];
  webDiscoveryCalled: boolean;
  ncmSearches: number;
  targetExternalCandidateCount: number;
}): { allowed: boolean; reason?: string; signals: string[]; intentCluster: string } {
  const intentCluster = webDiscoveryIntentCluster(options.userId, options.discoveryInput.intent);
  if (options.context.discoveryMode === 'comfort') {
    return { allowed: false, reason: 'discovery mode is comfort', signals: [], intentCluster };
  }
  if (options.webDiscoveryCalled) {
    return { allowed: false, reason: 'already called in this run', signals: [], intentCluster };
  }

  const signals = webDiscoveryGapSignals({
    candidates: options.candidates,
    queryFunnel: options.queryFunnel,
    ncmSearches: options.ncmSearches,
    targetExternalCandidateCount: options.targetExternalCandidateCount
  });
  if (isExplicitWebExploreIntent(options.discoveryInput, options.context)) {
    return { allowed: true, signals: ['explicit_explore_intent', ...signals], intentCluster };
  }
  if (signals.length >= 2) {
    return { allowed: true, signals, intentCluster };
  }
  return { allowed: false, reason: 'exploration gap is not strong enough', signals, intentCluster };
}

export function webDiscoveryGapSignals(options: {
  candidates: MusicCandidate[];
  queryFunnel: QueryFunnelEntry[];
  ncmSearches: number;
  targetExternalCandidateCount: number;
}): string[] {
  const nonLikedCount = options.candidates.filter((candidate) => candidate.sources.some((source) => source !== 'liked')).length;
  const externalSources = new Set(
    options.candidates.flatMap((candidate) => candidate.sources.filter((source) => source !== 'liked'))
  );
  const sourceCounts = countCandidateArtistKeys(options.candidates);
  const maxArtistCount = Math.max(0, ...sourceCounts.values());
  return [
    nonLikedCount < options.targetExternalCandidateCount ? 'sparse_external_candidates' : '',
    externalSources.size <= 1 ? 'low_source_diversity' : '',
    options.candidates.length >= 3 && maxArtistCount / options.candidates.length >= 0.6 ? 'artist_clustered' : '',
    options.queryFunnel.some((entry) => entry.resultCount > 0 && entry.addedCount === 0) ? 'query_funnel_low_yield' : '',
    options.ncmSearches > 0 && nonLikedCount === 0 ? 'semantic_or_exact_discovery_empty' : ''
  ].filter(Boolean);
}

function webDiscoveryIntentCluster(userId: string, intent: string): string {
  const cluster = normalizeSearchQuery(intent).slice(0, 120) || 'default';
  return `${userId}:${cluster}`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, timeoutMs));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(stringValue(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function boundedPositiveInt(value: unknown, fallback: number, max: number): number {
  return Math.min(positiveInt(value, fallback), max);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
