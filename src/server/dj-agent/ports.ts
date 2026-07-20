import type { LlmConfig } from '../llm/client.js';
import type { NcmClient } from '../ncm/client.js';
import type { MusicAgent } from '../music-agent/index.js';
import type { MusicAgentRunOutput } from '../music-agent/schema.js';
import {
  getQueueRevision,
  prepareQueueAppend,
  type PreparedQueueAppend,
  type QueueTrack
} from '../store/queue.js';
import type {
  DedupeState,
  DjEventSink,
  DjPickNextFallbackPath,
  DjPickNextRunMetrics
} from '../dj/musicAgentPickNextResult.js';
import type { DiscoveryMode } from '../../shared/dj.js';

export type DJAgentMusicAgent = Pick<MusicAgent, 'pickNext'>;

export type DJAgentMusicAgentFactory = (llmConfig: LlmConfig) => DJAgentMusicAgent;

export type DJAgentQueuePort = {
  getRevision(userId: string): number;
  prepareAppend(userId: string, tracks: QueueTrack[]): PreparedQueueAppend;
};

export const defaultDJAgentQueuePort: DJAgentQueuePort = {
  getRevision: getQueueRevision,
  prepareAppend: prepareQueueAppend
};

export type DJAgentLogger = {
  warn(payload: Record<string, unknown>, message: string): void;
};

export type DJAgentBroadcastAppended = (
  userId: string,
  tracks: QueueTrack[],
  targetPickCount: number,
  emit: DjEventSink,
  path?: DjPickNextFallbackPath,
  metrics?: DjPickNextRunMetrics
) => void;

export type DJAgentPickNextInput = {
  userId: string;
  ncmClient: NcmClient;
  llmConfig: LlmConfig;
  includeDailyTheme: boolean;
  excludeState: DedupeState;
  initialQueueLength: number;
  initialQueueRevision?: number;
  targetPickCount: number;
  startedAt: number;
  discoveryMode: DiscoveryMode;
  signal?: AbortSignal;
  now?: Date;
  queuePort?: DJAgentQueuePort;
  emit: DjEventSink;
  broadcastAppended: DJAgentBroadcastAppended;
  logger: DJAgentLogger;
  setPickReason(trackId: string, reason: string): void;
  recordRouteOutcome?(path: DjPickNextFallbackPath): unknown;
  fallbackStatsSnapshot(): unknown;
};

export type DJAgentPickNextHandledResult = {
  status: 'handled';
  completion: 'applied' | 'superseded';
  debugBroadcastSent: true;
  appendedCount: number;
  appendedTrackIds: string[];
  output: MusicAgentRunOutput;
  runId: string;
  selectionStartedEventId: string;
};

export type DJAgentPickNextAbortedResult = {
  status: 'aborted';
  debugBroadcastSent: false;
  output: MusicAgentRunOutput;
  runId: string;
  selectionStartedEventId: string;
};

export type DJAgentPickNextResult =
  | DJAgentPickNextHandledResult
  | DJAgentPickNextAbortedResult;
