import type { Track } from '../agent/schema.js';
import { resolveLlmConfig as resolveUserLlmConfig } from '../llm/config.js';
import type { LlmConfig } from '../llm/client.js';
import { beginForegroundLlmWork } from '../llm/foreground-activity.js';
import type { NcmClient } from '../ncm/client.js';
import { getLogger } from '../logger.js';
import { broadcastToUser } from '../http/broadcast.js';
import { getCurrentIndex, getQueue, getQueueRevision } from '../store/queue.js';
import { getPref } from '../store/prefs.js';
import { MusicAgent } from '../music-agent/index.js';
import { DJAgent } from '../dj-agent/index.js';
import type { DJAgentPickNextResult } from '../dj-agent/ports.js';
import { createDjPickNextTelemetry } from './pickNextTelemetry.js';
import {
  buildTrackDedupeKey,
  getMusicAgentCandidateSourceDiagnostics,
  isTrackDedupeKeyExcluded,
  type DedupeState,
  type DjEventSink,
  type DjPickNextFallbackPath
} from './musicAgentPickNextResult.js';
import { parseAutoFillBatchSize, parseDiscoveryMode, type DiscoveryMode } from '../../shared/dj.js';
import { resolveUserTier } from '../resource-policy.js';
import { safeOperationalError } from '../errors/safe-operational-error.js';
import { createPickReasonCache } from './pick-reason-cache.js';

export { buildTrackDedupeKey, getMusicAgentCandidateSourceDiagnostics, isTrackDedupeKeyExcluded };
export type { DiscoveryMode } from '../../shared/dj.js';
export type { DjPickNextFallbackPath } from './musicAgentPickNextResult.js';

const JOB_TIMEOUT_MS = 180_000;
const LARGE_BATCH_JOB_TIMEOUT_MS = 210_000;
const DJ_AGENT_TIMEOUT_MS = 135_000;
const LARGE_BATCH_DJ_AGENT_TIMEOUT_MS = 165_000;
const PICK_REASON_TTL_MS = 2 * 60 * 60_000;
const PICK_REASON_MAX_ENTRIES = 1_000;

const telemetry = createDjPickNextTelemetry();
const pickReasonCache = createPickReasonCache({
  ttlMs: PICK_REASON_TTL_MS,
  maxEntries: PICK_REASON_MAX_ENTRIES
});

type PickNextAgent = Pick<DJAgent, 'pickNext'>;
type RunDjPickNextDeps = {
  resolveLlmConfig(userId: string): LlmConfig | null;
  createAgent(llmConfig: LlmConfig): PickNextAgent;
};

const defaultDeps: RunDjPickNextDeps = {
  resolveLlmConfig: resolveUserLlmConfig,
  createAgent: (llmConfig) => new DJAgent({
    musicAgentFactory: () => new MusicAgent({ llmConfig })
  })
};

export function getDjPickReason(userId: string, trackId: string): string | null {
  return pickReasonCache.get(userId, trackId);
}

export function getAutoFillBatchSize(userId: string): number {
  const stored = parseAutoFillBatchSize(getPref<number>(userId, 'dj.autoFillBatchSize'));
  // Standard-tier users cannot raise DJ auto-fill above the default two tracks,
  // even if a stored preference says otherwise (e.g. after a demotion).
  return resolveUserTier(userId) === 'priority' ? stored : Math.min(stored, 2);
}

export function getJobTimeoutMs(targetPickCount: number): number {
  return targetPickCount >= 4 ? LARGE_BATCH_JOB_TIMEOUT_MS : JOB_TIMEOUT_MS;
}

function getDjAgentTimeoutMs(targetPickCount: number): number {
  return targetPickCount >= 4 ? LARGE_BATCH_DJ_AGENT_TIMEOUT_MS : DJ_AGENT_TIMEOUT_MS;
}

