import type { Request, Response } from 'express';
import { z } from 'zod';
import { computeSync } from '../../agent/compute.js';
import { buildSystemPrompt } from '../../agent/modes.js';
import { buildFallbackPlan } from '../../agent/plan-fallback.js';
import type { Fragments } from '../../agent/schema.js';
import { resolveLlmConfig } from '../../llm/config.js';
import type { NcmClient } from '../../ncm/client.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };
import type { NcmPlaylistDetail, NcmPlaylistTrack } from '../../../shared/schema.js';
import { resolveTrackQuery } from '../../ncm/resolver.js';
import type { SecretStore } from '../../security.js';
import { loadLatestPlan, savePlan, todayDateStr } from '../../store/plan.js';
import { getRecentPlays } from '../../store/plays.js';
import { loadLikedTracksForPlanning } from '../../user-corpus/ncm-liked.js';
import { loadUserCorpus } from '../../user-corpus/loader.js';
import { fetchWeather } from '../../weather.js';

function sampleN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

type PlanRouteOptions = {
  secrets: SecretStore;
  ncmClient: NcmClient;
};

// ─── Shared helpers ───────────────────────────────────────────────────────────

export async function buildPlanFragments(userId: string, date: string, ncmClient: NcmClient): Promise<Fragments> {
  const corpus = loadUserCorpus();
  const weather = await fetchWeather();
  const recentPlays = getRecentPlays(userId, 50);
  const likedTracks = await loadLikedTracksForPlanning(ncmClient);
  const now = new Date();

  return {
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
    memory: { recentPlays, recentChat: [] },
    input: { kind: 'planRequest', date },
    trace: { triggeredBy: 'user', lastDecision: null }
  };
}

async function generatePlan(userId: string, date: string, secrets: SecretStore, ncmClient: NcmClient) {
  const llmConfig = resolveLlmConfig();
  const corpus = loadUserCorpus();

  if (!llmConfig) {
    return buildFallbackPlan(date, corpus.playlists);
  }

  const fragments = await buildPlanFragments(userId, date, ncmClient);
  try {
    const output = await computeSync(fragments, { llmConfig });
    if (output.mode !== 'plan') throw new Error('unexpected mode');
    return output;
  } catch {
    return buildFallbackPlan(date, corpus.playlists);
  }
}

// ─── GET /api/plan/today ──────────────────────────────────────────────────────

export function createGetTodayPlanHandler(opts: PlanRouteOptions) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const date = todayDateStr();
      const userId = (req as AuthedRequest).userId;
      let plan = loadLatestPlan(userId, date);

      if (!plan) {
        plan = await generatePlan(userId, date, opts.secrets, opts.ncmClient);
        savePlan(userId, plan);
      }

      res.json({ ok: true, plan });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ ok: false, error: msg });
    }
  };
}

// ─── POST /api/plan/regenerate ────────────────────────────────────────────────

export function createRegeneratePlanHandler(opts: PlanRouteOptions) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const date = todayDateStr();
      const userId = (req as AuthedRequest).userId;
      const plan = await generatePlan(userId, date, opts.secrets, opts.ncmClient);
      savePlan(userId, plan);
      res.json({ ok: true, plan });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ ok: false, error: msg });
    }
  };
}

// ─── POST /api/plan/replan-segment ───────────────────────────────────────────

const replanSegmentBodySchema = z.object({
  segmentId: z.enum(['morning', 'work', 'evening', 'late-night']),
  hint: z
    .object({
      mood: z.string().optional(),
      genre: z.string().optional(),
      bpmMin: z.number().optional(),
      bpmMax: z.number().optional(),
      durationMin: z.number().optional(),
      count: z.number().optional()
    })
    .optional()
});

