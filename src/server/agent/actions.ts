import { getLogger } from '../logger.js';
import { deletePref, setPref } from '../store/prefs.js';
import { swapNext, addToQueue, skipCurrent, banNcmId, getQueue } from '../store/queue.js';
import {
  buildTrackExclusionAliases,
  buildTrackExclusionKey,
  createExplicitExclusion,
  findMatchingExplicitExclusion,
  type ExclusionSourceRef
} from '../store/explicit-exclusions.js';
import { createPendingExplicitTrackExclusion } from '../store/explicit-exclusion-resolutions.js';
import { resolveTrackIdentity, resolveTrackQuery } from '../ncm/resolver.js';
import type { NcmClient } from '../ncm/client.js';
import { evaluatePlaybackEligibility } from '../music-agent/playback-eligibility.js';
import type { Action } from './schema.js';

export type ActionContext = {
  userId: string;
  ncmClient: NcmClient;
  sourceRef?: ExclusionSourceRef;
  logger?: Pick<ReturnType<typeof getLogger>, 'info' | 'warn'>;
  commitQueueTrack?: (input: {
    action: 'swap_next' | 'add_to_queue';
    actionIndex: number;
    position: 'end' | 'after_current';
    track: { ncmId: string; name: string; artists: string[] };
  }) => void;
  onQueueActiveDirectiveUpdated?: (directive: { text: string; expiresAt: string } | null) => void;
};

export type ActionResult = {
  queueChanged: boolean;
  addedTracks: Array<{ ncmId: string; name: string; artists: string[] }>;
};

/**
 * Executes a list of agent actions against the in-memory queue and prefs store.
 * Returns whether the queue changed (so caller can push queue-updated WS event).
 */
export async function executeActions(
  actions: Action[],
  ctx: ActionContext
): Promise<ActionResult> {
  const logger = ctx.logger ?? getLogger();
  let queueChanged = false;
  const addedTracks: ActionResult['addedTracks'] = [];
  const queuedIds = new Set(getQueue(ctx.userId).map((track) => track.ncmId));

  for (const [actionIndex, action] of actions.entries()) {
    try {
      switch (action.type) {
        case 'swap_next': {
          const resolved = await resolveDirectTrack(action.pick.query, ctx, queuedIds);
          if (resolved) {
            if (ctx.commitQueueTrack) {
              ctx.commitQueueTrack({
                action: 'swap_next',
                actionIndex,
                position: 'after_current',
                track: resolved
              });
            } else {
              swapNext(ctx.userId, resolved);
            }
            queuedIds.add(resolved.ncmId);
            addedTracks.push(resolved);
            queueChanged = true;
          }
          break;
        }
        case 'add_to_queue': {
          const resolved = await resolveDirectTrack(action.pick.query, ctx, queuedIds);
          if (resolved) {
            if (ctx.commitQueueTrack) {
              ctx.commitQueueTrack({
                action: 'add_to_queue',
                actionIndex,
                position: action.position,
                track: resolved
              });
            } else {
              addToQueue(ctx.userId, resolved, action.position);
            }
            queuedIds.add(resolved.ncmId);
            addedTracks.push(resolved);
            queueChanged = true;
          }
          break;
        }
        case 'skip': {
          skipCurrent(ctx.userId);
          queueChanged = true;
          break;
        }
        case 'ban_artist':
          createExplicitExclusion({
            userId: ctx.userId,
            entityType: 'artist',
            entityKey: action.artist,
            displayName: action.artist,
            sourceKind: 'agent_action',
            sourceRef: actionSourceRef(ctx, actionIndex)
          });
          break;
        case 'ban_track': {
          const resolution = await resolveTrackIdentity({
            title: action.title,
            artist: action.artist
          }, ctx.ncmClient);
          const resolved = resolution.status === 'resolved' ? resolution.track : null;
          const identity = {
            entityKey: buildTrackExclusionKey({
              provider: resolved ? 'ncm' : null,
              providerId: resolved?.ncmId ?? null,
              title: action.title,
              primaryArtist: action.artist
            }),
            aliases: buildTrackExclusionAliases({
              provider: resolved ? 'ncm' : null,
              providerId: resolved?.ncmId ?? null,
              title: action.title,
              primaryArtist: action.artist
            })
          };
          const sourceRef = actionSourceRef(ctx, actionIndex);
          if (resolved) {
            createExplicitExclusion({
              userId: ctx.userId,
              entityType: 'track',
              ...identity,
              provider: 'ncm',
              providerId: resolved.ncmId,
              displayName: action.title,
              sourceKind: 'agent_action',
              sourceRef
            });
          } else {
            createPendingExplicitTrackExclusion({
              userId: ctx.userId,
              ...identity,
              entityKey: `unresolved:${identity.entityKey}`,
              displayName: action.title,
              sourceKind: 'agent_action',
              sourceRef,
              queryTitle: action.title,
              queryArtist: action.artist
            });
          }
          if (resolved) {
            banNcmId(ctx.userId, resolved.ncmId);
            queuedIds.delete(resolved.ncmId);
            queueChanged = true;
          }
          break;
        }
        case 'adjust_mood':
          // Store mood adjustment as pref for future picks and segues.
          setPref(ctx.userId, 'queue.moodOverride', { mood: action.mood, applyTo: action.applyTo, n: action.n });
          break;
        case 'set_pref':
          applySetPrefAction(ctx.userId, action.key, action.value, ctx.onQueueActiveDirectiveUpdated);
          break;
        default:
          logger.warn({ action }, 'Unknown action type');
      }
    } catch (err) {
      logger.warn({ err, action }, 'Action execution failed, continuing');
    }
  }

  return { queueChanged, addedTracks };
}

