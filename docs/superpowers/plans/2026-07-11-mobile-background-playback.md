# Mobile Background Playback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mobile Web player playback-first, keep the screen awake while playing, expose complete lock-screen controls, and continue advancing and refilling the queue after the screen locks whenever the platform permits.

**Architecture:** Add a dependency-injected `PlaybackSession` that owns Wake Lock, Media Session, and page-lifecycle integration while `PlayerView` remains authoritative for audio and queue state. Add a small playback-history helper so the newly exposed lock-screen previous action is real, raise the prepared backup target to five tracks, and reorder only the mobile presentation with responsive CSS.

**Tech Stack:** React 18, TypeScript 5.8, native `HTMLAudioElement`, Screen Wake Lock API, Media Session API, Tailwind CSS, Vitest 3.

---

## File Structure

- Create `src/renderer/playbackSession.ts`: browser-capability coordinator with injected document, navigator, metadata constructor, and callbacks.
- Create `tests/unit/playback-session.spec.ts`: deterministic Wake Lock, Media Session, lifecycle, action, position, and cleanup coverage.
- Create `src/renderer/playerPlaybackHistory.ts`: pure bounded history transitions for previous-track support.
- Create `tests/unit/player-playback-history.spec.ts`: history recording and restoration coverage.
- Modify `src/shared/dj.ts`: raise the active-player backup readiness target to five tracks.
- Modify `tests/unit/player-dj-refill.spec.ts`: prove refill remains active until five backups exist.
- Modify `src/renderer/views/Player/PlayerView.tsx`: connect the session, history, queue readiness, real previous action, lifecycle status, and mobile ordering.
- Modify `src/renderer/components/player/TransportControls.tsx`: mobile icon-first 44px controls while retaining desktop labels.
- Modify `src/renderer/components/player/NowPlayingHero.tsx`: compact phone artwork and typography.
- Modify `src/renderer/App.tsx`: use dynamic viewport height without losing the safe-area tab bar.
- Modify `tests/unit/player-layout.spec.ts`: integration and responsive-source assertions.
- Create `docs/verification/mobile-background-playback.md`: repeatable iPhone/Android device checklist and result table.

### Task 1: Playback Session Browser Coordinator

**Files:**
- Create: `src/renderer/playbackSession.ts`
- Create: `tests/unit/playback-session.spec.ts`

- [ ] **Step 1: Write failing Wake Lock lifecycle tests**

Create injected fakes so tests run in the existing Node Vitest environment:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createPlaybackSession } from '../../src/renderer/playbackSession';

