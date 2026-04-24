import type { RequestHandler } from 'express';
import { computeSync } from '../../agent/compute.js';
import { buildSystemPrompt } from '../../agent/modes.js';
import type { Fragments } from '../../agent/schema.js';
import { resolveLlmConfig } from '../../llm/config.js';
import type { NcmClient } from '../../ncm/client.js';
import type { SecretStore } from '../../security.js';
import { loadUserCorpus } from '../../user-corpus/loader.js';
import { loadLikedTracksForPlanning } from '../../user-corpus/ncm-liked.js';
import { getRecentPlays } from '../../store/plays.js';
import { getRecentMessages } from '../../store/messages.js';
import { getRecentSegues } from '../../store/segues.js';
import { fetchWeather } from '../../weather.js';
import { executeActions } from '../../agent/actions.js';
import { getQueue, addToQueue } from '../../store/queue.js';
import { broadcast } from '../broadcast.js';
import { getLogger } from '../../logger.js';

type DjNextOptions = {
  secrets: SecretStore;
  ncmClient: NcmClient;
};

export function createDjPickNextHandler(opts: DjNextOptions): RequestHandler {
  return (req, res) => {
    res.json({ ok: true });
    void runPickNextJob(opts);
  };
}

async function runPickNextJob(opts: DjNextOptions): Promise<void> {
  const logger = getLogger();

  try {
    const likedTracks = await loadLikedTracksForPlanning(opts.ncmClient);

    // Try LLM-based pick first
    const llmConfig = resolveLlmConfig(opts.secrets);
    if (llmConfig) {
      try {
        const corpus = loadUserCorpus();
        const weather = await fetchWeather();
        const now = new Date();
        const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
        const day = weekdays[now.getDay()];
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');

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
            recentPlays: getRecentPlays(50),
            recentChat: getRecentMessages(20),
            recentSegues: getRecentSegues(10)
          },
          input: {
            kind: 'chat',
            text: 'DJ，播放队列即将到尾声，请为队列末尾补充一首新歌。根据当前时间、天气、用户喜好、最近播放记录和过渡语风格，从红心歌单中选择最合适的歌曲，使用 add_to_queue 动作添加，position 设为 end。请勿重复最近刚播过的歌曲。say 字段简短说明选曲理由（一句话即可）。'
          },
          trace: { triggeredBy: 'scheduler', lastDecision: null }
        };

        const output = await computeSync(fragments, { llmConfig });
        if (output.mode === 'chat' && output.actions.length > 0) {
          const result = await executeActions(output.actions, { ncmClient: opts.ncmClient });
          if (result.queueChanged) {
            broadcastAppended();
            return;
          }
        }
        logger.warn({ mode: output.mode }, 'DJ pick-next: LLM returned no usable actions, falling back');
      } catch (err) {
        logger.warn({ err }, 'DJ pick-next: LLM failed, falling back to random pick');
      }
    }

    // Fallback: random pick from liked tracks, excluding recent plays and current queue
    const recentIds = new Set(
      getRecentPlays(30)
        .map((p) => p.song_id)
        .filter((id): id is string => id !== null)
    );
    const currentQueueIds = new Set(getQueue().map((t) => t.ncmId));
    const candidates = likedTracks.filter((t) => t.id && !recentIds.has(t.id) && !currentQueueIds.has(t.id));

    if (candidates.length === 0) {
      logger.warn('DJ pick-next fallback: no candidates available');
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
  } catch (err) {
    logger.warn({ err }, 'DJ pick-next job failed');
  }
}

function broadcastAppended(): void {
  const q = getQueue();
  const added = q[q.length - 1];
  if (added) {
    broadcast({ type: 'queue-appended', track: added });
  }
}