async function resolveDirectTrack(
  query: string,
  ctx: ActionContext,
  queuedIds: ReadonlySet<string>
): Promise<{ ncmId: string; name: string; artists: string[] } | null> {
  const resolved = await resolveTrackQuery(query, ctx.ncmClient);
  if (!resolved || queuedIds.has(resolved.ncmId)) return null;

  const details = await ctx.ncmClient.getSongDetails([resolved.ncmId]).catch(() => []);
  const detail = details.find((track) => String(track.id) === resolved.ncmId) ?? details[0];
  const name = detail?.name?.trim() || resolved.name;
  const artists = detail?.artists?.map((artist) => artist.trim()).filter(Boolean) ?? resolved.artists;
  const artist = artists.join(' / ');
  const eligibility = evaluatePlaybackEligibility({
    id: resolved.ncmId,
    name,
    artist,
    ...(detail?.qualitySignals ? { qualitySignals: detail.qualitySignals } : {})
  });
  if (!eligibility.eligible) {
    ctx.logger?.info({ query, trackId: resolved.ncmId, reasons: eligibility.reasons },
      'Direct track action blocked by playback eligibility');
    return null;
  }

  const excluded = findMatchingExplicitExclusion(ctx.userId, {
    id: resolved.ncmId,
    name,
    artists
  });
  if (excluded) {
    ctx.logger?.info({ query, trackId: resolved.ncmId },
      'Direct track action blocked by explicit exclusion');
    return null;
  }

  return { ncmId: resolved.ncmId, name, artists };
}

function actionSourceRef(ctx: ActionContext, actionIndex: number): ExclusionSourceRef {
  return ctx.sourceRef ?? { sourceId: `agent_action:${Date.now()}:${actionIndex}` };
}

function applySetPrefAction(
  userId: string,
  key: string,
  value: unknown,
  onQueueActiveDirectiveUpdated?: (directive: { text: string; expiresAt: string } | null) => void
): void {
  if (key === 'queue.activeDirective') {
    const directive = normalizeQueueActiveDirective(value);
    if (!directive) {
      deletePref(userId, key);
      onQueueActiveDirectiveUpdated?.(null);
      return;
    }
    setPref(userId, key, directive);
    onQueueActiveDirectiveUpdated?.(directive);
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
    : 24;
  const expiresAt = typeof obj.expiresAt === 'string' && Number.isFinite(Date.parse(obj.expiresAt))
    ? obj.expiresAt
    : new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

  return { text, expiresAt };
}