describe('playback session', () => {
  it('acquires after confirmed play and releases after pause', async () => {
    const sentinel = { released: false, release: vi.fn(async () => {}), addEventListener: vi.fn() };
    const request = vi.fn(async () => sentinel);
    const session = createPlaybackSession({
      document: fakeDocument('visible'),
      mediaSession: null,
      requestWakeLock: request,
      createMetadata: (value) => value
    });

    session.setPlaying(true);
    await session.settle();
    expect(request).toHaveBeenCalledWith('screen');

    session.setPlaying(false);
    await session.settle();
    expect(sentinel.release).toHaveBeenCalledOnce();
  });

  it('reacquires after system release when the page becomes visible', async () => {
    const doc = fakeDocument('visible');
    const first = fakeSentinel();
    const sentinels = [first, fakeSentinel()];
    const request = vi.fn(async () => sentinels.shift()!);
    const session = createPlaybackSession({ document: doc, mediaSession: null, requestWakeLock: request, createMetadata: (v) => v });
    session.setPlaying(true);
    await session.settle();
    first.emitRelease();
    doc.visibilityState = 'hidden';
    doc.emit('visibilitychange');
    doc.visibilityState = 'visible';
    doc.emit('visibilitychange');
    await session.settle();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
```

The test helper must expose only the event methods used by production code; do not install jsdom.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest tests/unit/playback-session.spec.ts`

Expected: FAIL because `src/renderer/playbackSession.ts` does not exist.

- [ ] **Step 3: Implement the minimal Wake Lock state machine**

Implement a focused public contract:

```ts
export type WakeLockStatus = 'inactive' | 'active' | 'unsupported' | 'unavailable';

export type PlaybackSession = {
  setPlaying(playing: boolean): void;
  setMetadata(metadata: PlaybackMetadata | null): void;
  setPosition(position: PlaybackPosition | null): void;
  settle(): Promise<void>;
  dispose(): Promise<void>;
};

export function createBrowserPlaybackSession(
  options: PlaybackSessionCallbacks & {
    onWakeLockStatusChange: (status: WakeLockStatus) => void;
  }
): PlaybackSession {
  return createPlaybackSession(browserPlaybackSessionOptions(options));
}

export function createPlaybackSession(options: PlaybackSessionOptions): PlaybackSession {
  let playing = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let pending = Promise.resolve();

  function enqueue(operation: () => Promise<void>): void {
    pending = pending.then(operation, operation);
  }

  function setPlaying(next: boolean): void {
    playing = next;
    enqueue(next ? acquireWakeLock : releaseWakeLock);
    syncPlaybackState();
  }

  return { setPlaying, setMetadata, setPosition, settle: () => pending, dispose };
}
```

The injected default adapter reads `navigator.wakeLock?.request`. Rejection reports `unavailable`; absence reports `unsupported`. A sentinel `release` event clears only the matching sentinel. `visibilitychange` reacquires only when visible and still playing.

- [ ] **Step 4: Run the Wake Lock tests and verify GREEN**

Run: `pnpm vitest tests/unit/playback-session.spec.ts`

Expected: PASS with no unhandled rejection.

- [ ] **Step 5: Add failing Media Session and cleanup tests**

Add tests proving metadata, playback state, four action callbacks, supported position state, per-action degradation, and disposal:

```ts
it('publishes metadata and maps system actions to player callbacks', () => {
  const mediaSession = fakeMediaSession();
  const callbacks = { onPlay: vi.fn(), onPause: vi.fn(), onPrevious: vi.fn(), onNext: vi.fn() };
  const session = createPlaybackSession({ ...baseOptions(), mediaSession, callbacks });
  session.setMetadata({ title: 'Plastic Love', artist: '竹内まりや', artworkUrl: 'cover.jpg' });
  session.setPlaying(true);
  mediaSession.run('previoustrack');
  mediaSession.run('nexttrack');
  expect(mediaSession.metadata).toEqual(expect.objectContaining({ title: 'Plastic Love', artist: '竹内まりや' }));
  expect(mediaSession.playbackState).toBe('playing');
  expect(callbacks.onPrevious).toHaveBeenCalledOnce();
  expect(callbacks.onNext).toHaveBeenCalledOnce();
});

it('clears installed actions and releases wake lock on dispose', async () => {
  // arrange an active sentinel and four installed handlers
  await session.dispose();
  expect(mediaSession.handlers()).toEqual({ play: null, pause: null, previoustrack: null, nexttrack: null });
  expect(sentinel.release).toHaveBeenCalledOnce();
});
```

- [ ] **Step 6: Run Media Session tests and verify RED**

Run: `pnpm vitest tests/unit/playback-session.spec.ts`

Expected: FAIL because metadata, actions, position state, and cleanup are not implemented.

- [ ] **Step 7: Implement Media Session and cleanup behavior**

Install each action independently inside `try/catch`, build artwork only when `artworkUrl` is non-empty, update `playbackState` from `setPlaying`, and call `setPositionState` only for finite values satisfying `duration > 0`, `0 <= position <= duration`, and `playbackRate > 0`. Disposal removes listeners, sets installed handlers to `null`, marks the instance disposed, and releases the sentinel.

- [ ] **Step 8: Run tests, type-check, and commit**

Run:

```bash
pnpm vitest tests/unit/playback-session.spec.ts
pnpm check
git add src/renderer/playbackSession.ts tests/unit/playback-session.spec.ts
git commit -m "feat(player): add browser playback session"
```

Expected: tests and type-check PASS; commit succeeds.

### Task 2: Real Previous-Track History

**Files:**
- Create: `src/renderer/playerPlaybackHistory.ts`
- Create: `tests/unit/player-playback-history.spec.ts`
- Modify: `src/renderer/views/Player/PlayerView.tsx`

- [ ] **Step 1: Write failing bounded-history tests**

```ts
import { describe, expect, it } from 'vitest';
import { createPlaybackHistory } from '../../src/renderer/playerPlaybackHistory';

it('restores the latest played track before the current queue', () => {
  const history = createPlaybackHistory(20);
  history.record(track('previous'));
  expect(history.restore([track('current'), track('next')]).map((item) => item.id))
    .toEqual(['previous', 'current', 'next']);
});

it('deduplicates and bounds recorded tracks', () => {
  const history = createPlaybackHistory(2);
  history.record(track('a'));
  history.record(track('b'));
  history.record(track('a'));
  expect(history.snapshot().map((item) => item.id)).toEqual(['b', 'a']);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest tests/unit/player-playback-history.spec.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure history helper**

```ts
export function createPlaybackHistory(limit = 20): PlaybackHistory {
  let tracks: QueueTrackDto[] = [];
  return {
    record(track) {
      tracks = [...tracks.filter((item) => item.id !== track.id), track].slice(-limit);
    },
    restore(queue) {
      const previous = tracks.pop();
      return previous ? [previous, ...queue.filter((item) => item.id !== previous.id)] : queue;
    },
    snapshot: () => [...tracks],
    clear: () => { tracks = []; }
  };
}
```

- [ ] **Step 4: Run and verify GREEN**

Run: `pnpm vitest tests/unit/player-playback-history.spec.ts`

Expected: PASS.

- [ ] **Step 5: Add failing PlayerView source integration assertions**

In `tests/unit/player-layout.spec.ts`, assert that ended, skip, and later-track selection record removed tracks; `handlePrev` restores history and sets autoplay; `canPrev` reflects history availability. This source-level integration style matches the existing file.

- [ ] **Step 6: Run and verify RED**

Run: `pnpm vitest tests/unit/player-layout.spec.ts`

Expected: FAIL because `PlayerView` still has a no-op previous handler.

- [ ] **Step 7: Wire history into PlayerView**

Use `useRef(createPlaybackHistory())`, a small `recordPlaybackHistory(removedTracks)` helper, and a `historyVersion` state updated only when history changes. Do not record queue deletions as played history. `handlePrev` restores one track, sets `shouldAutoplayNextRef.current = isPlaying`, and applies the restored queue. Clear history when starting a new liked-queue session.

- [ ] **Step 8: Run tests and commit**

```bash
pnpm vitest tests/unit/player-playback-history.spec.ts tests/unit/player-layout.spec.ts
pnpm check
git add src/renderer/playerPlaybackHistory.ts src/renderer/views/Player/PlayerView.tsx tests/unit/player-playback-history.spec.ts tests/unit/player-layout.spec.ts
git commit -m "feat(player): support previous track history"
```

Expected: PASS.

### Task 3: Five-Track Background Readiness

**Files:**
- Modify: `src/shared/dj.ts`
- Modify: `tests/unit/player-dj-refill.spec.ts`
- Modify: `src/renderer/views/Player/PlayerView.tsx`

- [ ] **Step 1: Replace the misleading existing refill test with failing boundary tests**

```ts
it('keeps refilling while fewer than five backup tracks are ready', () => {
  expect(shouldTriggerDjRefill({
    isPlaying: true, segueInFlight: false, pickNextInFlight: false,
    now: 10_000, backoffUntil: 0, lastCallAt: 0, cooldownMs: 3_000,
    queueLength: 5, currentIndex: 0, lowWaterMark: 5
  })).toBe(true);
});

it('stops refilling after five backup tracks are ready', () => {
  expect(shouldTriggerDjRefill({
    isPlaying: true, segueInFlight: false, pickNextInFlight: false,
    now: 10_000, backoffUntil: 0, lastCallAt: 0, cooldownMs: 3_000,
    queueLength: 6, currentIndex: 0, lowWaterMark: 5
  })).toBe(false);
});
```

- [ ] **Step 2: Run and verify RED against the exported readiness value**

Also assert `AUTO_FILL_LOW_WATER_MARK` equals `5`, then run:

`pnpm vitest tests/unit/player-dj-refill.spec.ts`

Expected: FAIL because the shared constant is currently `2`.

- [ ] **Step 3: Raise the shared active-player backup target**

Change only:

```ts
export const AUTO_FILL_LOW_WATER_MARK = 5;
```

Keep all existing cooldown, backoff, in-flight, and segue-priority guards.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm vitest tests/unit/player-dj-refill.spec.ts tests/unit/player-layout.spec.ts
pnpm check
git add src/shared/dj.ts tests/unit/player-dj-refill.spec.ts
git commit -m "feat(player): prepare five backup tracks"
```

Expected: PASS.

### Task 4: Connect Playback Session to the Player

**Files:**
- Modify: `src/renderer/views/Player/PlayerView.tsx`
- Modify: `tests/unit/player-layout.spec.ts`

- [ ] **Step 1: Add failing integration assertions**

Assert the source creates one playback session, disposes it, feeds actual `onPlay`/`onPause` state, updates metadata on track change, updates valid position on time updates, and maps all four system callbacks to `handlePlayPause`, `handlePrev`, and `handleSkip`. Assert that native `onEnded` remains the transition trigger and no interval is added.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest tests/unit/player-layout.spec.ts`

Expected: FAIL because `PlayerView` does not import `createBrowserPlaybackSession`.

- [ ] **Step 3: Stabilize handler identities for the session**

Convert transport handlers used by the session to `useCallback` or route them through latest refs. The session itself must be created once after the audio ref is mounted; changing track metadata must call setters rather than recreate browser listeners.

Use this integration shape:

```ts
const playbackSessionRef = useRef<PlaybackSession | null>(null);

useEffect(() => {
  const session = createBrowserPlaybackSession({
    onPlay: () => requestTrackPlayRef.current(),
    onPause: () => audioRef.current?.pause(),
    onPrevious: () => handlePrevRef.current(),
    onNext: () => handleSkipRef.current(),
    onWakeLockStatusChange: setWakeLockStatus
  });
  playbackSessionRef.current = session;
  return () => { playbackSessionRef.current = null; void session.dispose(); };
}, []);
```

The play callback must use the same fresh-stream/manual-resume path as the visible play button, not call `audio.play()` directly.

- [ ] **Step 4: Synchronize real audio state and metadata**

On native `play`, set React playing state then `session.setPlaying(true)`. On native `pause`, set both false. On current track change, call `setMetadata`; on valid time updates call `setPosition`. When the final track ends, set playing false before applying the empty queue.

Expose wake-lock status through an `onWakeLockStatusChange` callback and render a quiet `亮屏保护` indicator only while active; render unsupported/unavailable guidance once per session without replacing playback errors.

- [ ] **Step 5: Preserve truthful autoplay failure state**

Extract the repeated autoplay rejection update to one helper that sets `isPlaying` false, clears the autoplay flag, and sets `下一首已就绪，点击 Play 继续播放`. Use it from next-track loading and refreshed-stream continuation.

- [ ] **Step 6: Run targeted tests and type-check**

```bash
pnpm vitest tests/unit/playback-session.spec.ts tests/unit/player-playback-history.spec.ts tests/unit/player-media-runtime.spec.ts tests/unit/player-layout.spec.ts
pnpm check
```

Expected: PASS with no React hook or TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/views/Player/PlayerView.tsx tests/unit/player-layout.spec.ts
git commit -m "feat(player): connect lock-screen playback session"
```

### Task 5: Playback-First Mobile Layout

**Files:**
- Modify: `src/renderer/views/Player/PlayerView.tsx`
- Modify: `src/renderer/components/player/TransportControls.tsx`
- Modify: `src/renderer/components/player/NowPlayingHero.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `tests/unit/player-layout.spec.ts`

- [ ] **Step 1: Add failing mobile-layout assertions**

Assert that the mobile player section has a lower CSS order than the mode-information section, desktop order is restored at `md`/`xl`, transport buttons use `min-h-11 min-w-11`, Prev/Skip text is hidden on phone and visible at `sm`, hero artwork uses a smaller phone size with the existing desktop size restored, and the app shell includes `h-[100dvh]` plus `h-screen` fallback.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest tests/unit/player-layout.spec.ts`

Expected: FAIL on missing responsive order, touch-target, and dynamic viewport classes.

- [ ] **Step 3: Reorder mobile sections without duplicating them**

Use responsive order classes on the existing sections:

```tsx
<section className="order-2 ... md:order-none">{/* mode and diagnostics */}</section>
<section className="order-1 ... md:order-none">{/* hero, timeline, transport */}</section>
<section className="order-3 ... md:order-none">{/* queue and status */}</section>
```

Do not create a second mobile component tree. Keep desktop column classes unchanged.

- [ ] **Step 4: Make mobile transport and hero compact**

Use 44px minimum targets for previous/play/next, hide the English `Prev`/`Skip` text below `sm`, reduce phone gaps, and preserve existing desktop sizing with responsive classes. Set artwork to a phone-friendly size such as `h-28 w-28 md:h-44 md:w-44`, and scale title typography from `text-2xl` to the existing desktop size at `md`.

- [ ] **Step 5: Use dynamic viewport height safely**

Change the app shell to include both fallback and modern viewport height:

```tsx
<div className="flex h-screen h-[100dvh] flex-col ...">
```

Keep `pb-[env(safe-area-inset-bottom)]` on the bottom navigation.

- [ ] **Step 6: Run tests, build, and commit**

```bash
pnpm vitest tests/unit/player-layout.spec.ts
pnpm check
pnpm build:web
git add src/renderer/views/Player/PlayerView.tsx src/renderer/components/player/TransportControls.tsx src/renderer/components/player/NowPlayingHero.tsx src/renderer/App.tsx tests/unit/player-layout.spec.ts
git commit -m "feat(player): prioritize playback on mobile"
```

Expected: PASS and production Web build succeeds.

### Task 6: Full Verification and Device Runbook

**Files:**
- Create: `docs/verification/mobile-background-playback.md`

- [ ] **Step 1: Write the device verification runbook**

Include a result table with device model, OS, browser/version, foreground Wake Lock,
ten-minute lock duration, number of crossed track boundaries, four system actions,
short-queue refill, interruption recovery, and notes. State explicitly that blank
results mean “not yet run,” not “passed.”

- [ ] **Step 2: Run automated verification**

```bash
git diff --check HEAD~5
pnpm check
pnpm vitest tests/unit/playback-session.spec.ts tests/unit/player-playback-history.spec.ts tests/unit/player-dj-refill.spec.ts tests/unit/player-media-runtime.spec.ts tests/unit/player-queue-runtime.spec.ts tests/unit/player-layout.spec.ts
pnpm test
pnpm build:web
```

Expected: every command exits 0. If `better-sqlite3` reports a Node ABI mismatch,
use the repository wrapper through `pnpm test`; do not bypass it with an arbitrary
Node version.

- [ ] **Step 3: Run responsive browser checks**

Run `pnpm dev:web`, then inspect 360x800, 390x844, 768x1024, and 1280x800. Confirm no
horizontal scroll, player controls appear before mode diagnostics on phones, every
primary target is at least 44px, the queue remains reachable, and desktop ordering is
unchanged.

- [ ] **Step 4: Record real-device results without overstating them**

Run the spec checklist on one current iPhone Safari device and one current Android
Chrome device. Enter the exact observed values. If hardware is unavailable, mark the
rows `未执行（缺少真机）`; do not convert automated browser results into a device pass.

- [ ] **Step 5: Commit verification documentation**

```bash
git add docs/verification/mobile-background-playback.md
git commit -m "docs: add mobile playback verification runbook"
git status --short --branch
```

Expected: working tree is clean and the branch is ahead only by the planned commits.
