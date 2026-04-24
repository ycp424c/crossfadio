import { getLogger } from '../logger.js';
import { setPref } from '../store/prefs.js';
import { swapNext, addToQueue, skipCurrent, banNcmId } from '../store/queue.js';
import { resolveTrackQuery } from '../ncm/resolver.js';
import type { NcmClient } from '../ncm/client.js';
import type { Action } from './schema.js';

export type ActionContext = {
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

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'swap_next': {
          const ncmId = await resolveTrackQuery(action.pick.query, ctx.ncmClient);
          if (ncmId) {
            swapNext({ ncmId, query: action.pick.query });
            queueChanged = true;
          }
          break;
        }
        case 'add_to_queue': {
          const ncmId = await resolveTrackQuery(action.pick.query, ctx.ncmClient);
          if (ncmId) {
            addToQueue({ ncmId, query: action.pick.query }, action.position);
            queueChanged = true;
          }
          break;
        }
        case 'skip': {
          skipCurrent();
          queueChanged = true;
          break;
        }
        case 'ban_artist':
          // Artist bans are advisory — store as pref for future plan generation
          setPref(`ban.artist.${action.artist}`, true);
          break;
        case 'ban_track': {
          const key = `${action.title}___${action.artist}`.toLowerCase();
          const ncmId = await resolveTrackQuery(`${action.title} ${action.artist}`, ctx.ncmClient);
          if (ncmId) {
            banNcmId(ncmId);
            queueChanged = true;
          }
          setPref(`ban.track.${key}`, true);
          break;
        }
        case 'adjust_mood':
          // Store mood adjustment as pref — future plan/segue picks it up
          setPref('queue.moodOverride', { mood: action.mood, applyTo: action.applyTo, n: action.n });
          break;
        case 'replan_segment':
          // Replan is handled by the caller via the plan API; just record the hint
          setPref('plan.replanHint', action.hint);
          break;
        case 'set_pref':
          setPref(action.key, action.value);
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
