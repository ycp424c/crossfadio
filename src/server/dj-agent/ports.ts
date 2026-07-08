import type { LlmConfig } from '../llm/client.js';
import type { NcmClient } from '../ncm/client.js';
import type { MusicAgent } from '../music-agent/index.js';
import type { MusicAgentRunOutput } from '../music-agent/schema.js';
import { addToQueue, getQueue, type QueueTrack } from '../store/queue.js';
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
  getQueue(userId: string): QueueTrack[];
  addToQueue(userId: string, track: QueueTrack, position: 'end' | 'after_current'): void;
};

export const defaultDJAgentQueuePort: DJAgentQueuePort = {
  getQueue,
  addToQueue
};

export type DJAgentLogger = {
  warn(payload: Record<string, unknown>, message: string): void;
};

export type DJAgentBroadcastAppended = (
  userId: string,
  prevQueueLength: number,
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
  fallbackStatsSnapshot(): unknown;
};

export type DJAgentPickNextHandledResult = {
  status: 'handled';
  debugBroadcastSent: true;
  output: MusicAgentRunOutput;
  runId: string;
};

export type DJAgentPickNextFallbackResult = {
  status: 'legacy-fallback';
  legacyFallbackPath: 'music_agent_legacy_fallback';
  debugBroadcastSent: false;
  output: MusicAgentRunOutput;
  runId: string;
};

export type DJAgentPickNextAbortedResult = {
  status: 'aborted';
  debugBroadcastSent: false;
  output: MusicAgentRunOutput;
  runId: string;
};

export type DJAgentPickNextResult =
  | DJAgentPickNextHandledResult
  | DJAgentPickNextFallbackResult
  | DJAgentPickNextAbortedResult;
