import { randomBytes } from 'node:crypto';
import { computeStream } from '../agent/compute.js';
import { buildSystemPrompt } from '../agent/modes.js';
import type { ChatOutput, Fragments, Track } from '../agent/schema.js';
import { resolveLlmConfig } from '../llm/config.js';
import { LlmClient } from '../llm/client.js';
import type { LlmConfig } from '../llm/client.js';
import type { NcmClient } from '../ncm/client.js';
import { loadUserCorpus } from '../user-corpus/loader.js';
import { loadLikedTracksForAgentContext } from '../user-corpus/ncm-liked.js';
import { getRecentPlays } from '../store/plays.js';
import { getRecentMessages, saveMessage } from '../store/messages.js';
import { getPreferenceContext } from '../store/chat-preferences.js';
import { getPref, deletePref, setPref } from '../store/prefs.js';
import { fetchWeather } from '../weather.js';
import { executeActions } from '../agent/actions.js';
import { getCurrentIndex, getQueue, addToQueue, swapNext } from '../store/queue.js';
import { appendDjEvent, type DjEventRecord } from '../store/dj-events.js';
import { broadcastToUser } from './broadcast.js';
import { getLogger } from '../logger.js';
import { buildTrackDedupeKey, isTrackDedupeKeyExcluded, searchCandidates } from './routes/djNext.js';
import { MusicAgent } from '../music-agent/index.js';
import { extractChatPreferencesIfDue } from '../music-agent/memory.js';
import type { MusicAgentRunOutput } from '../music-agent/schema.js';

