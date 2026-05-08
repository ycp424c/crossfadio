import { broadcastSse } from './routes/sse-events.js';

// registerWss kept for backward compat during migration
export function registerWss(_instance: unknown): void { /* noop during SSE migration */ }

export function broadcastToUser(userId: string, payload: unknown): void {
  const data = payload as Record<string, unknown>;
  const type = typeof data.type === 'string' ? data.type : 'unknown';
  broadcastSse(userId, type, data);
}
