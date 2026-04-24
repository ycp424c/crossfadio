import { getLogger } from './logger.js';
import { buildFallbackPlan } from './agent/plan-fallback.js';
import { resolveLlmConfig } from './llm/config.js';
import { computeSync } from './agent/compute.js';
import { buildSystemPrompt } from './agent/modes.js';
import { loadLatestPlan, savePlan, todayDateStr } from './store/plan.js';
import { getRecentPlays } from './store/plays.js';
import { loadUserCorpus } from './user-corpus/loader.js';
import { fetchWeather } from './weather.js';
import type { SecretStore } from './security.js';
import type { Fragments } from './agent/schema.js';

type SchedulerOptions = {
  secrets: SecretStore;
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
              playlists: corpus.playlists
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
    // Currently a no-op placeholder — future: segment transition hook
    scheduleNext(runHourlyCheck, msUntilNextHour());
  }

  function msUntilNextHour(): number {
    const now = new Date();
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next.getTime() - now.getTime();
  }

  // Start both loops
  scheduleNext(() => void runDailyPlan(), msUntilNext(7, 0));
  scheduleNext(runHourlyCheck, msUntilNextHour());

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
