import type { DjMemorySessionItem } from './schema.js';

export type DjSessionContinuityPurpose = 'chat' | 'selection' | 'segue';
export type DjSessionEventInput = {
  id: string;
  type: string;
  createdAt: string;
  payload: unknown;
};

const SESSION_WINDOW_MS = 24 * 60 * 60 * 1_000;

export function buildDjSessionContinuity(
  events: DjSessionEventInput[],
  purpose: DjSessionContinuityPurpose,
  now = new Date()
): DjMemorySessionItem[] {
  const cutoff = now.getTime() - SESSION_WINDOW_MS;
  return events
    .filter((event) => {
      const occurredAt = Date.parse(event.createdAt);
      return Number.isFinite(occurredAt) && occurredAt >= cutoff && occurredAt <= now.getTime();
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .flatMap((event) => projectEvent(event, purpose))
    .slice(0, 20);
}

function projectEvent(
  event: DjSessionEventInput,
  purpose: DjSessionContinuityPurpose
): DjMemorySessionItem[] {
  const payload = record(event.payload);
  if (!payload) return [];
  if ((purpose === 'chat' || purpose === 'selection') && event.type === 'listener_request_received') {
    return item(event, 'request_summary', payload.requestSummary);
  }
  if ((purpose === 'selection' || purpose === 'segue') && event.type === 'track_selected') {
    return item(event, 'selection_reason', payload.selectionRationale);
  }
  if (purpose === 'segue' && event.type === 'segue_generated') {
    return item(event, 'segue_summary', payload.segueSummary);
  }
  if (purpose === 'chat' && event.type === 'directive_updated') {
    return item(event, 'directive_history', payload.directive);
  }
  if (purpose === 'chat' && event.type === 'queue_changed') {
    return item(event, 'queue_action', payload.action);
  }
  return [];
}

function item(
  event: DjSessionEventInput,
  kind: DjMemorySessionItem['kind'],
  value: unknown
): DjMemorySessionItem[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  return [{ id: event.id, kind, text: value.trim().slice(0, 1000), occurredAt: event.createdAt }];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
