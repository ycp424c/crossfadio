import { describe, expect, it } from 'vitest';
import {
  getSegueRequestDecision,
  getSegueWaitingStatus,
  parseSegueTtsReadyPayload,
  shouldStartPendingSegueAudio
} from '../../src/renderer/playerSegueRuntime';

describe('player segue runtime', () => {
  it('requests segue only when audio is playing and a different next track is available', () => {
    const base = {
      hasAudio: true,
      audioPaused: false,
      currentTrackId: 'current',
      nextTrackId: 'next',
      satisfiedTrackId: null,
      activeRequestId: null,
      lastAttemptAt: 0,
      now: 10_000,
      retryCooldownMs: 6_000
    };

    expect(getSegueRequestDecision(base)).toEqual({ shouldRequest: true, reason: 'ready' });
    expect(getSegueRequestDecision({ ...base, nextTrackId: 'current' })).toEqual({
      shouldRequest: false,
      reason: 'same-track'
    });
    expect(getSegueRequestDecision({ ...base, activeRequestId: 'req-1' })).toEqual({
      shouldRequest: false,
      reason: 'in-flight'
    });
    expect(getSegueRequestDecision({ ...base, lastAttemptAt: 9_000 })).toEqual({
      shouldRequest: false,
      reason: 'cooldown'
    });
  });

  it('surfaces waiting segue status before a request has been attempted', () => {
    expect(getSegueWaitingStatus({
      currentTrackId: 'current',
      nextTrackId: null,
      satisfiedTrackId: null,
      activeRequestId: null,
      lastAttemptAt: 0
    })).toBe('已开播，等待下一首加入队列');

    expect(getSegueWaitingStatus({
      currentTrackId: 'current',
      nextTrackId: 'current',
      satisfiedTrackId: null,
      activeRequestId: null,
      lastAttemptAt: 0
    })).toBe('下一首与当前相同，跳过');

    expect(getSegueWaitingStatus({
      currentTrackId: 'current',
      nextTrackId: null,
      satisfiedTrackId: null,
      activeRequestId: 'req-1',
      lastAttemptAt: 0
    })).toBeNull();
  });

  it('parses tts-ready payload duration and text with speech duration taking precedence', () => {
    expect(parseSegueTtsReadyPayload({
      audioUrl: '/segue.mp3',
      speechDurationSec: 3.2,
      segue: { say: ' hello ', duckingHintSec: 8 }
    }, 6)).toEqual({
      audioUrl: '/segue.mp3',
      sayText: 'hello',
      estimatedDurationSec: 3.2
    });

    expect(parseSegueTtsReadyPayload({ segue: { duckingHintSec: 9 } }, 6)).toEqual({
      audioUrl: null,
      sayText: '',
      estimatedDurationSec: 9
    });
  });

  it('starts pending segue audio only at the duration-aware point', () => {
    const base = {
      hasTrackAudio: true,
      trackPaused: false,
      hasPendingAudio: true,
      pendingStarted: false,
      positionSec: 167,
      trackDurationSec: 180,
      crossfadeSec: 8,
      speechDurationSec: 12
    };

    expect(shouldStartPendingSegueAudio({ ...base, positionSec: 166.9 })).toBe(false);
    expect(shouldStartPendingSegueAudio(base)).toBe(true);
    expect(shouldStartPendingSegueAudio({ ...base, trackPaused: true })).toBe(false);
    expect(shouldStartPendingSegueAudio({ ...base, pendingStarted: true })).toBe(false);
  });
});
