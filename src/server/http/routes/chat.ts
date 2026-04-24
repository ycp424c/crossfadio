import type { WebSocket } from 'ws';
import { computeStream } from '../../agent/compute.js';
import { buildSystemPrompt } from '../../agent/modes.js';
import type { ChatOutput, Fragments } from '../../agent/schema.js';
import { resolveLlmConfig } from '../../llm/config.js';
import type { NcmClient } from '../../ncm/client.js';
import type { SecretStore } from '../../security.js';
import { loadUserCorpus } from '../../user-corpus/loader.js';
import { loadLikedTracksForPlanning } from '../../user-corpus/ncm-liked.js';
import { getRecentPlays } from '../../store/plays.js';
import { getRecentMessages, saveMessage } from '../../store/messages.js';
import { fetchWeather } from '../../weather.js';
import { executeActions } from '../../agent/actions.js';
import { getCurrentIndex, getQueue } from '../../store/queue.js';
import { broadcast } from '../broadcast.js';
import { getLogger } from '../../logger.js';

type ChatHandlerOptions = {
  secrets: SecretStore;
  ncmClient: NcmClient;
};

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
      memory: { recentPlays: getRecentPlays(50), recentChat: getRecentMessages(20) },
      input: { kind: 'chat', text },
      trace: { triggeredBy: 'user', lastDecision: null }
    };

    let fullSay = '';
    let chatOutput: ChatOutput | null = null;

    for await (const event of computeStream(fragments, { llmConfig })) {
      if (event.type === 'delta') {
        fullSay += event.say;
        send({ type: 'chat.delta', say: event.say });
      } else if (event.type === 'done' && event.output.mode === 'chat') {
        chatOutput = event.output;
      }
    }

    if (!chatOutput) {
      send({ type: 'chat.done', say: fullSay, intent: 'chitchat', actions: [] });
      saveMessage('assistant', fullSay);
      return;
    }

    saveMessage('assistant', chatOutput.say);
    send({
      type: 'chat.done',
      say: chatOutput.say,
      intent: chatOutput.intent,
      actions: chatOutput.actions
    });

    if (chatOutput.actions.length > 0) {
      const result = await executeActions(chatOutput.actions, { ncmClient: opts.ncmClient });
      if (result.queueChanged) {
        broadcast({ type: 'queue-updated', queue: getQueue(), currentIndex: getCurrentIndex() });
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Chat message handler error');
    send({ type: 'chat.error', error: err instanceof Error ? err.message : 'unknown error' });
  }
}

function formatLocalTime(date: Date): string {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const day = weekdays[date.getDay()];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `周${day} ${hh}:${mm}`;
}