const RECOMMEND_CANDIDATE_LIMIT = 20;
const RECOMMEND_PICK_LLM_TIMEOUT_MS = 30_000;
const ACTIVE_DIRECTIVE_TTL_MS = 6 * 60 * 60 * 1000;
const RECENT_PLAY_EXCLUDE_COUNT = 30;
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
    applyQueueDirectiveFallbackFromText(userId, text);

    const llmConfig = resolveLlmConfig(userId);
    if (!llmConfig) {
      const fallback = '抱歉，AI DJ 暂时不可用（未配置 LLM）。';
      send('chat.done', { say: fallback, intent: 'chitchat', actions: [] });
      saveMessage(userId, 'assistant', fallback);
      return;
    }

    if (signal?.aborted) return;

    const corpus = loadUserCorpus(userId);
    const likedTracks = await loadLikedTracksForAgentContext(ncmClient);
    if (signal?.aborted) return;
    const weather = await fetchWeather(userId);
    if (signal?.aborted) return;
    const now = new Date();

    const fragments: Fragments = {
      mode: 'chat',
      system: buildSystemPrompt(corpus.djPersona || 'You are a DJ.', 'chat'),
      corpus: {
        taste: corpus.taste,
        routines: corpus.routines,
        moodRules: corpus.moodRules,
        playlists: corpus.playlists,
        likedTracks
      },
      env: {
        nowIso: now.toISOString(),
        localTime: formatLocalTime(now),
        weather,
        nowPlaying: null
      },
      memory: {
        recentPlays: getRecentPlays(userId, 50),
        recentChat: getRecentMessages(userId, 20, 60),
        extractedPreferences: getPreferenceContext(userId, 3)
      },
      input: { kind: 'chat', text },
      trace: { triggeredBy: 'user', lastDecision: null }
    };

    let streamedRaw = '';
    let chatOutput: ChatOutput | null = null;

    for await (const event of computeStream(fragments, { llmConfig })) {
      if (signal?.aborted) return;
      if (event.type === 'delta') {
        streamedRaw += event.say;
      } else if (event.type === 'done' && event.output.mode === 'chat') {
        chatOutput = event.output;
      }
    }

    if (signal?.aborted) return;

    if (!chatOutput) {
      const fallback = extractSayFromRawChat(streamedRaw);
      send('chat.done', { say: fallback, intent: 'chitchat', actions: [] });
      saveMessage(userId, 'assistant', fallback);
      scheduleChatPreferenceExtraction(userId, llmConfig);
      return;
    }

    saveMessage(userId, 'assistant', chatOutput.say);
    send('chat.delta', { say: chatOutput.say });
    send('chat.done', {
      say: chatOutput.say,
      intent: chatOutput.intent,
      actions: chatOutput.actions
    });
    scheduleChatPreferenceExtraction(userId, llmConfig);

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
          let shouldRunLegacyFallback = false;
          try {
            reportProgress({ phase: 'agent' });
            const agent = new MusicAgent({ llmConfig });
            const agentAbort = createAbortTimeoutSignal(controller.signal, CHAT_AGENT_TIMEOUT_MS);
            try {
              const output = await agent.recommendFromChat({
                userId,
                ncmClient,
                userText: text,
                actions: songActions,
                signal: agentAbort.signal
              });

              if (controller.signal.aborted) {
                added = 0;
              } else if (output.status === 'aborted') {
                shouldRunLegacyFallback = agentAbort.timedOut();
              } else if (output.status === 'ok') {
                const addedTracks = applyMusicAgentPicks(
                  userId,
                  output,
                  isSwap
                );
                recommendationTracks = addedTracks;
                added = addedTracks.length;
                shouldRunLegacyFallback = added === 0;
                if (!shouldRunLegacyFallback && addedTracks.length > 0) {
                  reportProgress({ phase: 'done', tracks: toChatProgressTracks(addedTracks) });
                }
              } else {
                shouldRunLegacyFallback = output.status === 'empty_pool';
              }
            } finally {
              agentAbort.cleanup();
            }
          } catch (err) {
            logger.warn({ err, jobId }, 'Chat recommend MusicAgent error');
            shouldRunLegacyFallback = !controller.signal.aborted;
          }

          if (shouldRunLegacyFallback && !controller.signal.aborted) {
            recommendationTracks = await runChatRecommendPipeline(userId, {
              actions: songActions,
              likedTracks,
              ncmClient,
              llmConfig,
              userText: text,
              onProgress: reportProgress,
              signal: controller.signal
            });
            added = recommendationTracks.length;
          }
        } catch (err) {
          logger.warn({ err, jobId }, 'Chat recommend pipeline error');
          reportProgress({ phase: 'error', reason: err instanceof Error ? err.message : 'unknown' });
        } finally {
          activeRecommendJobs.delete(jobId);
          signal?.removeEventListener('abort', onParentAbort);
        }

        if (added > 0) {
          appendChatRecommendationEvents({
            userId,
            runId,
            selectionStartedEvent,
            tracks: recommendationTracks,
            action: isSwap ? 'swap_next' : 'append'
          });
          broadcastToUser(userId, { type: 'queue-updated', queue: getQueue(userId), currentIndex: getCurrentIndex(userId) });
        }

        // Still execute any non-song actions (skip, ban, etc.)
        const otherActions = chatOutput.actions.filter(
          (a) => a.type !== 'swap_next' && a.type !== 'add_to_queue'
        );
        if (otherActions.length > 0 && !signal?.aborted) {
          await executeActions(otherActions, {
            userId,
            ncmClient,
            onQueueActiveDirectiveUpdated: (directive) => appendDirectiveUpdatedEvent(userId, directive?.text ?? null, 'chat')
          });
        }
      } else {
        if (signal?.aborted) return;
        const result = await executeActions(chatOutput.actions, {
          userId,
          ncmClient,
          onQueueActiveDirectiveUpdated: (directive) => appendDirectiveUpdatedEvent(userId, directive?.text ?? null, 'chat')
        });
        if (result.queueChanged) {
          broadcastToUser(userId, { type: 'queue-updated', queue: getQueue(userId), currentIndex: getCurrentIndex(userId) });
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Chat message handler error');
    send('chat.error', { error: err instanceof Error ? err.message : 'unknown error' });
  }
}

type RecommendPipelineInput = {
  actions: Array<{ type: string; pick: { query: string }; position?: string }>;
  likedTracks: Track[];
  ncmClient: NcmClient;
  llmConfig: LlmConfig;
  userText: string;
  onProgress: (evt: Record<string, unknown>) => void;
  signal: AbortSignal;
};

type ChatAddedTrack = {
  id: string;
  name: string;
  artist: string;
  selectionRationale: string;
  source?: string;
  position: 'end' | 'after_current';
};

