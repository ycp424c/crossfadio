import { randomBytes } from 'node:crypto';
import { computeStream } from '../agent/compute.js';
import { buildSystemPrompt } from '../agent/modes.js';
import type { ChatOutput, Fragments } from '../agent/schema.js';
import { resolveLlmConfig } from '../llm/config.js';
import { beginForegroundLlmWork } from '../llm/foreground-activity.js';
import type { NcmClient } from '../ncm/client.js';
import { saveMessage } from '../store/messages.js';
import { getPref, deletePref, setPref } from '../store/prefs.js';
import { executeActions } from '../agent/actions.js';
import {
  getCurrentIndex,
  getQueue,
  getQueueStateRevision,
  prepareQueueState,
  type QueueTrack
} from '../store/queue.js';
import { getDb } from '../store/db.js';
import { appendDjEvent, type DjEventRecord } from '../store/dj-events.js';
import { recordSelectionRotationExposure } from '../store/selection-rotation.js';
import { broadcastToUser } from './broadcast.js';
import { getLogger } from '../logger.js';
import { buildTrackDedupeKey, isTrackDedupeKeyExcluded } from './routes/djNext.js';
import { MusicAgent } from '../music-agent/index.js';
import type { MusicAgentRunOutput } from '../music-agent/schema.js';
import { buildDjMemorySnapshot } from '../dj-memory/snapshot.js';
import {
  projectDjMemoryForChat
} from '../dj-memory/projections.js';
import { createMusicAgentSelectionAdapter } from '../dj-memory/music-agent-adapter.js';
import { applySelectionIntent } from '../music-agent/selection-intent.js';
import { evaluateFinalQueuePick } from '../music-agent/final-queue-policy.js';
import { enqueuePreferenceExtractionMessage } from '../music-agent/preference-extraction.js';
import { safeOperationalError } from '../errors/safe-operational-error.js';

const ACTIVE_DIRECTIVE_TTL_MS = 24 * 60 * 60 * 1000;
const CHAT_AGENT_TIMEOUT_MS = 60_000;

const activeRecommendJobs = new Map<string, AbortController>();

export function cancelActiveRecommend(jobId: string): void {
  const controller = activeRecommendJobs.get(jobId);
  if (controller && !controller.signal.aborted) {
    controller.abort(new Error('user-cancelled'));
  }
}

