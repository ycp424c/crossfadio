import { shouldStartSegueAudio } from './audio/seguePlayback';

export type SegueRequestDecisionReason =
  | 'ready'
  | 'audio-unavailable'
  | 'audio-paused'
  | 'missing-track'
  | 'same-track'
  | 'already-satisfied'
  | 'in-flight'
  | 'cooldown';

export type SegueRequestDecision = {
  shouldRequest: boolean;
  reason: SegueRequestDecisionReason;
};

export type SegueRequestDecisionInput = {
  hasAudio: boolean;
  audioPaused: boolean;
  currentTrackId: string | null;
  nextTrackId: string | null;
  satisfiedTrackId: string | null;
  activeRequestId: string | null;
  lastAttemptAt: number;
  now: number;
  retryCooldownMs: number;
};

export type SegueWaitingStatusInput = {
  currentTrackId: string | null;
  nextTrackId: string | null;
  satisfiedTrackId: string | null;
  activeRequestId: string | null;
  lastAttemptAt: number;
};

export type SegueTtsReadyPayload = {
  audioUrl: string | null;
  sayText: string;
  estimatedDurationSec: number;
};

export type PendingSegueAudioStartInput = {
  hasTrackAudio: boolean;
  trackPaused: boolean;
  hasPendingAudio: boolean;
  pendingStarted: boolean;
  positionSec: number;
  trackDurationSec: number;
  crossfadeSec: number;
  speechDurationSec: number;
};

export function getSegueRequestDecision(input: SegueRequestDecisionInput): SegueRequestDecision {
  if (!input.hasAudio) return { shouldRequest: false, reason: 'audio-unavailable' };
  if (input.audioPaused) return { shouldRequest: false, reason: 'audio-paused' };
  if (!input.currentTrackId || !input.nextTrackId) return { shouldRequest: false, reason: 'missing-track' };
  if (input.nextTrackId === input.currentTrackId) return { shouldRequest: false, reason: 'same-track' };
  if (input.satisfiedTrackId === input.currentTrackId) return { shouldRequest: false, reason: 'already-satisfied' };
  if (input.activeRequestId !== null) return { shouldRequest: false, reason: 'in-flight' };
  if (input.now - input.lastAttemptAt < input.retryCooldownMs) return { shouldRequest: false, reason: 'cooldown' };
  return { shouldRequest: true, reason: 'ready' };
}

export function getSegueWaitingStatus(input: SegueWaitingStatusInput): string | null {
  if (!input.currentTrackId) return null;
  const segueAttempted = input.satisfiedTrackId === input.currentTrackId
    || input.activeRequestId !== null
    || input.lastAttemptAt > 0;
  if (segueAttempted) return null;
  if (!input.nextTrackId) return '已开播，等待下一首加入队列';
  if (input.nextTrackId === input.currentTrackId) return '下一首与当前相同，跳过';
  return null;
}

export function parseSegueTtsReadyPayload(
  data: Record<string, unknown>,
  defaultDuckingHintSec: number
): SegueTtsReadyPayload {
  const segue = recordPayload(data.segue);
  const ttsHintSec = segue && 'duckingHintSec' in segue
    ? Number(segue.duckingHintSec)
    : NaN;
  const speechDurationSec = typeof data.speechDurationSec === 'number' && data.speechDurationSec > 0
    ? data.speechDurationSec
    : NaN;
  const estimatedDurationSec = Number.isFinite(speechDurationSec)
    ? Math.max(1, speechDurationSec)
    : Number.isFinite(ttsHintSec) && ttsHintSec > 0
      ? ttsHintSec
      : defaultDuckingHintSec;

  return {
    audioUrl: typeof data.audioUrl === 'string' ? data.audioUrl : null,
    sayText: segue && 'say' in segue ? String(segue.say).trim() : '',
    estimatedDurationSec
  };
}

export function shouldStartPendingSegueAudio(input: PendingSegueAudioStartInput): boolean {
  if (!input.hasTrackAudio || input.trackPaused || !input.hasPendingAudio || input.pendingStarted) return false;
  if (!Number.isFinite(input.trackDurationSec) || input.trackDurationSec <= 0) return false;
  return shouldStartSegueAudio({
    positionSec: input.positionSec,
    trackDurationSec: input.trackDurationSec,
    crossfadeSec: input.crossfadeSec,
    speechDurationSec: input.speechDurationSec
  });
}

function recordPayload(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}
