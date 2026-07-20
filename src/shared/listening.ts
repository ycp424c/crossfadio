import { z } from 'zod';

export const LISTENING_PROTOCOL_VERSION = 2 as const;
export const LISTENING_EPISODE_DAILY_LIMIT = 500;

const nonnegativeMillisecondsSchema = z.number().finite().nonnegative()
  .transform((value) => Math.round(value))
  .pipe(z.number().int().nonnegative());
const positiveMillisecondsSchema = z.number().finite().positive()
  .transform((value) => Math.round(value))
  .pipe(z.number().int().positive());

export const listeningTrackIdentitySchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  artists: z.array(z.string().trim().min(1).max(200)).max(20)
}).strict();

export const listeningEpisodeCreateSchema = z.object({
  playerInstanceId: z.string().trim().min(1).max(100),
  deckId: z.string().trim().min(1).max(40),
  track: listeningTrackIdentitySchema,
  durationMs: positiveMillisecondsSchema.nullable(),
  checkpointSeq: z.literal(0)
}).strict();

export const listeningEpisodeCheckpointSchema = z.object({
  checkpointSeq: z.number().int().positive(),
  positionMs: nonnegativeMillisecondsSchema,
  listenedMs: nonnegativeMillisecondsSchema,
  durationMs: positiveMillisecondsSchema.nullable()
}).strict();

export const playbackOutcomeSchema = z.enum([
  'completed',
  'skipped',
  'failed',
  'interrupted'
]);

export const listeningEpisodeFinalizeSchema = listeningEpisodeCheckpointSchema.extend({
  outcome: playbackOutcomeSchema
}).strict();

export const listeningEpisodeKeepaliveCheckpointSchema = z.object({
  create: listeningEpisodeCreateSchema,
  checkpoint: listeningEpisodeCheckpointSchema
}).strict();

export type ListeningTrackIdentity = z.infer<typeof listeningTrackIdentitySchema>;
export type ListeningEpisodeCreate = z.infer<typeof listeningEpisodeCreateSchema>;
export type ListeningEpisodeCheckpoint = z.infer<typeof listeningEpisodeCheckpointSchema>;
export type PlaybackOutcome = z.infer<typeof playbackOutcomeSchema>;
export type ListeningEpisodeFinalize = z.infer<typeof listeningEpisodeFinalizeSchema>;
export type ListeningEpisodeKeepaliveCheckpoint = z.infer<
  typeof listeningEpisodeKeepaliveCheckpointSchema
>;
