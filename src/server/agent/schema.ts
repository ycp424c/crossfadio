import { z } from 'zod';

// ─── Shared sub-types ────────────────────────────────────────────────────────

export const trackQuerySchema = z.object({
  query: z.string().min(1),
  reason: z.string().optional()
});

export type TrackQuery = z.infer<typeof trackQuerySchema>;

export const trackSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  artist: z.string().optional()
});

export type Track = z.infer<typeof trackSchema>;

export const segueTrackContextSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  artist: z.string().min(1),
  lyricExcerpt: z.string().default(''),
  lyricKeywords: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([])
});

export type SegueTrackContext = z.infer<typeof segueTrackContextSchema>;

export const nowPlayingSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  artist: z.string(),
  durationMs: z.number().nullable()
});

export type NowPlaying = z.infer<typeof nowPlayingSchema>;

export const playlistRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string().default('ncm'),
  segments: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  energyRange: z.tuple([z.number(), z.number()]).optional(),
  priority: z.number().default(0)
});

export type PlaylistRef = z.infer<typeof playlistRefSchema>;

export const playRecordSchema = z.object({
  id: z.number(),
  song_id: z.string().nullable(),
  song_name: z.string().nullable(),
  artist_name: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  end_reason: z.string().nullable()
});

export type PlayRecord = z.infer<typeof playRecordSchema>;

export const messageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string()
});

export type AgentMessage = z.infer<typeof messageSchema>;

// ─── Fragments (6 slices) ────────────────────────────────────────────────────

export const fragmentsSchema = z.object({
  mode: z.enum(['plan', 'segue', 'chat']),

  // ① system prompt (dj-persona.md + mode-specific constraint appended by modes.ts)
  system: z.string(),

  // ② user corpus
  corpus: z.object({
    taste: z.string(),
    routines: z.string(),
    moodRules: z.string(),
    playlists: z.array(playlistRefSchema),
    likedTracks: z.array(trackSchema).default([])
  }),

  // ③ environment
  env: z.object({
    nowIso: z.string(),
    localTime: z.string(),
    weather: z.object({ tempC: z.number(), desc: z.string() }).nullable(),
    nowPlaying: nowPlayingSchema.nullable()
  }),

  // ④ memory
  memory: z.object({
    recentPlays: z.array(playRecordSchema),
    recentChat: z.array(messageSchema),
    recentSegues: z
      .array(
        z.object({
          fromName: z.string(),
          toName: z.string(),
          say: z.string(),
          createdAt: z.string()
        })
      )
      .optional()
  }),

  // ⑤ input
  input: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('chat'), text: z.string() }),
    z.object({
      kind: z.literal('segueTrigger'),
      from: trackSchema,
      to: trackSchema,
      context: z
        .object({
          from: segueTrackContextSchema,
          to: segueTrackContextSchema
        })
        .optional()
    }),
    z.object({ kind: z.literal('planRequest'), date: z.string() }),
    z.object({ kind: z.literal('toolResult'), tool: z.string(), data: z.unknown() })
  ]),

  // ⑥ trace
  trace: z.object({
    triggeredBy: z.enum(['scheduler', 'user', 'segue-hook']),
    lastDecision: z.unknown().nullable()
  })
});

export type Fragments = z.infer<typeof fragmentsSchema>;

// ─── Actions ─────────────────────────────────────────────────────────────────

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('swap_next'), pick: trackQuerySchema }),
  z.object({
    type: z.literal('add_to_queue'),
    pick: trackQuerySchema,
    position: z.enum(['end', 'after_current'])
  }),
  z.object({ type: z.literal('skip') }),
  z.object({ type: z.literal('ban_artist'), artist: z.string() }),
  z.object({ type: z.literal('ban_track'), title: z.string(), artist: z.string() }),
  z.object({
    type: z.literal('adjust_mood'),
    mood: z.string(),
    applyTo: z.enum(['remaining_segment', 'next_n']),
    n: z.number().optional()
  }),
  z.object({
    type: z.literal('replan_segment'),
    hint: z.object({
      mood: z.string().optional(),
      genre: z.string().optional(),
      bpmMin: z.number().optional(),
      bpmMax: z.number().optional(),
      durationMin: z.number(),
      count: z.number().optional()
    })
  }),
  z.object({ type: z.literal('set_pref'), key: z.string(), value: z.unknown() })
]);

export type Action = z.infer<typeof actionSchema>;

// ─── Output schemas (per mode) ───────────────────────────────────────────────

export const planOutputSchema = z.object({
  mode: z.literal('plan'),
  date: z.string(),
  segments: z.array(
    z.object({
      id: z.enum(['morning', 'work', 'evening', 'late-night']),
      label: z.string(),
      timeRange: z.string(),
      mood: z.string(),
      energyPct: z.number().min(0).max(100),
      tracks: z.array(z.object({ query: z.string(), reason: z.string() }))
    })
  ),
  narrative: z.string()
});

export type PlanOutput = z.infer<typeof planOutputSchema>;

export const segueOutputSchema = z.object({
  mode: z.literal('segue'),
  say: z.string().max(500),
  duckingHintSec: z.number().default(8),
  filterSweep: z.boolean().default(true),
  emotionTag: z.string()
});

export type SegueOutput = z.infer<typeof segueOutputSchema>;

export const chatOutputSchema = z.object({
  mode: z.literal('chat'),
  intent: z.enum(['chitchat', 'adjust_queue', 'replan', 'control', 'ask_meta']),
  say: z.string(),
  actions: z.array(actionSchema).default([])
});

export type ChatOutput = z.infer<typeof chatOutputSchema>;

export const agentOutputSchema = z.discriminatedUnion('mode', [
  planOutputSchema,
  segueOutputSchema,
  chatOutputSchema
]);

export type AgentOutput = z.infer<typeof agentOutputSchema>;

// ─── Streaming events ─────────────────────────────────────────────────────────

export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), say: z.string() }),
  z.object({ type: z.literal('done'), output: agentOutputSchema })
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;
