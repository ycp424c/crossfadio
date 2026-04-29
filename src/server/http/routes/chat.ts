import type { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { computeStream } from '../../agent/compute.js';
import { buildSystemPrompt } from '../../agent/modes.js';
import type { ChatOutput, Fragments, Track } from '../../agent/schema.js';
import { resolveLlmConfig } from '../../llm/config.js';
import { LlmClient } from '../../llm/client.js';
import type { LlmConfig } from '../../llm/client.js';
import type { NcmClient } from '../../ncm/client.js';
import type { SecretStore } from '../../security.js';
import { loadUserCorpus } from '../../user-corpus/loader.js';
import { loadLikedTracksForPlanning } from '../../user-corpus/ncm-liked.js';
import { getRecentPlays } from '../../store/plays.js';
import { getRecentMessages, saveMessage } from '../../store/messages.js';
import { getPreferenceContext } from '../../store/chat-preferences.js';
import { fetchWeather } from '../../weather.js';
import { executeActions } from '../../agent/actions.js';
import { getCurrentIndex, getQueue, addToQueue, swapNext } from '../../store/queue.js';
import { broadcast } from '../broadcast.js';
import { getLogger } from '../../logger.js';
import { searchCandidates } from './djNext.js';

type ChatHandlerOptions = {
  secrets: SecretStore;
  ncmClient: NcmClient;
};

const RECOMMEND_CANDIDATE_LIMIT = 20;
const RECOMMEND_PICK_LLM_TIMEOUT_MS = 30_000;

const activeRecommendJobs = new Map<string, AbortController>();

export function cancelChatRecommend(jobId: string): void {
  const controller = activeRecommendJobs.get(jobId);
  if (controller && !controller.signal.aborted) {
    controller.abort(new Error('user-cancelled'));
  }
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

export function createChatMessageHandler(opts: ChatHandlerOptions) {
  return (ws: WebSocket, text: string): void => {
    void handleChatMessage(ws, text, opts);
  };
}

async function handleChatMessage(
  ws: WebSocket,
  text: string,
  opts: ChatHandlerOptions
): Promise<void> {
  const logger = getLogger();

  const send = (payload: unknown): void => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  };

  try {
    saveMessage('user', text);

    const llmConfig = resolveLlmConfig(opts.secrets);
    if (!llmConfig) {
      const fallback = '抱歉，AI DJ 暂时不可用（未配置 LLM）。';
      send({ type: 'chat.done', say: fallback, intent: 'chitchat', actions: [] });
      saveMessage('assistant', fallback);
      return;
    }

    const corpus = loadUserCorpus();
    const likedTracks = await loadLikedTracksForPlanning(opts.ncmClient);
    const weather = await fetchWeather();
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
        recentPlays: getRecentPlays(50),
        recentChat: getRecentMessages(20, 60),
        extractedPreferences: getPreferenceContext(3)
      },
      input: { kind: 'chat', text },
      trace: { triggeredBy: 'user', lastDecision: null }
    };

    let streamedRaw = '';
    let chatOutput: ChatOutput | null = null;

    for await (const event of computeStream(fragments, { llmConfig })) {
      if (event.type === 'delta') {
        streamedRaw += event.say;
      } else if (event.type === 'done' && event.output.mode === 'chat') {
        chatOutput = event.output;
      }
    }

    if (!chatOutput) {
      const fallback = extractSayFromRawChat(streamedRaw);
      send({ type: 'chat.done', say: fallback, intent: 'chitchat', actions: [] });
      saveMessage('assistant', fallback);
      return;
    }

    saveMessage('assistant', chatOutput.say);
    send({ type: 'chat.delta', say: chatOutput.say });
    send({
      type: 'chat.done',
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
        const controller = new AbortController();
        activeRecommendJobs.set(jobId, controller);

        const reportProgress = (evt: Record<string, unknown>): void => {
          send({ type: 'chat.recommend.progress', jobId, ...evt });
        };

        send({ type: 'chat.recommend.started', jobId });

        const prevLen = getQueue().length;
        let added = 0;
        try {
          added = await runChatRecommendPipeline({
            actions: songActions,
            likedTracks,
            ncmClient: opts.ncmClient,
            llmConfig,
            userText: text,
            onProgress: reportProgress,
            signal: controller.signal
          });
        } catch (err) {
          logger.warn({ err, jobId }, 'Chat recommend pipeline error');
          reportProgress({ phase: 'error', reason: err instanceof Error ? err.message : 'unknown' });
        } finally {
          activeRecommendJobs.delete(jobId);
        }

        if (added > 0) {
          broadcast({ type: 'queue-updated', queue: getQueue(), currentIndex: getCurrentIndex() });
        }

        // Still execute any non-song actions (skip, ban, etc.)
        const otherActions = chatOutput.actions.filter(
          (a) => a.type !== 'swap_next' && a.type !== 'add_to_queue'
        );
        if (otherActions.length > 0) {
          await executeActions(otherActions, { ncmClient: opts.ncmClient });
        }
      } else {
        const result = await executeActions(chatOutput.actions, { ncmClient: opts.ncmClient });
        if (result.queueChanged) {
          broadcast({ type: 'queue-updated', queue: getQueue(), currentIndex: getCurrentIndex() });
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Chat message handler error');
    send({ type: 'chat.error', error: err instanceof Error ? err.message : 'unknown error' });
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

async function runChatRecommendPipeline(input: RecommendPipelineInput): Promise<number> {
  const logger = getLogger();
  const { actions, likedTracks, ncmClient, llmConfig, userText, onProgress, signal } = input;

  const keywords = actions
    .map((a) => a.pick.query)
    .filter((q) => q.trim().length > 0);

  if (keywords.length === 0) return 0;

  onProgress({ phase: 'searching' });

  const recentIds = new Set(
    getRecentPlays(30)
      .map((p) => p.song_id)
      .filter((id): id is string => id !== null)
  );
  const currentQueueIds = new Set(getQueue().map((t) => t.ncmId));
  const excludeIds = new Set([...recentIds, ...currentQueueIds]);

  if (signal.aborted) return 0;

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
    return fallbackAddFromLiked(likedTracks, excludeIds);
  }

  onProgress({ phase: 'picking', candidateCount: allCandidates.length });

  logger.info(
    { keywords, likedCount: likedTracks.length, searchedCount: searchedTracks.length, totalCandidates: allCandidates.length },
    'Chat recommend: built candidate pool'
  );

  const candidateList = allCandidates
    .map((t, i) => `${i + 1}. ${t.name ?? t.id} — ${t.artist ?? '未知艺人'}`)
    .join('\n');

  const pickSystemPrompt = `你是一个 DJ。根据候选歌曲列表和用户请求，挑选 1-2 首最匹配的歌曲。只输出 JSON 数组（1-based 索引），例如：[3] 或 [3, 7]。不要输出任何其他内容。`;

  const pickUserPrompt = `<用户请求>${userText}</用户请求>
<候选歌曲>
${candidateList}
</候选歌曲>

从以上 ${allCandidates.length} 首候选中挑选 1-2 首最符合用户请求的歌曲。只输出 JSON 数组。`;

  let chosenIndices: number[] = [];
  try {
    if (signal.aborted) return 0;
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
          .slice(0, 2);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Chat recommend: LLM pick failed, using top search results');
  }

  if (signal.aborted) return 0;

  if (chosenIndices.length === 0) {
    chosenIndices = allCandidates.slice(0, 2).map((_, i) => i + 1);
  }

  let added = 0;
  const addedTracks: Array<{ name: string; artist: string }> = [];
  const isSwap = actions.some((a) => a.type === 'swap_next');
  const alreadyQueued = new Set(getQueue().map((t) => t.ncmId));
  for (const idx of chosenIndices) {
    const track = allCandidates[idx - 1];
    if (!track) continue;
    if (alreadyQueued.has(track.id)) continue;
    alreadyQueued.add(track.id);
    if (isSwap) {
      swapNext({ ncmId: track.id, name: track.name, artists: track.artist ? [track.artist] : [] });
    } else {
      addToQueue(
        { ncmId: track.id, name: track.name, artists: track.artist ? [track.artist] : [] },
        'end'
      );
    }
    addedTracks.push({ name: track.name ?? track.id, artist: track.artist ?? '未知艺人' });
    added++;
  }

  onProgress({ phase: 'done', tracks: addedTracks });

  logger.info({ added, chosenIndices, totalCandidates: allCandidates.length }, 'Chat recommend: added tracks');
  return added;
}

function fallbackAddFromLiked(likedTracks: Track[], excludeIds: Set<string>): number {
  const logger = getLogger();
  const available = likedTracks.filter((t) => !excludeIds.has(t.id));
  if (available.length === 0) return 0;

  const picked = sampleN(available, Math.min(2, available.length));
  for (const track of picked) {
    addToQueue(
      { ncmId: track.id, name: track.name, artists: track.artist ? [track.artist] : [] },
      'end'
    );
  }
  logger.info({ count: picked.length }, 'Chat recommend: fallback added from liked');
  return picked.length;
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