export async function handleChatMessage(
  userId: string,
  ncmClient: NcmClient,
  text: string,
  send: (type: string, payload: Record<string, unknown>) => void,
  signal?: AbortSignal
): Promise<void> {
  const logger = getLogger();

  try {
    const userMessageId = saveMessage(userId, 'user', text);
    appendListenerRequestReceivedEvent(userId, userMessageId, text);
    enqueuePreferenceExtractionMessage({ userId, messageId: userMessageId });
    const selectionIntentResult = await applySelectionIntent({
      userId,
      text,
      sourceRef: { messageId: userMessageId },
      ncmClient
    });
    if (selectionIntentResult.trackResolution === 'pending_resolution') {
      send('chat.intent.notice', {
        kind: 'track_exclusion_pending_resolution',
        message: '暂时无法确认这首歌的唯一版本，已登记为待确认；硬禁播尚未生效，后台会在 24 小时内重试，仍无法确认时会明确通知。'
      });
    }
    applyQueueDirectiveFallbackFromText(userId, text);

    const llmConfig = resolveLlmConfig(userId);
    if (!llmConfig) {
      const fallback = '抱歉，AI DJ 暂时不可用（未配置 LLM）。';
      send('chat.done', { say: fallback, intent: 'chitchat', actions: [] });
      saveMessage(userId, 'assistant', fallback);
      return;
    }

    if (signal?.aborted) return;

    const now = new Date();
    const memorySnapshot = await buildDjMemorySnapshot({ userId, now });
    if (signal?.aborted) return;

    const fragments: Fragments = {
      mode: 'chat',
      system: buildSystemPrompt('You are a DJ.', 'chat'),
      djMemory: projectDjMemoryForChat(memorySnapshot),
      input: { kind: 'chat', text },
      trace: { triggeredBy: 'user', lastDecision: null }
    };

    let streamedRaw = '';
    let chatOutput: ChatOutput | null = null;

    const releaseChatForegroundLlm = beginForegroundLlmWork();
    try {
      for await (const event of computeStream(fragments, { llmConfig })) {
        if (signal?.aborted) return;
        if (event.type === 'delta') {
          streamedRaw += event.say;
        } else if (event.type === 'done' && event.output.mode === 'chat') {
          chatOutput = event.output;
        }
      }
    } finally {
      releaseChatForegroundLlm();
    }

    if (signal?.aborted) return;

    if (!chatOutput) {
      const fallback = extractSayFromRawChat(streamedRaw);
      send('chat.done', { say: fallback, intent: 'chitchat', actions: [] });
      saveMessage(userId, 'assistant', fallback);
      return;
    }

    saveMessage(userId, 'assistant', chatOutput.say);
    send('chat.delta', { say: chatOutput.say });
    send('chat.done', {
      say: chatOutput.say,
      intent: chatOutput.intent,
      actions: chatOutput.actions
    });

    if (chatOutput.actions.length > 0) {
      const songActions = chatOutput.actions.filter(
        (a) => a.type === 'swap_next' || a.type === 'add_to_queue'
      );
      const isRecommend = chatOutput.intent === 'adjust_queue' &&
        llmConfig &&
        songActions.length > 0 &&
        !songActions.every((a) => 'query' in a.pick && a.pick.query.includes(' — '));

      if (isRecommend) {
        const jobId = randomBytes(6).toString('hex');
        const runId = `chat-recommend-${jobId}`;
        const isSwap = songActions.some((a) => a.type === 'swap_next');
        const controller = new AbortController();
        activeRecommendJobs.set(jobId, controller);

        // If the parent request is aborted, abort the recommend job too
        const onParentAbort = () => {
          if (!controller.signal.aborted) {
            controller.abort(new Error('parent-aborted'));
          }
        };
        if (signal?.aborted) {
          onParentAbort();
        } else {
          signal?.addEventListener('abort', onParentAbort, { once: true });
        }
        if (controller.signal.aborted) {
          activeRecommendJobs.delete(jobId);
          signal?.removeEventListener('abort', onParentAbort);
          return;
        }

        const reportProgress = (evt: Record<string, unknown>): void => {
          send('chat.recommend.progress', { jobId, ...evt });
        };

        send('chat.recommend.started', { jobId });
        const selectionStartedEvent = appendChatSelectionStartedEvent({
          userId,
          runId,
          userText: text,
          targetCount: isSwap ? 1 : Math.min(2, Math.max(1, songActions.length))
        });

        let added = 0;
        let recommendationTracks: ChatAddedTrack[] = [];
        try {
          reportProgress({ phase: 'agent' });
          const agent = new MusicAgent({ llmConfig });
          const agentAbort = createAbortTimeoutSignal(controller.signal, CHAT_AGENT_TIMEOUT_MS);
          const releaseSelectionForegroundLlm = beginForegroundLlmWork();
          try {
            const selectionAdapter = createMusicAgentSelectionAdapter({
              snapshot: memorySnapshot,
              request: 'chat-recommend',
              userText: text,
              actionQueries: songActions.map((action) => action.pick.query),
              selectionIntent: selectionIntentResult.intent
            });
            const output = await agent.recommendFromChat({
              userId,
              ncmClient,
              userText: text,
              actions: songActions,
              signal: agentAbort.signal,
              selectionAdapter
            });

            if (!controller.signal.aborted && output.status === 'ok') {
              const applied = applyMusicAgentPicks(
                userId,
                output,
                isSwap,
                selectionAdapter.selectionModeForCandidate
              );
              recommendationTracks = applied.tracks;
              added = recommendationTracks.length;
              if (applied.skipped.length > 0) {
                reportProgress({ phase: 'skipped', skipped: applied.skipped });
              }
            } else if (!controller.signal.aborted) {
              reportProgress({ phase: 'error', reason: output.status });
            }
          } finally {
            releaseSelectionForegroundLlm();
            agentAbort.cleanup();
          }
        } catch (err) {
          const safeError = safeOperationalError(err, 'chat_recommend_failed');
          logger.warn({ error: safeError, jobId }, 'Chat recommend MusicAgent error');
          reportProgress({ phase: 'error', reason: safeError.code });
        } finally {
          activeRecommendJobs.delete(jobId);
          signal?.removeEventListener('abort', onParentAbort);
        }

        if (added > 0) {
          commitChatQueueSelection({
            userId,
            runId,
            selectionStartedEvent,
            tracks: recommendationTracks,
            action: isSwap ? 'swap_next' : 'append'
          });
          reportProgress({ phase: 'done', tracks: toChatProgressTracks(recommendationTracks) });
          broadcastToUser(userId, {
            type: 'queue-updated', queue: getQueue(userId), currentIndex: getCurrentIndex(userId),
            revision: getQueueStateRevision(userId)
          });
        }

        // Still execute any non-song actions (skip, ban, etc.)
        const otherActions = chatOutput.actions.filter(
          (a) => a.type !== 'swap_next' && a.type !== 'add_to_queue'
        );
        if (otherActions.length > 0 && !signal?.aborted) {
          await executeActions(otherActions, {
            userId,
            ncmClient,
            sourceRef: { messageId: userMessageId },
            onQueueActiveDirectiveUpdated: (directive) => appendDirectiveUpdatedEvent(userId, directive?.text ?? null, 'chat')
          });
        }
      } else {
        if (signal?.aborted) return;
        const result = await executeActions(chatOutput.actions, {
          userId,
          ncmClient,
          sourceRef: { messageId: userMessageId },
          commitQueueTrack: ({ actionIndex, position, track }) => {
            commitDirectChatQueueTrack({
              userId,
              runId: `chat-direct-${userMessageId}:${actionIndex}`,
              position,
              track
            });
          },
          onQueueActiveDirectiveUpdated: (directive) => appendDirectiveUpdatedEvent(userId, directive?.text ?? null, 'chat')
        });
        if (result.queueChanged) {
          broadcastToUser(userId, {
            type: 'queue-updated', queue: getQueue(userId), currentIndex: getCurrentIndex(userId),
            revision: getQueueStateRevision(userId)
          });
        }
      }
    }
  } catch (err) {
    const safeError = safeOperationalError(err, 'chat_message_failed');
    logger.warn({ error: safeError }, 'Chat message handler error');
    send('chat.error', {
      error: 'AI DJ 暂时不可用，请稍后重试。',
      code: safeError.code,
      ...(safeError.requestId ? { requestId: safeError.requestId } : {})
    });
  }
}

