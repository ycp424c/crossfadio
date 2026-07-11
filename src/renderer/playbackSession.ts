export type WakeLockStatus = 'inactive' | 'active' | 'unsupported' | 'unavailable';

export interface PlaybackMetadata {
  title: string;
  artist: string;
  artwork?: string;
}

export interface PlaybackPosition {
  duration: number;
  position: number;
  playbackRate: number;
}

export interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface PlaybackDocument {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface MediaSessionLike {
  metadata: MediaMetadata | null;
  playbackState: MediaSessionPlaybackState;
  setActionHandler?(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void;
  setPositionState?(state?: MediaPositionState): void;
}

export interface PlaybackSession {
  setPlaying(playing: boolean): void;
  setMetadata(metadata: PlaybackMetadata): void;
  setPosition(position: PlaybackPosition): void;
  settle(): Promise<void>;
  dispose(): Promise<void>;
}

export interface CreatePlaybackSessionOptions {
  document?: PlaybackDocument;
  wakeLock?: WakeLockLike;
  mediaSession?: MediaSessionLike;
  createMediaMetadata?: (init: MediaMetadataInit) => MediaMetadata;
  onPlay?: () => void;
  onPause?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onWakeLockStatusChange?: (status: WakeLockStatus) => void;
}

const actions: Array<[MediaSessionAction, keyof CreatePlaybackSessionOptions]> = [
  ['play', 'onPlay'],
  ['pause', 'onPause'],
  ['previoustrack', 'onPrevious'],
  ['nexttrack', 'onNext'],
];

export function createPlaybackSession(options: CreatePlaybackSessionOptions): PlaybackSession {
  let playing = false;
  let disposed = false;
  let sentinel: WakeLockSentinelLike | undefined;
  let pending: Promise<void> = Promise.resolve();
  let requestGeneration = 0;
  let metadataAvailable = true;
  let playbackStateAvailable = true;
  let positionStateAvailable = true;
  const installedActions = new Set<MediaSessionAction>();

  const report = (status: WakeLockStatus): void => {
    if (!disposed) options.onWakeLockStatusChange?.(status);
  };

  const detachSentinel = (value: WakeLockSentinelLike): void => {
    value.removeEventListener('release', onSentinelRelease);
  };

  const onSentinelRelease = (): void => {
    if (sentinel?.released) {
      detachSentinel(sentinel);
      sentinel = undefined;
      report('inactive');
    }
  };

  const enqueue = (operation: () => Promise<void>): void => {
    pending = pending.then(operation, operation);
  };

  const releaseWakeLock = (): void => {
    const current = sentinel;
    sentinel = undefined;
    requestGeneration += 1;
    if (!current) {
      report('inactive');
      return;
    }
    detachSentinel(current);
    enqueue(async () => {
      try {
        if (!current.released) await current.release();
      } finally {
        report('inactive');
      }
    });
  };

  const requestWakeLock = (): void => {
    if (disposed || !playing || sentinel) return;
    if (!options.wakeLock) {
      report('unsupported');
      return;
    }
    const generation = ++requestGeneration;
    enqueue(async () => {
      try {
        const acquired = await options.wakeLock!.request('screen');
        if (disposed || !playing || generation !== requestGeneration) {
          await acquired.release();
          return;
        }
        sentinel = acquired;
        acquired.addEventListener('release', onSentinelRelease);
        report('active');
      } catch {
        if (!disposed && generation === requestGeneration) report('unavailable');
      }
    });
  };

  const onVisibilityChange = (): void => {
    if (!disposed && playing && options.document?.visibilityState === 'visible' && !sentinel) {
      requestWakeLock();
    }
  };

  options.document?.addEventListener('visibilitychange', onVisibilityChange);
  if (options.mediaSession?.setActionHandler) {
    for (const [action, callbackName] of actions) {
      try {
        const callback = options[callbackName] as (() => void) | undefined;
        options.mediaSession.setActionHandler(action, callback ?? null);
        installedActions.add(action);
      } catch {
        // Browsers may support Media Session while rejecting individual actions.
      }
    }
  }

  return {
    setPlaying(nextPlaying) {
      if (disposed || playing === nextPlaying) return;
      const transitionedToPlaying = nextPlaying && !playing;
      playing = nextPlaying;
      if (options.mediaSession && playbackStateAvailable) {
        try {
          options.mediaSession.playbackState = playing ? 'playing' : 'paused';
        } catch {
          playbackStateAvailable = false;
        }
      }
      if (transitionedToPlaying) requestWakeLock();
      else if (!playing) releaseWakeLock();
    },
    setMetadata(metadata) {
      if (disposed || !options.mediaSession || !metadataAvailable) return;
      const base: MediaMetadataInit = { title: metadata.title, artist: metadata.artist };
      const attempts: MediaMetadataInit[] = metadata.artwork
        ? [{ ...base, artwork: [{ src: metadata.artwork }] }, base]
        : [base];
      for (const init of attempts) {
        try {
          const value = options.createMediaMetadata
            ? options.createMediaMetadata(init)
            : (init as MediaMetadata);
          options.mediaSession.metadata = value;
          return;
        } catch {
          // Invalid artwork and partial implementations are retried without artwork.
        }
      }
      metadataAvailable = false;
    },
    setPosition(position) {
      if (disposed || !options.mediaSession || !positionStateAvailable) return;
      const { duration, playbackRate } = position;
      if (
        Number.isFinite(duration) && duration > 0 &&
        Number.isFinite(position.position) && position.position >= 0 && position.position <= duration &&
        Number.isFinite(playbackRate) && playbackRate > 0
      ) {
        if (!options.mediaSession.setPositionState) {
          positionStateAvailable = false;
          return;
        }
        try {
          options.mediaSession.setPositionState(position);
        } catch {
          positionStateAvailable = false;
        }
      }
    },
    settle() {
      return pending;
    },
    async dispose() {
      if (disposed) {
        await pending;
        return;
      }
      options.document?.removeEventListener('visibilitychange', onVisibilityChange);
      if (options.mediaSession?.setActionHandler) {
        for (const action of installedActions) {
          try {
            options.mediaSession.setActionHandler(action, null);
          } catch {
            // Cleanup remains best-effort for partially supported actions.
          }
        }
      }
      playing = false;
      releaseWakeLock();
      disposed = true;
      await pending;
    },
  };
}

export function createBrowserPlaybackSession(
  options: Omit<CreatePlaybackSessionOptions, 'document' | 'wakeLock' | 'mediaSession' | 'createMediaMetadata'>,
): PlaybackSession {
  const browserNavigator = typeof navigator === 'undefined' ? undefined : navigator;
  const wakeLock = browserNavigator && 'wakeLock' in browserNavigator
    ? (browserNavigator.wakeLock as unknown as WakeLockLike)
    : undefined;
  const mediaSession = browserNavigator && 'mediaSession' in browserNavigator
    ? (browserNavigator.mediaSession as MediaSessionLike)
    : undefined;
  const createMediaMetadata = typeof MediaMetadata === 'undefined'
    ? undefined
    : (init: MediaMetadataInit) => new MediaMetadata(init);
  return createPlaybackSession({
    ...options,
    document: typeof document === 'undefined' ? undefined : document,
    wakeLock,
    mediaSession,
    createMediaMetadata,
  });
}
