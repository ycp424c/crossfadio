import { z } from 'zod';
import { djMemoryProjectionSchema } from '../../shared/dj-memory.js';

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
  content: z.string(),
  created_at: z.string().optional()
});

export type AgentMessage = z.infer<typeof messageSchema>;

// ─── Fragments ───────────────────────────────────────────────────────────────

export const fragmentsSchema = z.object({
  mode: z.enum(['segue', 'chat']),
  system: z.string(),
  djMemory: djMemoryProjectionSchema,
  input: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('chat'), text: z.string() }),
    z.object({
      kind: z.literal('segueTrigger'),
      from: trackSchema,
      to: trackSchema,
      context: z
        .object({
          from: segueTrackContextSchema,
          to: segueTrackContextSchema,
          djPickReason: z.string().optional(),
          selectionRationale: z.string().optional(),
          selectionEventId: z.string().optional()
        })
        .optional()
    }),
    z.object({ kind: z.literal('toolResult'), tool: z.string(), data: z.unknown() })
  ]),

  trace: z.object({
    triggeredBy: z.enum(['scheduler', 'user', 'segue-hook']),
    lastDecision: z.unknown().nullable()
  })
}).strict().superRefine((fragments, ctx) => {
  if (fragments.mode !== fragments.djMemory.purpose) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['djMemory', 'purpose'],
      message: `DJ Memory purpose ${fragments.djMemory.purpose} does not match mode ${fragments.mode}`
    });
  }
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
  z.object({ type: z.literal('set_pref'), key: z.string(), value: z.unknown() })
]);

export type Action = z.infer<typeof actionSchema>;

// ─── Output schemas (per mode) ───────────────────────────────────────────────

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
  intent: z.enum(['chitchat', 'adjust_queue', 'control', 'ask_meta']),
  say: z.string(),
  actions: z.array(actionSchema).default([])
});

export type ChatOutput = z.infer<typeof chatOutputSchema>;

export const agentOutputSchema = z.discriminatedUnion('mode', [
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