type ChatAddedTrack = {
  id: string;
  name: string;
  artist: string;
  selectionRationale: string;
  source?: string;
  position: 'end' | 'after_current';
};

function applyMusicAgentPicks(
  userId: string,
  output: MusicAgentRunOutput,
  isSwap: boolean,
  selectionModeForCandidate: (candidate: {
    id: string;
    name?: string;
    artist?: string;
  }) => 'autonomous' | 'explicit_request'
): { tracks: ChatAddedTrack[]; skipped: Array<{ id: string; reason: string }> } {
  if (output.status !== 'ok') return { tracks: [], skipped: [] };

  const queuedTracks = getQueue(userId);
  const queueDedupeKeys = queuedTracks
    .map((track) => buildTrackDedupeKey({
      id: track.ncmId,
      name: track.name,
      artists: track.artists
    }))
    .filter(Boolean);
  const excludedIds = new Set(queuedTracks.map((track) => track.ncmId));
  const excludedDedupeKeys = new Set(queueDedupeKeys);
  const addedTracks: ChatAddedTrack[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const position = isSwap ? 'after_current' : 'end';
  const maxAdded = isSwap ? 1 : output.picks.length;
  for (const pick of output.picks) {
    const finalDecision = evaluateFinalQueuePick({
      userId,
      pick,
      mode: selectionModeForCandidate(pick)
    });
    if (finalDecision.action === 'reject') {
      skipped.push({ id: pick.id, reason: finalDecision.reasonCodes[0] ?? 'final_rejected' });
      continue;
    }
    const dedupeKey = buildTrackDedupeKey(pick);
    if (excludedIds.has(pick.id) || isTrackDedupeKeyExcluded(dedupeKey, excludedDedupeKeys)) {
      skipped.push({ id: pick.id, reason: 'queue_track_idempotency' });
      continue;
    }
    excludedIds.add(pick.id);
    if (dedupeKey) excludedDedupeKeys.add(dedupeKey);
    addedTracks.push({
      id: pick.id,
      name: pick.name ?? pick.id,
      artist: pick.artist ?? '未知艺人',
      selectionRationale: truncate(pick.reason || output.say, 1000) || 'Selected by MusicAgent chat recommendation.',
      source: pick.source,
      position
    });
    if (addedTracks.length >= maxAdded) break;
  }
  return { tracks: addedTracks, skipped };
}

function createAbortTimeoutSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error('timeout'));
  }, timeoutMs);
  const abortFromParent = (): void => {
    controller.abort(parentSignal?.reason ?? new Error('aborted'));
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  };
}