export function createReplanSegmentHandler(opts: PlanRouteOptions) {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = replanSegmentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }

    try {
      const date = todayDateStr();
      const userId = (req as AuthedRequest).userId;
      let plan = loadLatestPlan(userId, date) ?? (await generatePlan(userId, date, opts.secrets, opts.ncmClient));

      const { segmentId } = parsed.data;
      const corpus = loadUserCorpus();
      const llmConfig = resolveLlmConfig();

      if (llmConfig) {
        // Re-generate just this segment by creating a fresh full plan with a hint
        const fragments = await buildPlanFragments(userId, date, opts.ncmClient);
        const hintText = parsed.data.hint
          ? ` 重点要求：${JSON.stringify(parsed.data.hint)}`
          : '';
        fragments.input = {
          kind: 'planRequest',
          date: `${date}，仅更新时段 ${segmentId}${hintText}`
        };

        try {
          const newPlan = await computeSync(fragments, { llmConfig });
          if (newPlan.mode === 'plan') {
            const newSeg = newPlan.segments.find((s) => s.id === segmentId);
            if (newSeg) {
              plan = {
                ...plan,
                segments: plan.segments.map((s) => (s.id === segmentId ? newSeg : s))
              };
            }
          }
        } catch {
          // keep existing plan
        }
      } else {
        // Fallback: swap segment from fallback plan
        const fallback = buildFallbackPlan(date, corpus.playlists);
        const newSeg = fallback.segments.find((s) => s.id === segmentId);
        if (newSeg) {
          plan = {
            ...plan,
            segments: plan.segments.map((s) => (s.id === segmentId ? newSeg : s))
          };
        }
      }

      savePlan(userId, plan);
      res.json({ ok: true, plan });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ ok: false, error: msg });
    }
  };
}

// ─── POST /api/plan/gap-fill ──────────────────────────────────────────────────

const gapFillBodySchema = z.object({
  segmentId: z.enum(['morning', 'work', 'evening', 'late-night']),
  count: z.number().int().min(1).max(20).default(3),
  durationMin: z.number().positive().default(30),
  mood: z.string().optional()
});

export function createGapFillHandler(opts: PlanRouteOptions) {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = gapFillBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }

    try {
      const { segmentId, count, mood } = parsed.data;
      const userId = (req as AuthedRequest).userId;
      const corpus = loadUserCorpus();

      // Pick best playlist for this segment and resolve track IDs
      const segMoods: Record<string, string[]> = {
        morning: ['calm', 'indie'],
        work: ['focus', 'instrumental'],
        evening: ['chill', 'ambient'],
        'late-night': ['sleep', 'ambient']
      };

      const tags = mood
        ? [mood, ...(segMoods[segmentId] ?? [])]
        : (segMoods[segmentId] ?? []);

      const relevant = corpus.playlists
        .filter(
          (p) =>
            p.segments.includes(segmentId) ||
            p.tags.some((t) => tags.includes(t.toLowerCase()))
        )
        .sort((a, b) => a.priority - b.priority);

      // Sample randomly from the full liked list instead of always taking the first N
      const allLikedIds = await opts.ncmClient.getLikedSongIds().catch(() => [] as string[]);
      const sampledIds = sampleN(allLikedIds, count);
      const sampledDetails = await opts.ncmClient.getSongDetails(sampledIds).catch(() => []);
      const likedTracks = sampledDetails.map((t) => ({
        id: String(t.id),
        name: t.name,
        artist: t.artists.join(' / ') || undefined
      }));

      const playlistDetails = new Map<string, NcmPlaylistDetail | null>();
      const tracks: Array<{ query: string; ncmId: string | null }> = [];
      for (let i = 0; i < count; i++) {
        const likedTrack = likedTracks[i];
        if (likedTrack?.name) {
          tracks.push({
            query: likedTrack.artist ? `${likedTrack.name} — ${likedTrack.artist}` : likedTrack.name,
            ncmId: likedTrack.id
          });
          continue;
        }

        const playlist = relevant[i % Math.max(relevant.length, 1)];

        if (playlist) {
          const detail = await getCachedPlaylistDetail(playlist.id, opts.ncmClient, playlistDetails);
          const track = detail?.tracks[i % Math.max(detail.tracks.length, 1)];
          if (track) {
            tracks.push({ query: formatTrackQuery(track), ncmId: String(track.id) });
            continue;
          }
        }

        const query = `${mood ?? segmentId} music ${i + 1}`;
        const resolved = await resolveTrackQuery(query, opts.ncmClient).catch(() => null);

        tracks.push({ query, ncmId: resolved?.ncmId ?? null });
      }

      res.json({ ok: true, tracks });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ ok: false, error: msg });
    }
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatLocalTime(date: Date): string {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const day = weekdays[date.getDay()];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `周${day} ${hh}:${mm}`;
}

async function getCachedPlaylistDetail(
  playlistId: string,
  ncmClient: NcmClient,
  cache: Map<string, NcmPlaylistDetail | null>
): Promise<NcmPlaylistDetail | null> {
  if (cache.has(playlistId)) {
    return cache.get(playlistId) ?? null;
  }

  const detail = await ncmClient.getPlaylistDetail(playlistId).catch(() => null);
  cache.set(playlistId, detail);
  return detail;
}

function formatTrackQuery(track: NcmPlaylistTrack): string {
  const artists = track.artists.join(' / ');
  return artists ? `${track.name} — ${artists}` : track.name;
}
