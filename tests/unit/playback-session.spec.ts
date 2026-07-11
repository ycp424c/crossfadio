import { describe, expect, it, vi } from 'vitest';
import {
  createPlaybackSession,
  type MediaSessionLike,
  type PlaybackDocument,
  type WakeLockSentinelLike,
} from '../../src/renderer/playbackSession';

class FakeDocument implements PlaybackDocument {
  visibilityState: DocumentVisibilityState = 'visible';
  private listeners = new Set<() => void>();

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  dispatchVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    for (const listener of this.listeners) listener();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  releaseCalls = 0;
  private listeners = new Set<() => void>();

  addEventListener(_type: 'release', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'release', listener: () => void): void {
    this.listeners.delete(listener);
  }

  async release(): Promise<void> {
    this.releaseCalls += 1;
    this.released = true;
    for (const listener of this.listeners) listener();
  }

  systemRelease(): void {
    this.released = true;
    for (const listener of this.listeners) listener();
  }
}

function fakeMediaSession(): MediaSessionLike & {
  handlers: Map<string, MediaSessionActionHandler | null>;
  positionCalls: MediaPositionState[];
} {
  const handlers = new Map<string, MediaSessionActionHandler | null>();
  const positionCalls: MediaPositionState[] = [];
  return {
    metadata: null,
    playbackState: 'none',
    handlers,
    positionCalls,
    setActionHandler(action, handler) {
      handlers.set(action, handler);
    },
    setPositionState(state) {
      positionCalls.push(state!);
    },
  };
}

describe('PlaybackSession', () => {
  it('requests and releases wake lock around confirmed playback', async () => {
    const document = new FakeDocument();
    const sentinel = new FakeSentinel();
    const statuses: string[] = [];
    const request = vi.fn(async () => sentinel);
    const session = createPlaybackSession({
      document,
      wakeLock: { request },
      onWakeLockStatusChange: (status) => statuses.push(status),
    });

    session.setPlaying(true);
    await session.settle();
    expect(request).toHaveBeenCalledWith('screen');
    expect(statuses.at(-1)).toBe('active');

    session.setPlaying(false);
    await session.settle();
    expect(sentinel.releaseCalls).toBe(1);
    expect(statuses.at(-1)).toBe('inactive');
  });

  it('reports unsupported or unavailable without blocking and retries on a later transition', async () => {
    const unsupported: string[] = [];
    const noWakeLock = createPlaybackSession({ onWakeLockStatusChange: (s) => unsupported.push(s) });
    noWakeLock.setPlaying(true);
    await noWakeLock.settle();
    expect(unsupported.at(-1)).toBe('unsupported');

    const sentinel = new FakeSentinel();
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValueOnce(sentinel);
    const statuses: string[] = [];
    const session = createPlaybackSession({ wakeLock: { request }, onWakeLockStatusChange: (s) => statuses.push(s) });
    session.setPlaying(true);
    await session.settle();
    expect(statuses.at(-1)).toBe('unavailable');
    expect(request).toHaveBeenCalledTimes(1);
    session.setPlaying(true);
    await session.settle();
    expect(request).toHaveBeenCalledTimes(1);
    session.setPlaying(false);
    session.setPlaying(true);
    await session.settle();
    expect(request).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe('active');
  });

  it('reacquires after system release only on a visible restoration and ignores stale release', async () => {
    const document = new FakeDocument();
    const first = new FakeSentinel();
    const second = new FakeSentinel();
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const session = createPlaybackSession({ document, wakeLock: { request } });
    session.setPlaying(true);
    await session.settle();
    first.systemRelease();
    document.dispatchVisibility('hidden');
    document.dispatchVisibility('visible');
    await session.settle();
    expect(request).toHaveBeenCalledTimes(2);
    first.systemRelease();
    session.setPlaying(false);
    await session.settle();
    expect(second.releaseCalls).toBe(1);
  });

  it('synchronizes metadata, playback state, valid position and action handlers independently', () => {
    const mediaSession = fakeMediaSession();
    const onPlay = vi.fn();
    const onPause = vi.fn();
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    const original = mediaSession.setActionHandler.bind(mediaSession);
    mediaSession.setActionHandler = (action, handler) => {
      if (action === 'previoustrack') throw new Error('unsupported action');
      original(action, handler);
    };
    const session = createPlaybackSession({
      mediaSession,
      createMediaMetadata: (init) => ({ marker: true, ...init }) as unknown as MediaMetadata,
      onPlay,
      onPause,
      onPrevious,
      onNext,
    });

    session.setMetadata({ title: 'Song', artist: 'Artist', artwork: '' });
    expect(mediaSession.metadata).toEqual({ marker: true, title: 'Song', artist: 'Artist' });
    session.setPlaying(true);
    expect(mediaSession.playbackState).toBe('playing');
    mediaSession.handlers.get('play')?.({ action: 'play' } as MediaSessionActionDetails);
    mediaSession.handlers.get('pause')?.({ action: 'pause' } as MediaSessionActionDetails);
    mediaSession.handlers.get('nexttrack')?.({ action: 'nexttrack' } as MediaSessionActionDetails);
    expect(onPlay).toHaveBeenCalledOnce();
    expect(onPause).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
    expect(onPrevious).not.toHaveBeenCalled();

    session.setPosition({ duration: 120, position: 30, playbackRate: 1 });
    expect(mediaSession.positionCalls).toEqual([{ duration: 120, position: 30, playbackRate: 1 }]);
    session.setPosition({ duration: 0, position: 0, playbackRate: 1 });
    session.setPosition({ duration: 120, position: 121, playbackRate: 1 });
    session.setPosition({ duration: 120, position: 1, playbackRate: Number.NaN });
    expect(mediaSession.positionCalls).toHaveLength(1);
  });

  it('fully disposes listeners, handlers and wake lock and becomes inert', async () => {
    const document = new FakeDocument();
    const sentinel = new FakeSentinel();
    const request = vi.fn(async () => sentinel);
    const mediaSession = fakeMediaSession();
    const session = createPlaybackSession({ document, wakeLock: { request }, mediaSession });
    session.setPlaying(true);
    await session.settle();

    session.dispose();
    await session.settle();
    expect(document.listenerCount).toBe(0);
    expect(sentinel.releaseCalls).toBe(1);
    expect([...mediaSession.handlers.values()].every((handler) => handler === null)).toBe(true);

    session.setPlaying(true);
    session.setMetadata({ title: 'ignored', artist: 'ignored' });
    document.dispatchVisibility('visible');
    await session.settle();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