async function runChatRecommendPipeline(userId: string, input: RecommendPipelineInput): Promise<ChatAddedTrack[]> {
  const logger = getLogger();
  const { actions, likedTracks, ncmClient, llmConfig, userText, onProgress, signal } = input;
  const isSwap = actions.some((a) => a.type === 'swap_next');
  const maxAdded = isSwap ? 1 : 2;

  const keywords = actions
    .map((a) => a.pick.query)
    .filter((q) => q.trim().length > 0);

  if (keywords.length === 0) return [];

  onProgress({ phase: 'searching' });

  const recentIds = new Set(
    getRecentPlays(userId, RECENT_PLAY_EXCLUDE_COUNT)
      .map((p) => p.song_id)
      .filter((id): id is string => id !== null)
  );
  const currentQueueIds = new Set(getQueue(userId).map((t) => t.ncmId));
  const excludeIds = new Set([...recentIds, ...currentQueueIds]);

  if (signal.aborted) return [];

  const searchedTracks = await searchCandidates(
    keywords,
    ncmClient,
    excludeIds,
    RECOMMEND_CANDIDATE_LIMIT,
    signal
  );

  const likedSampleIds = new Set(likedTracks.map((t) => t.id));
  const allCandidates = [
    ...likedTracks.filter((t) => !excludeIds.has(t.id)),
    ...searchedTracks.filter((t) => !likedSampleIds.has(t.id))
  ];

  if (allCandidates.length === 0) {
    onProgress({ phase: 'error', reason: 'no-candidates' });
    return fallbackAddFromLiked(userId, likedTracks, excludeIds, actions.some((a) => a.type === 'swap_next'));
  }

  onProgress({ phase: 'picking', candidateCount: allCandidates.length });

  logger.info(
    { keywords, likedCount: likedTracks.length, searchedCount: searchedTracks.length, totalCandidates: allCandidates.length },
    'Chat recommend: built candidate pool'
  );

  const candidateList = allCandidates
    .map((t, i) => `${i + 1}. ${t.name ?? t.id} — ${t.artist ?? '未知艺人'}`)
    .join('\n');

  const pickSystemPrompt = `你是一个 DJ。根据候选歌曲列表和用户请求，挑选 ${maxAdded === 1 ? '1 首' : '1-2 首'}最匹配的歌曲。只输出 JSON 数组（1-based 索引），例如：[3]${maxAdded === 1 ? '' : ' 或 [3, 7]'}。不要输出任何其他内容。`;

  const pickUserPrompt = `<用户请求>${userText}</用户请求>
<候选歌曲>
${candidateList}
</候选歌曲>

从以上 ${allCandidates.length} 首候选中挑选 ${maxAdded === 1 ? '1 首' : '1-2 首'}最符合用户请求的歌曲。只输出 JSON 数组。`;

  let chosenIndices: number[] = [];
  try {
    if (signal.aborted) return [];
    const pickResp = await withTimeout(
      new LlmClient(llmConfig).complete(
        [
          { role: 'system', content: pickSystemPrompt },
          { role: 'user', content: pickUserPrompt }
        ],
        { signal: AbortSignal.timeout(RECOMMEND_PICK_LLM_TIMEOUT_MS) }
      ),
      RECOMMEND_PICK_LLM_TIMEOUT_MS + 5_000,
      { content: '[]', model: '' }
    );
    const cleaned = pickResp.content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();
    const match = cleaned.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed: unknown = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        chosenIndices = parsed
          .filter((n): n is number => typeof n === 'number' && n >= 1 && n <= allCandidates.length)
          .slice(0, maxAdded);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Chat recommend: LLM pick failed, using top search results');
  }

  if (signal.aborted) return [];

  if (chosenIndices.length === 0) {
    chosenIndices = allCandidates.slice(0, maxAdded).map((_, i) => i + 1);
  }

  const position = isSwap ? 'after_current' : 'end';
  const addedTracks: ChatAddedTrack[] = [];
  const alreadyQueued = new Set(getQueue(userId).map((t) => t.ncmId));
  for (const idx of chosenIndices) {
    const track = allCandidates[idx - 1];
    if (!track) continue;
    if (alreadyQueued.has(track.id)) continue;
    alreadyQueued.add(track.id);
    if (isSwap) {
      swapNext(userId, { ncmId: track.id, name: track.name, artists: track.artist ? [track.artist] : [] });
    } else {
      addToQueue(userId,
        { ncmId: track.id, name: track.name, artists: track.artist ? [track.artist] : [] },
        'end'
      );
    }
    addedTracks.push({
      id: track.id,
      name: track.name ?? track.id,
      artist: track.artist ?? '未知艺人',
      selectionRationale: 'Matched the listener chat recommendation request.',
      source: 'legacy_chat_recommend',
      position
    });
    if (addedTracks.length >= maxAdded) break;
  }

  onProgress({ phase: 'done', tracks: toChatProgressTracks(addedTracks) });

  logger.info({ added: addedTracks.length, chosenIndices, totalCandidates: allCandidates.length }, 'Chat recommend: added tracks');
  return addedTracks;
}

