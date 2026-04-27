import { getLogger } from './logger.js';
import { buildFallbackPlan } from './agent/plan-fallback.js';
import { resolveLlmConfig } from './llm/config.js';
import { LlmClient } from './llm/client.js';
import { computeSync } from './agent/compute.js';
import { buildSystemPrompt } from './agent/modes.js';
import { loadLatestPlan, savePlan, todayDateStr } from './store/plan.js';
import { getRecentPlays } from './store/plays.js';
import { getUnextractedMessages, markMessagesExtracted } from './store/messages.js';
import { saveChatPreference } from './store/chat-preferences.js';
import { loadLikedTracksForPlanning } from './user-corpus/ncm-liked.js';
import { loadUserCorpus } from './user-corpus/loader.js';
import { fetchWeather } from './weather.js';
import type { SecretStore } from './security.js';
import type { Fragments } from './agent/schema.js';
import type { NcmClient } from './ncm/client.js';

const PREFERENCE_EXTRACTION_MIN_MESSAGES = 3;
const PREFERENCE_EXTRACTION_INTERVAL_MS = 30 * 60 * 1000;

type SchedulerOptions = {
  secrets: SecretStore;
  ncmClient?: NcmClient;
};

type SchedulerHandle = {
  stop: () => void;
};

let handle: SchedulerHandle | null = null;

export function startScheduler(opts: SchedulerOptions): SchedulerHandle {
  if (handle) return handle;

  const logger = getLogger();
  let stopped = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  function scheduleNext(fn: () => void, delayMs: number): void {
    if (stopped) return;
    const t = setTimeout(() => {
      if (!stopped) fn();
    }, delayMs);
    timers.push(t);
  }

  function msUntilNext(hour: number, minute = 0): number {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  // ─── Daily 07:00 planning ─────────────────────────────────────────────────

  async function runDailyPlan(): Promise<void> {
    const date = todayDateStr();
    logger.info({ date }, 'Scheduler: running daily plan');

    try {
      const corpus = loadUserCorpus();
      const llmConfig = resolveLlmConfig(opts.secrets);
      const likedTracks = opts.ncmClient ? await loadLikedTracksForPlanning(opts.ncmClient) : [];
      let plan = loadLatestPlan(date);

      if (!plan) {
        if (llmConfig) {
          const weather = await fetchWeather();
          const now = new Date();
          const fragments: Fragments = {
            mode: 'plan',
            system: buildSystemPrompt(corpus.djPersona || 'You are a DJ.', 'plan'),
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
            memory: { recentPlays: getRecentPlays(50), recentChat: [] },
            input: { kind: 'planRequest', date },
            trace: { triggeredBy: 'scheduler', lastDecision: null }
          };

          try {
            const output = await computeSync(fragments, { llmConfig });
            if (output.mode === 'plan') plan = output;
          } catch (err) {
            logger.warn({ err }, 'Scheduler: LLM plan failed, using fallback');
          }
        }

        plan = plan ?? buildFallbackPlan(date, corpus.playlists);
        savePlan(plan);
        logger.info({ date }, 'Scheduler: plan saved');
      }
    } catch (err) {
      logger.error({ err }, 'Scheduler: daily plan error');
    }

    // Schedule next day
    scheduleNext(() => void runDailyPlan(), msUntilNext(7, 0));
  }

  // ─── Hourly mood check ────────────────────────────────────────────────────

  function runHourlyCheck(): void {
    logger.debug('Scheduler: hourly check');
    scheduleNext(runHourlyCheck, msUntilNextHour());
  }

  function msUntilNextHour(): number {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next.getTime() - now.getTime();
  }

  // ─── Preference extraction (every 30 min) ────────────────────────────────

  async function runPreferenceExtraction(): Promise<void> {
    const llmConfig = resolveLlmConfig(opts.secrets);
    if (!llmConfig) {
      scheduleNext(() => void runPreferenceExtraction(), PREFERENCE_EXTRACTION_INTERVAL_MS);
      return;
    }

    try {
      const unextracted = getUnextractedMessages();
      if (unextracted.length < PREFERENCE_EXTRACTION_MIN_MESSAGES) {
        scheduleNext(() => void runPreferenceExtraction(), PREFERENCE_EXTRACTION_INTERVAL_MS);
        return;
      }

      logger.info({ count: unextracted.length }, 'Scheduler: extracting preferences from chat');

      const chatText = unextracted
        .map((m) => `${m.role === 'user' ? '用户' : 'DJ'}：${m.content}`)
        .join('\n');

      const client = new LlmClient(llmConfig);
      const response = await client.complete([
        {
          role: 'system',
          content: '你是一个音乐偏好分析助手。请从以下对话中提取用户对音乐的偏好、情绪需求和聆听习惯，用简洁中文概括（不超过200字）。只输出偏好摘要，不要解释。'
        },
        { role: 'user', content: `对话记录：\n${chatText}\n\n请提取用户音乐偏好：` }
      ]);

      const summary = response.content.trim();
      if (summary) {
        const ids = unextracted.map((m) => m.id);
        saveChatPreference(summary, ids);
        markMessagesExtracted(ids);
        logger.info({ messageCount: ids.length }, 'Scheduler: preferences extracted and saved');
      }
    } catch (err) {
      logger.warn({ err }, 'Scheduler: preference extraction failed');
    }

    scheduleNext(() => void runPreferenceExtraction(), PREFERENCE_EXTRACTION_INTERVAL_MS);
  }

  // Start all loops
  scheduleNext(() => void runDailyPlan(), msUntilNext(7, 0));
  scheduleNext(runHourlyCheck, msUntilNextHour());
  scheduleNext(() => void runPreferenceExtraction(), PREFERENCE_EXTRACTION_INTERVAL_MS);

  // Also run planning immediately if no plan exists today
  void (async () => {
    const date = todayDateStr();
    if (!loadLatestPlan(date)) {
      await runDailyPlan();
    }
  })();

  handle = {
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      handle = null;
    }
  };

  return handle;
}

export function stopScheduler(): void {
  handle?.stop();
}

function formatLocalTime(date: Date): string {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const day = weekdays[date.getDay()];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `周${day} ${hh}:${mm}`;
}
