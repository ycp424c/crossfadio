# Mobile Background Playback Verification

## Goal and scope

This runbook verifies the automated contracts and records the manual evidence needed for mobile background playback: foreground playback, screen-lock continuity, track-boundary progression, lock-screen media controls, short-queue refill, and recovery after interruptions or headphone changes.

The Web platform can only provide best-effort background playback. Browser and OS power policies may suspend JavaScript, networking, timers, Wake Lock, or media playback after the page is backgrounded or the device is locked. Automated unit tests and a production build validate application contracts, but they do not prove that a particular browser/device combination will continue playing while locked. Wake Lock is a foreground aid, not a guarantee of background execution. Release confidence therefore requires the real-device matrix below.

## Automated verification

Run date: 2026-07-11 (CST, Asia/Shanghai). Repository baseline for the range check: `60ab90c..HEAD`.

| Command | Started | Finished | Result | Evidence |
| --- | --- | --- | --- | --- |
| `git diff --check 60ab90c..HEAD` | 09:18:38 | 09:18:38 | PASS (exit 0) | No whitespace errors reported. |
| `pnpm check` | 09:18:41 | 09:18:45 | PASS (exit 0) | Node and Web TypeScript projects completed with no errors. |
| `pnpm vitest tests/unit/playback-session.spec.ts tests/unit/player-playback-history.spec.ts tests/unit/player-dj-refill.spec.ts tests/unit/player-media-runtime.spec.ts tests/unit/player-queue-runtime.spec.ts tests/unit/player-layout.spec.ts` | 09:18:51 | 09:18:52 | PASS (exit 0) | 6 test files passed; 80 tests passed. |
| `pnpm test` | 09:18:55 | 09:19:02 | PASS (exit 0) | 109 test files passed, 1 skipped; 920 tests passed, 1 skipped (921 total). The skipped test was `tests/unit/ncm-real-smoke.spec.ts`. |
| `pnpm build:web` | 09:19:07 | 09:19:09 | PASS (exit 0) | Vite 5.4.21 transformed 1,780 modules and completed the production build in 1.44 s. |

The development server was not started. No browser smoke, visual review, or device behavior is inferred from the automated results above.

## Responsive viewport checklist

These checks require an actual browser inspection. An empty or unexecuted result means **not executed**, never passed.

| Viewport | Layout/overflow | Player controls | Queue/history usability | Result | Notes |
| --- | --- | --- | --- | --- | --- |
| 360 × 800 | Not executed | Not executed | Not executed | NOT EXECUTED | Browser inspection was not available for this run. |
| 390 × 844 | Not executed | Not executed | Not executed | NOT EXECUTED | Browser inspection was not available for this run. |
| 768 × 1024 | Not executed | Not executed | Not executed | NOT EXECUTED | Browser inspection was not available for this run. |
| 1280 × 800 | Not executed | Not executed | Not executed | NOT EXECUTED | Browser inspection was not available for this run. |

## Real-device verification matrix

Record one row per device/browser combination. Do not convert blank cells into a pass: blank or `Not executed` means **not executed**.

| Device model | OS | Browser/version | Foreground Wake Lock | 10 min lock | Crossed track boundaries | Lock-screen play/pause/prev/next | Short queue refill | Interruption/headphone recovery | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Not executed | Not executed | Not executed | Not executed | Not executed | Not executed | Not executed | Not executed | Not executed | NOT EXECUTED: no real-device hardware was available for this run. |

For a manual run, start playback from a user gesture, confirm the foreground Wake Lock state where supported, lock the screen for at least 10 minutes, and keep the queue short enough to force a refill. The run is complete only after playback crosses track boundaries and every supported lock-screen control is exercised. Then interrupt playback (for example, with a call/alarm or audio-focus change), disconnect and reconnect headphones, and record recovery behavior plus browser/OS-specific limitations in Notes.
