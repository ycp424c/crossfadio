# Track Stream Consecutive Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow three consecutive automatic stream retries and restore a fresh three-retry window after 10 seconds of stable playback.

**Architecture:** Keep the browser audio lifecycle in `PlayerView.tsx`, but place the stable-playback reset decision in the pure `playerMediaRuntime.ts` module. `PlayerView` records the resume position for a retry window, asks the pure helper whether playback has advanced 10 seconds, and clears the window only when that threshold is reached.

**Tech Stack:** React, TypeScript, native HTMLAudioElement events, Vitest.

---

### Task 1: Define the stable-playback reset decision

**Files:**
- Modify: `src/renderer/playerMediaRuntime.ts`
- Test: `tests/unit/player-media-runtime.spec.ts`

- [x] **Step 1: Write the failing stable-playback decision tests**

Add imports and assertions for a pure `shouldResetTrackMediaRetryWindow` helper:

```ts
expect(shouldResetTrackMediaRetryWindow({
  retryWindowStartedAtSec: 120,
  currentTimeSec: 129.9,
  stablePlaybackSec: 10
})).toBe(false);
expect(shouldResetTrackMediaRetryWindow({
  retryWindowStartedAtSec: 120,
  currentTimeSec: 130,
  stablePlaybackSec: 10
})).toBe(true);
expect(shouldResetTrackMediaRetryWindow({
  retryWindowStartedAtSec: null,
  currentTimeSec: 130,
  stablePlaybackSec: 10
})).toBe(false);
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run tests/unit/player-media-runtime.spec.ts`

Expected: FAIL because `shouldResetTrackMediaRetryWindow` is not exported.

- [x] **Step 3: Implement the minimal pure decision helper**

Add:

```ts
export function shouldResetTrackMediaRetryWindow(input: {
  retryWindowStartedAtSec: number | null;
  currentTimeSec: number;
  stablePlaybackSec: number;
}): boolean {
  return input.retryWindowStartedAtSec !== null &&
    Number.isFinite(input.retryWindowStartedAtSec) &&
    Number.isFinite(input.currentTimeSec) &&
    input.currentTimeSec - input.retryWindowStartedAtSec >= input.stablePlaybackSec;
}
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm exec vitest run tests/unit/player-media-runtime.spec.ts`

Expected: all tests in the file PASS.

### Task 2: Apply a three-retry consecutive failure window in PlayerView

**Files:**
- Modify: `src/renderer/views/Player/PlayerView.tsx`
- Test: `tests/unit/player-layout.spec.ts`
- Test: `tests/unit/player-media-runtime.spec.ts`

- [x] **Step 1: Write failing PlayerView integration constraints**

Update the retry layout test to require:

```ts
expect(source).toContain('const TRACK_MEDIA_ERROR_MAX_RETRIES = 3');
expect(source).toContain('const TRACK_MEDIA_RETRY_STABLE_PLAYBACK_SEC = 10');
expect(source).toContain('const trackMediaRetryWindowStartedAtSecRef = useRef<number | null>(null)');
```

Add a test that slices `onTimeUpdate` and requires it to call `shouldResetTrackMediaRetryWindow`, then clear both `trackMediaRetryAttemptsRef.current` and `trackMediaRetryWindowStartedAtSecRef.current`.

- [x] **Step 2: Run focused tests and verify RED**

Run: `pnpm exec vitest run tests/unit/player-layout.spec.ts tests/unit/player-media-runtime.spec.ts`

Expected: FAIL because PlayerView still limits retries to two and does not reset after stable playback.

- [x] **Step 3: Implement the retry window lifecycle**

In `PlayerView.tsx`, set `TRACK_MEDIA_ERROR_MAX_RETRIES` to `3`, add a 10-second stable-playback constant, import `shouldResetTrackMediaRetryWindow`, and add `trackMediaRetryWindowStartedAtSecRef`.

Set the window start to the latest retry resume position whenever a retry begins, so another interruption restarts the required stable-playback interval. Clear it wherever the existing retry count is intentionally reset. Within `onTimeUpdate`, call the pure helper with `audio.currentTime`; when it returns true, set the retry count to `0` and the window start to `null`.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm exec vitest run tests/unit/player-layout.spec.ts tests/unit/player-media-runtime.spec.ts tests/unit/media-error.spec.ts`

Expected: all focused tests PASS.

- [x] **Step 5: Run project verification**

Run: `git diff --check && pnpm check && pnpm test`

Expected: formatting check, TypeScript/lint checks, and complete test suite PASS.

- [x] **Step 6: Commit the implementation**

```bash
git add src/renderer/playerMediaRuntime.ts src/renderer/views/Player/PlayerView.tsx tests/unit/player-media-runtime.spec.ts tests/unit/player-layout.spec.ts docs/superpowers/plans/2026-07-13-track-stream-consecutive-retry.md
git commit -m "fix(player): reset stream retries after stable playback"
```
