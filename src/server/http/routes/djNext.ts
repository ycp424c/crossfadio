import type { RequestHandler } from 'express';
import { computeSync } from '../../agent/compute.js';
import { buildSystemPrompt } from '../../agent/modes.js';
import type { Fragments, Track } from '../../agent/schema.js';
import { resolveLlmConfig } from '../../llm/config.js';
import type { NcmClient } from '../../ncm/client.js';
import type { SecretStore } from '../../security.js';
import { loadUserCorpus } from '../../user-corpus/loader.js';
import { loadLikedTracksForPlanning } from '../../user-corpus/ncm-liked.js';
import { getRecentPlays } from '../../store/plays.js';
import { getRecentMessages } from '../../store/messages.js';
import { getRecentSegues } from '../../store/segues.js';
import { getPreferenceContext } from '../../store/chat-preferences.js';
import { fetchWeather } from '../../weather.js';
import { executeActions } from '../../agent/actions.js';
import { getQueue, addToQueue } from '../../store/queue.js';
import { broadcast } from '../broadcast.js';
import { getLogger } from '../../logger.js';

type DjNextOptions = {
  secrets: SecretStore;
  ncmClient: NcmClient;
};

const JOB_TIMEOUT_MS = 20_000;
const LLM_TIMEOUT_MS = 15_000;
const LIKED_TRACKS_TIMEOUT_MS = 8_000;

let isRunning = false;
let likedTracksCache: Track[] = [];

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

export function createDjPickNextHandler(opts: DjNextOptions): RequestHandler {
  return (req, res) => {
    res.json({ ok: true, running: isRunning });
    if (!isRunning) {
      void runPickNextJob(opts);
    }
  };
}

async function runPickNextJob(opts: DjNextOptions): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  const logger = getLogger();

  const jobTimer = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), JOB_TIMEOUT_MS)
  );

  const jobResult = await Promise.race([doPickNext(opts).then(() => 'done' as const), jobTimer]);

  if (jobResult === 'timeout') {
    logger.warn('DJ pick-next job timed out after %dms', JOB_TIMEOUT_MS);
    broadcast({ type: 'dj.pick-next.done', added: false, reason: 'timeout' });
  }

  isRunning = false;
}