export async function runDjPickNext(
  userId: string,
  ncmClient: NcmClient,
  emit: DjEventSink = (payload) => broadcastToUser(userId, payload),
  signal?: AbortSignal,
  deps: RunDjPickNextDeps = defaultDeps
): Promise<void> {
  const logger = getLogger();
  const startedAt = Date.now();
  const targetPickCount = getAutoFillBatchSize(userId);
  const discoveryMode = parseDiscoveryMode(getPref<DiscoveryMode>(userId, 'discovery.mode'));
  const llmConfig = deps.resolveLlmConfig(userId);

  if (!llmConfig) {
    logger.warn('DJ pick-next: LLM configuration is unavailable');
    telemetry.recordFallbackStats('no_candidates');
    emitDone(emit, targetPickCount, 'llm-not-configured');
    return;
  }
  if (signal?.aborted) return;

  const excludeState = getQueueDedupeState(userId);
  const initialQueueLength = getQueue(userId).length;
  const initialQueueRevision = getQueueRevision(userId);
  const agentAbort = createAbortTimeoutSignal(signal, getDjAgentTimeoutMs(targetPickCount));
  const releaseForegroundLlm = beginForegroundLlmWork();
  try {
    const result = await deps.createAgent(llmConfig).pickNext({
      userId,
      ncmClient,
      llmConfig,
      includeDailyTheme: getPref<boolean>(userId, 'dailyTheme.enabled') !== false,
      signal: agentAbort.signal,
      excludeState,
      initialQueueLength,
      initialQueueRevision,
      targetPickCount,
      startedAt,
      discoveryMode,
      emit,
      broadcastAppended: telemetry.broadcastAppended,
      logger,
      setPickReason: (trackId, reason) => pickReasonCache.set(userId, trackId, reason),
      recordRouteOutcome: telemetry.recordFallbackStats,
      fallbackStatsSnapshot: telemetry.fallbackStats.snapshot
    });
    if (signal?.aborted) return;
    handleNonHandledAgentResult(result, emit, targetPickCount, agentAbort.timedOut());
  } catch (error) {
    if (signal?.aborted) return;
    logger.warn({ err: serializeDjPickNextErrorForLog(error) }, 'DJ pick-next: v2 selection failed');
    telemetry.recordFallbackStats('no_candidates');
    emitDone(emit, targetPickCount, agentAbort.timedOut() ? 'timeout' : 'selection-error');
  } finally {
    releaseForegroundLlm();
    agentAbort.cleanup();
  }
}

function handleNonHandledAgentResult(
  result: DJAgentPickNextResult,
  emit: DjEventSink,
  targetPickCount: number,
  timedOut: boolean
): void {
  if (result.status === 'handled') return;
  telemetry.recordFallbackStats('no_candidates');
  emitDone(emit, targetPickCount, timedOut ? 'timeout' : result.output.status);
}

function emitDone(emit: DjEventSink, targetCount: number, reason: string): void {
  emit({
    type: 'dj.pick-next.done',
    added: false,
    addedCount: 0,
    targetCount,
    reason
  });
}

function getQueueDedupeState(userId: string): DedupeState {
  const queue = getQueue(userId);
  const currentIndex = getCurrentIndex(userId);
  const relevantQueue = queue.slice(Math.max(0, currentIndex));
  const ids = new Set(relevantQueue.map((track) => track.ncmId));
  const dedupeKeys = new Set<string>();
  for (const track of relevantQueue) {
    const key = buildTrackDedupeKey({
      id: track.ncmId,
      name: track.name,
      artists: track.artists
    });
    if (key) dedupeKeys.add(key);
  }
  return { ids, dedupeKeys };
}

/**
 * Shared NCM search adapter kept for explicit MusicAgent tools and callers.
 * It only returns candidates from the requested queries; it does not select or
 * apply any track to the queue.
 */
export async function searchCandidates(
  queries: string[],
  ncmClient: NcmClient,
  excludeIds: Set<string>,
  limit: number,
  signal?: AbortSignal,
  excludeDedupeKeys: Set<string> = new Set()
): Promise<Track[]> {
  const candidates: Track[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    if (signal?.aborted || candidates.length >= limit) break;
    const rows = await ncmClient.searchSongs(query, Math.min(20, limit)).catch(() => []);
    for (const row of rows) {
      const id = String(row.id);
      const artist = row.artists?.[0] ?? '';
      const candidate = { id, name: row.name, artist };
      const dedupeKey = buildTrackDedupeKey(candidate);
      if (excludeIds.has(id) || seen.has(id) || isTrackDedupeKeyExcluded(dedupeKey, excludeDedupeKeys)) {
        continue;
      }
      seen.add(id);
      candidates.push(candidate);
      if (candidates.length >= limit) break;
    }
  }
  return candidates;
}

export function serializeDjPickNextErrorForLog(error: unknown): unknown {
  return safeOperationalError(error, 'dj_selection_failed');
}

function createAbortTimeoutSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup(): void; timedOut(): boolean } {
  const controller = new AbortController();
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error('timeout'));
  }, timeoutMs);
  const abortFromParent = () => controller.abort(parentSignal?.reason ?? new Error('aborted'));
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
    timedOut: () => didTimeOut
  };
}
