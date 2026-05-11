import { getLogger } from '../logger.js';
import { deletePref, setPref } from '../store/prefs.js';
import { swapNext, addToQueue, skipCurrent, banNcmId } from '../store/queue.js';
import { getRecentPlays } from '../store/plays.js';
import { resolveTrackQuery } from '../ncm/resolver.js';
import type { NcmClient } from '../ncm/client.js';
import type { Action } from './schema.js';

export type ActionContext = {
  userId: string;
  ncmClient: NcmClient;
};

export type ActionResult = {
  queueChanged: boolean;
};

/**
 * Executes a list of agent actions against the in-memory queue and prefs store.
 * Returns whether the queue changed (so caller can push queue-updated WS event).
 */
export async function executeActions(
  actions: Action[],
  ctx: ActionContext
): Promise<ActionResult> {
  const logger = getLogger();
  let queueChanged = false;

  const recentPlayIds = new Set(
    getRecentPlays(ctx.userId, 50)
      .map((p) => p.song_id)
      .filter((id): id is string => id !== null)
  );

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'swap_next': {
          const resolved = await resolveTrackQuery(action.pick.query, ctx.ncmClient);
          if (resolved && !recentPlayIds.has(resolved.ncmId)) {
            swapNext(ctx.userId, { ncmId: resolved.ncmId, name: resolved.name, artists: resolved.artists });
            queueChanged = true;
          } else if (resolved) {
            logger.info({ ncmId: resolved.ncmId, query: action.pick.query }, 'swap_next skipped: track recently played');
          }
          break;
        }
        case 'add_to_queue': {
          const resolved = await resolveTrackQuery(action.pick.query, ctx.ncmClient);
          if (resolved && !recentPlayIds.has(resolved.ncmId)) {
            addToQueue(ctx.userId, { ncmId: resolved.ncmId, name: resolved.name, artists: resolved.artists }, 'end');
            queueChanged = true;
          } else if (resolved) {
            logger.info({ ncmId: resolved.ncmId, query: action.pick.query }, 'add_to_queue skipped: track recently played');
          }
          break;
        }
        case 'skip': {
          skipCurrent(ctx.userId);
          queueChanged = true;
          break;
        }
        case 'ban_artist':
          // Artist bans are advisory — store as pref for future plan generation
          setPref(ctx.userId, `ban.artist.${action.artist}`, true);
          break;
        case 'ban_track': {
          const key = `${action.title}___${action.artist}`.toLowerCase();
          const resolved = await resolveTrackQuery(`${action.title} ${action.artist}`, ctx.ncmClient);
          if (resolved) {
            banNcmId(ctx.userId, resolved.ncmId);
            queueChanged = true;
          }
          setPref(ctx.userId, `ban.track.${key}`, true);
          break;
        }
        case 'adjust_mood':
          // Store mood adjustment as pref — future plan/segue picks it up
          setPref(ctx.userId, 'queue.moodOverride', { mood: action.mood, applyTo: action.applyTo, n: action.n });
          break;
        case 'replan_segment':
          // Replan is handled by the caller via the plan API; just record the hint
          setPref(ctx.userId, 'plan.replanHint', action.hint);
          break;
        case 'set_pref':
          applySetPrefAction(ctx.userId, action.key, action.value);
          break;
        default:
          logger.warn({ action }, 'Unknown action type');
      }
    } catch (err) {
      logger.warn({ err, action }, 'Action execution failed, continuing');
    }
  }

  return { queueChanged };
}

function applySetPrefAction(userId: string, key: string, value: unknown): void {
  if (key === 'queue.activeDirective') {
    const directive = normalizeQueueActiveDirective(value);
    if (!directive) {
      deletePref(userId, key);
      return;
    }
    setPref(userId, key, directive);
    return;
  }

  setPref(userId, key, value);
}

function normalizeQueueActiveDirective(value: unknown): { text: string; expiresAt: string } | null {
  if (value === null || value === false) return null;
  if (!value || typeof value !== 'object') return null;

  const obj = value as Record<string, unknown>;
  const text = typeof obj.text === 'string' ? obj.text.trim() : '';
  if (!text) return null;

  const ttlHours = typeof obj.ttlHours === 'number' && Number.isFinite(obj.ttlHours)
    ? Math.min(Math.max(obj.ttlHours, 0.25), 24)
    : 6;
  const expiresAt = typeof obj.expiresAt === 'string' && Number.isFinite(Date.parse(obj.expiresAt))
    ? obj.expiresAt
    : new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

  return { text, expiresAt };
}