export function extractQueueDirectiveFromText(text: string, now = new Date()): { text: string; expiresAt: string } | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  const mentionsFemaleVocals = /女声|女歌手|女生唱|女嗓|女vocal|female\s*(vocal|singer|artist)/i.test(normalized);
  if (!mentionsFemaleVocals) return null;

  const cancelsFemaleVocals = /不要|别|不用|取消|停止|不想/.test(normalized);
  if (cancelsFemaleVocals) return {
    text: '',
    expiresAt: now.toISOString()
  };

  return {
    text: '接下来的自动选歌优先选择女声、女歌手或女性主唱作品；除非候选池明显不足，否则保持这个方向。',
    expiresAt: new Date(now.getTime() + ACTIVE_DIRECTIVE_TTL_MS).toISOString()
  };
}

function applyQueueDirectiveFallbackFromText(userId: string, text: string): void {
  const directive = extractQueueDirectiveFromText(text);
  if (!directive) return;

  if (!directive.text) {
    deletePref(userId, 'queue.activeDirective');
    appendDirectiveUpdatedEvent(userId, null, 'fallback');
    return;
  }

  const current = getPref<{ expiresAt?: string }>(userId, 'queue.activeDirective');
  if (current?.expiresAt && Date.parse(current.expiresAt) > Date.now()) return;
  setPref(userId, 'queue.activeDirective', directive);
  appendDirectiveUpdatedEvent(userId, directive.text, 'fallback');
}

function appendListenerRequestReceivedEvent(userId: string, messageId: number, text: string): void {
  appendDjEvent({
    userId,
    type: 'listener_request_received',
    payload: {
      messageId,
      requestSummary: truncate(text, 800)
    }
  });
}

function appendDirectiveUpdatedEvent(
  userId: string,
  directive: string | null,
  source: 'chat' | 'fallback'
): void {
  appendDjEvent({
    userId,
    type: 'directive_updated',
    payload: {
      directive: directive ? truncate(directive, 800) : null,
      source
    }
  });
}

function appendChatSelectionStartedEvent(input: {
  userId: string;
  runId: string;
  userText: string;
  targetCount: number;
}): DjEventRecord {
  return appendDjEvent({
    userId: input.userId,
    type: 'selection_started',
    correlationId: input.runId,
    runId: input.runId,
    payload: {
      trigger: 'chat_recommend',
      targetCount: input.targetCount,
      activeDirective: getActiveDirectiveText(input.userId),
      batchRationale: truncate(input.userText, 1000)
    }
  });
}

function appendChatRecommendationEvents(input: {
  userId: string;
  runId: string;
  selectionStartedEvent: DjEventRecord;
  tracks: ChatAddedTrack[];
  action: 'append' | 'swap_next';
  afterQueue: QueueTrack[];
}): void {
  const selectionEvents = input.tracks.map((track, index) => appendDjEvent({
    userId: input.userId,
    type: 'track_selected',
    correlationId: input.runId,
    causationEventId: input.selectionStartedEvent.id,
    runId: input.runId,
    trackId: track.id,
    payload: {
      trackId: track.id,
      trackName: track.name,
      artist: track.artist,
      selectionRationale: track.selectionRationale,
      source: track.source,
      pickOrder: index + 1
    }
  }));

  appendDjEvent({
    userId: input.userId,
    type: 'queue_changed',
    correlationId: input.runId,
    causationEventId: selectionEvents[selectionEvents.length - 1]?.id ?? input.selectionStartedEvent.id,
    runId: input.runId,
    payload: {
      action: input.action,
      trackIds: input.tracks.map((track) => track.id),
      position: input.action === 'swap_next' ? 'after_current' : 'end',
      afterQueuePreview: input.afterQueue.slice(0, 12).map((track) => ({
        id: track.ncmId,
        ...(track.name ? { name: track.name } : {}),
        ...(track.artists?.length ? { artist: track.artists.join(' / ') } : {})
      }))
    }
  });
}