async function doPickNext(opts: DjNextOptions): Promise<void> {
  const logger = getLogger();

  // Load liked tracks with a hard timeout; use cache on miss
  const fresh = await withTimeout(
    loadLikedTracksForPlanning(opts.ncmClient),
    LIKED_TRACKS_TIMEOUT_MS,
    [] as Track[]
  );
  if (fresh.length > 0) likedTracksCache = fresh;
  const likedTracks = likedTracksCache;

  // Try LLM pick first
  const llmConfig = resolveLlmConfig(opts.secrets);
  if (!llmConfig) {
    logger.debug('DJ pick-next: skipping LLM pick because LLM config is missing');
  } else if (likedTracks.length === 0) {
    logger.warn('DJ pick-next: skipping LLM pick because liked tracks are unavailable');
  }

  if (llmConfig && likedTracks.length > 0) {
    try {
      const corpus = loadUserCorpus();
      const [weather] = await Promise.all([
        withTimeout(fetchWeather(), 4_000, null)
      ]);
      const now = new Date();
      const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
      const day = weekdays[now.getDay()];
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const recentPlays = getRecentPlays(50);
      const recentChat = getRecentMessages(20, 60);
      const recentSegues = getRecentSegues(10);
      const extractedPreferences = getPreferenceContext(3);

      logger.info(
        {
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          likedTrackCount: likedTracks.length,
          currentQueueCount: getQueue().length,
          recentPlayCount: recentPlays.length,
          recentChatCount: recentChat.length,
          recentSegueCount: recentSegues.length
        },
        'DJ pick-next: requesting LLM song pick'
      );

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
          localTime: `周${day} ${hh}:${mm}`,
          weather,
          nowPlaying: null
        },
        memory: {
          recentPlays,
          recentChat,
          recentSegues,
          extractedPreferences
        },
        input: {
          kind: 'chat',
          text: 'DJ，播放队列即将到尾声，请为队列末尾补充一首新歌。根据当前时间、天气、用户喜好、最近播放记录和过渡语风格，从红心歌单中选择最合适的歌曲，使用 add_to_queue 动作添加，position 设为 end。请勿重复最近刚播过的歌曲。say 字段简短说明选曲理由（一句话即可）。'
        },
        trace: { triggeredBy: 'scheduler', lastDecision: null }
      };

      const signal = AbortSignal.timeout(LLM_TIMEOUT_MS);
      const output = await computeSync(fragments, { llmConfig, signal });

      if (output.mode === 'chat' && output.actions.length > 0) {
        logger.info(
          {
            intent: output.intent,
            actionCount: output.actions.length,
            actionTypes: output.actions.map((action) => action.type)
          },
          'DJ pick-next: LLM returned candidate actions'
        );
        const result = await executeActions(output.actions, { ncmClient: opts.ncmClient });
        if (result.queueChanged) {
          broadcastAppended();
          return;
        }
        logger.warn(
          {
            intent: output.intent,
            actionCount: output.actions.length,
            actionTypes: output.actions.map((action) => action.type)
          },
          'DJ pick-next: LLM actions did not change queue, using random fallback'
        );
      }
      logger.warn(
        {
          mode: output.mode,
          intent: output.mode === 'chat' ? output.intent : undefined,
          actionCount: output.mode === 'chat' ? output.actions.length : undefined
        },
        'DJ pick-next: LLM returned no usable actions, using random fallback'
      );
    } catch (err) {
      logger.warn(
        {
          err: serializeDjPickNextErrorForLog(err),
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl,
          likedTrackCount: likedTracks.length,
          currentQueueCount: getQueue().length
        },
        'DJ pick-next: LLM failed, using random fallback'
      );
    }
  }

  // Random fallback: exclude recently played and current queue
  const recentIds = new Set(
    getRecentPlays(30)
      .map((p) => p.song_id)
      .filter((id): id is string => id !== null)
  );
  const currentQueueIds = new Set(getQueue().map((t) => t.ncmId));
  const candidates = likedTracks.filter((t) => t.id && !recentIds.has(t.id) && !currentQueueIds.has(t.id));

  if (candidates.length === 0) {
    logger.warn('DJ pick-next fallback: no candidates');
    broadcast({ type: 'dj.pick-next.done', added: false, reason: 'no-candidates' });
    return;
  }

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  addToQueue(
    {
      ncmId: pick.id,
      name: pick.name,
      artists: pick.artist ? pick.artist.split(' / ') : []
    },
    'end'
  );
  broadcastAppended();
}

function broadcastAppended(): void {
  const q = getQueue();
  const added = q[q.length - 1];
  if (added) {
    broadcast({ type: 'queue-appended', track: added });
    broadcast({ type: 'dj.pick-next.done', added: true, trackName: added.name });
  }
}

export function serializeDjPickNextErrorForLog(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const payload: Record<string, unknown> = {
    name: error.name,
    message: error.message
  };
  const errorWithDetails = error as Error & {
    status?: unknown;
    statusText?: unknown;
    responseBody?: unknown;
    cause?: unknown;
  };

  if (typeof errorWithDetails.status === 'number') {
    payload.status = errorWithDetails.status;
  }
  if (typeof errorWithDetails.statusText === 'string' && errorWithDetails.statusText.length > 0) {
    payload.statusText = errorWithDetails.statusText;
  }
  if (typeof errorWithDetails.responseBody === 'string' && errorWithDetails.responseBody.length > 0) {
    payload.responseBody = errorWithDetails.responseBody;
  }
  if (errorWithDetails.cause instanceof Error) {
    payload.cause = {
      name: errorWithDetails.cause.name,
      message: errorWithDetails.cause.message
    };
  } else if (errorWithDetails.cause !== undefined) {
    payload.cause = String(errorWithDetails.cause);
  }

  return payload;
}
