import { getLogger } from '../logger.js';
import { getQueue } from '../store/queue.js';
import type {
  DjEventSink,
  DjPickNextFallbackPath,
  DjPickNextRunMetrics
} from './musicAgentPickNextResult.js';

export type DjPickNextFallbackStats = {
  totalRuns: number;
  fallbackRuns: number;
  fallbackRate: number;
  fallbackPaths: Partial<Record<DjPickNextFallbackPath, number>>;
};

export type DjPickNextFallbackStatsTracker = {
  record(event: { path: DjPickNextFallbackPath }): DjPickNextFallbackStats;
  snapshot(): DjPickNextFallbackStats;
};

type Logger = {
  info(payload: Record<string, unknown>, message: string): void;
};

export type DjPickNextTelemetry = {
  fallbackStats: DjPickNextFallbackStatsTracker;
  recordFallbackStats(path: DjPickNextFallbackPath): DjPickNextFallbackStats;
  broadcastAppended(
    userId: string,
    prevQueueLength: number,
    targetPickCount: number,
    emit: DjEventSink,
    path?: DjPickNextFallbackPath,
    metrics?: DjPickNextRunMetrics
  ): void;
};

export function createDjPickNextTelemetry(input: { logger?: Logger } = {}): DjPickNextTelemetry {
  const fallbackStats = createDjPickNextFallbackStatsTracker();
  const logger = input.logger;

  function recordFallbackStats(path: DjPickNextFallbackPath): DjPickNextFallbackStats {
    return fallbackStats.record({ path });
  }

  function broadcastAppended(
    userId: string,
    prevQueueLength: number,
    targetPickCount: number,
    emit: DjEventSink,
    path?: DjPickNextFallbackPath,
    metrics: DjPickNextRunMetrics = {}
  ): void {
    const q = getQueue(userId);
    const newTracks = q.slice(prevQueueLength);
    for (const track of newTracks) {
      emit({ type: 'queue-appended', track });
    }
    const names = newTracks.map((t) => t.name).filter((n): n is string => Boolean(n));
    const currentFallbackStats = path ? recordFallbackStats(path) : fallbackStats.snapshot();
    (logger ?? getLogger()).info(
      {
        targetCount: targetPickCount,
        appendedCount: newTracks.length,
        agentPickCount: metrics.agentPickCount,
        rankedBackfillCount: metrics.rankedBackfillCount,
        finalPickDiagnostics: metrics.finalPickDiagnostics,
        queryFunnel: metrics.queryFunnel,
        candidateCount: metrics.candidateCount,
        nonLikedCandidateCount: metrics.nonLikedCandidateCount,
        candidateSourceCounts: metrics.candidateSourceCounts,
        elapsedMs: metrics.elapsedMs,
        fallbackPath: path ?? metrics.fallbackPath,
        discoveryMode: metrics.discoveryMode,
        trackIds: newTracks.map((track) => track.ncmId),
        trackNames: names,
        fallbackStats: currentFallbackStats
      },
      'DJ pick-next: broadcast appended tracks'
    );
    emit({
      type: 'dj.pick-next.done',
      added: newTracks.length > 0,
      addedCount: newTracks.length,
      targetCount: targetPickCount,
      trackIds: newTracks.map((track) => track.ncmId),
      trackNames: names,
      trackName: names.join('、') || undefined
    });
  }

  return { fallbackStats, recordFallbackStats, broadcastAppended };
}

export function createDjPickNextFallbackStatsTracker(): DjPickNextFallbackStatsTracker {
  const stats: DjPickNextFallbackStats = {
    totalRuns: 0,
    fallbackRuns: 0,
    fallbackRate: 0,
    fallbackPaths: {}
  };

  return {
    record(event) {
      stats.totalRuns += 1;
      if (isDjPickNextFallbackPath(event.path)) {
        stats.fallbackRuns += 1;
        stats.fallbackPaths[event.path] = (stats.fallbackPaths[event.path] ?? 0) + 1;
      }
      stats.fallbackRate = roundRate(stats.fallbackRuns / stats.totalRuns);
      return cloneDjPickNextFallbackStats(stats);
    },
    snapshot() {
      return cloneDjPickNextFallbackStats(stats);
    }
  };
}

function cloneDjPickNextFallbackStats(stats: DjPickNextFallbackStats): DjPickNextFallbackStats {
  return {
    ...stats,
    fallbackPaths: { ...stats.fallbackPaths }
  };
}

function isDjPickNextFallbackPath(path: DjPickNextFallbackPath): boolean {
  return path !== 'music_agent_success' && path !== 'legacy_llm_success';
}

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}