function commitChatQueueSelection(input: {
  userId: string;
  runId: string;
  selectionStartedEvent: DjEventRecord;
  tracks: ChatAddedTrack[];
  action: 'append' | 'swap_next';
}): void {
  const queueTracks = input.tracks.map((track) => ({
    ncmId: track.id,
    name: track.name,
    artists: track.artist ? [track.artist] : []
  }));
  const position = input.action === 'swap_next' ? 'after_current' : 'end';
  const prepared = prepareChatQueueMutation(input.userId, queueTracks, position);
  getDb().transaction(() => {
    prepared.persist();
    appendChatRecommendationEvents({
      ...input,
      afterQueue: prepared.snapshot.queue
    });
    recordSelectionRotationExposure({
      userId: input.userId,
      runId: input.runId,
      tracks: queueTracks.map((track) => ({
        id: track.ncmId,
        name: track.name ?? track.ncmId,
        artists: track.artists ?? []
      }))
    });
  }).immediate();
  prepared.commitCache();
}

function commitDirectChatQueueTrack(input: {
  userId: string;
  runId: string;
  position: 'end' | 'after_current';
  track: { ncmId: string; name: string; artists: string[] };
}): void {
  const prepared = prepareChatQueueMutation(input.userId, [input.track], input.position);
  getDb().transaction(() => {
    prepared.persist();
    recordSelectionRotationExposure({
      userId: input.userId,
      runId: input.runId,
      tracks: [{
        id: input.track.ncmId,
        name: input.track.name,
        artists: input.track.artists
      }]
    });
  }).immediate();
  prepared.commitCache();
}

function prepareChatQueueMutation(
  userId: string,
  tracks: QueueTrack[],
  position: 'end' | 'after_current'
) {
  const currentQueue = getQueue(userId);
  const currentIndex = getCurrentIndex(userId);
  let queue = [...currentQueue];
  for (const track of tracks) {
    if (position === 'end') {
      queue = queue.filter((item) => item.ncmId !== track.ncmId);
      queue.push(track);
      continue;
    }
    if (queue.length === 0) {
      queue = [track];
      continue;
    }
    const insertAt = Math.min(currentIndex + 1, queue.length);
    queue.splice(insertAt, 0, track);
    const laterIndex = queue.findIndex(
      (item, index) => index > insertAt && item.ncmId === track.ncmId
    );
    if (laterIndex !== -1) queue.splice(laterIndex, 1);
  }
  return prepareQueueState(userId, queue, currentIndex);
}

function getActiveDirectiveText(userId: string): string | undefined {
  const directive = getPref<{ text?: string; expiresAt?: string }>(userId, 'queue.activeDirective');
  if (!directive?.expiresAt || Date.parse(directive.expiresAt) <= Date.now()) return undefined;
  const text = directive?.text?.trim();
  return text ? truncate(text, 800) : undefined;
}

function toChatProgressTracks(tracks: ChatAddedTrack[]): Array<{ name: string; artist: string }> {
  return tracks.map((track) => ({ name: track.name, artist: track.artist }));
}

function truncate(value: string | undefined, maxLength: number): string {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength);
}

function extractSayFromRawChat(raw: string): string {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  if (!cleaned) {
    return '抱歉，刚才没有生成有效回复。';
  }

  try {
    const parsed = JSON.parse(cleaned) as { say?: unknown };
    if (typeof parsed.say === 'string' && parsed.say.trim()) {
      return parsed.say.trim();
    }
  } catch {
    // Ignore parse failures and fall back to raw content.
  }

  return cleaned;
}