function applyMusicAgentPicks(
  userId: string,
  output: MusicAgentRunOutput,
  isSwap: boolean
): ChatAddedTrack[] {
  if (output.status !== 'ok') return [];

  const recentIds = new Set(
    getRecentPlays(userId, RECENT_PLAY_EXCLUDE_COUNT)
      .map((play) => play.song_id)
      .filter((id): id is string => id !== null)
  );
  const recentDedupeKeys = getRecentPlays(userId, RECENT_PLAY_EXCLUDE_COUNT)
    .map((play) => buildTrackDedupeKey({
      id: play.song_id,
      name: play.song_name,
      artist: play.artist_name
    }))
    .filter(Boolean);
  const queuedTracks = getQueue(userId);
  const queueDedupeKeys = queuedTracks
    .map((track) => buildTrackDedupeKey({
      id: track.ncmId,
      name: track.name,
      artists: track.artists
    }))
    .filter(Boolean);
  const excludedIds = new Set([...recentIds, ...queuedTracks.map((track) => track.ncmId)]);
  const excludedDedupeKeys = new Set([...recentDedupeKeys, ...queueDedupeKeys]);
  const addedTracks: ChatAddedTrack[] = [];
  const position = isSwap ? 'after_current' : 'end';
  const maxAdded = isSwap ? 1 : output.picks.length;
  for (const pick of output.picks) {
    const dedupeKey = buildTrackDedupeKey(pick);
    if (excludedIds.has(pick.id) || isTrackDedupeKeyExcluded(dedupeKey, excludedDedupeKeys)) continue;
    excludedIds.add(pick.id);
    if (dedupeKey) excludedDedupeKeys.add(dedupeKey);
    const track = {
      ncmId: pick.id,
      name: pick.name,
      artists: pick.artist ? [pick.artist] : []
    };
    if (isSwap) {
      swapNext(userId, track);
    } else {
      addToQueue(userId, track, 'end');
    }
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
  return addedTracks;
}

function scheduleChatPreferenceExtraction(userId: string, llmConfig: LlmConfig): void {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('memory-extraction-timeout')), 10_000);
  void extractChatPreferencesIfDue(userId, new LlmClient(llmConfig), controller.signal)
    .catch((err) => {
      getLogger().warn({ err }, 'Chat preference extraction failed');
    })
    .finally(() => clearTimeout(timeoutId));
}

function createAbortTimeoutSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let didTimeOut = false;
  const timeoutId = setTimeout(() => {
    didTimeOut = true;
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
    },
    timedOut: () => didTimeOut
  };
}

function fallbackAddFromLiked(
  userId: string,
  likedTracks: Track[],
  excludeIds: Set<string>,
  isSwap: boolean
): ChatAddedTrack[] {
  const logger = getLogger();
  const available = likedTracks.filter((t) => !excludeIds.has(t.id));
  if (available.length === 0) return [];

  const picked = sampleN(available, Math.min(isSwap ? 1 : 2, available.length));
  const addedTracks: ChatAddedTrack[] = [];
  for (const track of picked) {
    if (isSwap) {
      swapNext(userId, { ncmId: track.id, name: track.name, artists: track.artist ? [track.artist] : [] });
    } else {
      addToQueue(userId,
        { ncmId: track.id, name: track.name, artists: track.artist ? [track.artist] : [] },
        'end'
      );
    }
    addedTracks.push({
      id: track.id,
      name: track.name ?? track.id,
      artist: track.artist ?? '未知艺人',
      selectionRationale: 'Fallback matched a liked track to the listener chat request.',
      source: 'liked_fallback',
      position: isSwap ? 'after_current' : 'end'
    });
  }
  logger.info({ count: picked.length }, 'Chat recommend: fallback added from liked');
  return addedTracks;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

function sampleN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
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

  if (getPref(userId, 'queue.activeDirective')) return;
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
      afterQueuePreview: getQueue(input.userId).slice(0, 12).map((track) => ({
        id: track.ncmId,
        ...(track.name ? { name: track.name } : {}),
        ...(track.artists?.length ? { artist: track.artists.join(' / ') } : {})
      }))
    }
  });
}

function getActiveDirectiveText(userId: string): string | undefined {
  const directive = getPref<{ text?: string }>(userId, 'queue.activeDirective');
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

function formatLocalTime(date: Date): string {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const day = weekdays[date.getDay()];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `周${day} ${hh}:${mm}`;
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
