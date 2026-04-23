import { z } from 'zod';

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  service: z.literal('crossfadio-local-brain'),
  uptimeSec: z.number().nonnegative(),
  dbReady: z.boolean(),
  timestamp: z.string()
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const wsAuthSchema = z.object({
  type: z.literal('auth'),
  token: z.string().min(1)
});

export type WsAuthMessage = z.infer<typeof wsAuthSchema>;
