# Mobile Background Playback Verification

## Goal and scope

This runbook verifies the automated contracts and records the manual evidence needed for mobile background playback: foreground playback, screen-lock continuity, track-boundary progression, lock-screen media controls, short-queue refill, and recovery after interruptions or headphone changes.

The Web platform can only provide best-effort background playback. Browser and OS power policies may suspend JavaScript, networking, timers, Wake Lock, or media playback after the page is backgrounded or the device is locked. Automated unit tests and a production build validate application contracts, but they do not prove that a particular browser/device combination will continue playing while locked. Wake Lock is a foreground aid, not a guarantee of background execution. Release confidence therefore requires the real-device matrix below.

## Historical automated evidence

Run date: 2026-07-11 (CST, Asia/Shanghai). This evidence is frozen to baseline `60ab90cf9cd50997808e17fbde94059ffa986def` and target `22f00ee8f50f9d65cbc622972f26ca640b193ec4`; it must not be interpreted as evidence for later commits.

| Command | Started | Finished | Result | Evidence |
| --- | --- | --- | --- | --- |
| `git diff --check 60ab90cf9cd50997808e17fbde94059ffa986def..22f00ee8f50f9d65cbc622972f26ca640b193ec4` | 09:18:38 | 09:18:38 | PASS (exit 0) | No whitespace errors reported for the frozen change range. |
| `pnpm check` | 09:18:41 | 09:18:45 | PASS (exit 0) | Node and Web TypeScript projects completed with no errors. |
| `pnpm vitest tests/unit/playback-session.spec.ts tests/unit/player-playback-history.spec.ts tests/unit/player-dj-refill.spec.ts tests/unit/player-media-runtime.spec.ts tests/unit/player-queue-runtime.spec.ts tests/unit/player-layout.spec.ts` | 09:18:51 | 09:18:52 | PASS (exit 0) | 6 test files passed; 80 tests passed. |
| `pnpm test` | 09:18:55 | 09:19:02 | PASS (exit 0) | 109 test files passed, 1 skipped; 920 tests passed, 1 skipped (921 total). The skipped test was `tests/unit/ncm-real-smoke.spec.ts`. |
| `pnpm build:web` | 09:19:07 | 09:19:09 | PASS (exit 0) | Vite 5.4.21 transformed 1,780 modules and completed the production build in 1.44 s. |

The development server was not started. No browser smoke, visual review, or device behavior is inferred from the automated results above.

## Future automated reruns

Choose immutable full commit SHAs and replace both quoted placeholder values before running. Execute the checks from `TARGET` itself, not from a later branch tip. A detached worktree is suitable: create one for the target revision (for example, `git worktree add --detach "<worktree-path>" "<full-target-sha>"`), enter it, and run the template there. The template stops immediately if the worktree contains tracked, staged, or untracked changes, or if `HEAD` is not exactly `TARGET`. Record a new dated result table instead of overwriting the historical evidence above.

```bash
set -e

BASE="<full-baseline-sha>"
TARGET="<full-target-sha>"

test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$TARGET"

git diff --check "$BASE..$TARGET"
pnpm check
pnpm vitest tests/unit/playback-session.spec.ts tests/unit/player-playback-history.spec.ts tests/unit/player-dj-refill.spec.ts tests/unit/player-media-runtime.spec.ts tests/unit/player-queue-runtime.spec.ts tests/unit/player-layout.spec.ts
pnpm test
pnpm build:web
```

## Responsive viewport checklist

These checks require an actual browser inspection. Record each criterion as `PASS`, `FAIL: <observable problem>`, or `NOT EXECUTED: <reason>`. A viewport passes only when every criterion passes. Empty cells and unexecuted results are **not executed**, never passed.

| Viewport | No horizontal scrolling | Controls before diagnostics | Primary targets ≥ 44 px | Queue reachable | Desktop ordering unchanged | Safe-area unobscured | Overall result / notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 360 × 800 | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED: browser inspection was not available. |
| 390 × 844 | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED: browser inspection was not available. |
| 768 × 1024 | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED: browser inspection was not available. |
| 1280 × 800 | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED: browser inspection was not available. |

## Real-device verification matrix

Record one row per device/browser combination. Use `PASS`, `FAIL`, `UNSUPPORTED`, or `NOT EXECUTED` for every behavior. `Crossed track boundaries` must include an observed integer count, for example `PASS (3)` or `FAIL (0)`. Do not convert blank cells into a pass.

| Device model | OS | Browser/version | Foreground Wake Lock | 10 min lock | Crossed track boundaries | Lock-screen play/pause/prev/next | Short queue refill | Interruption/headphone recovery | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| iPhone (model TBD) | iOS (version TBD) | Safari (version TBD) | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED (0 observed) | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | No real-device hardware was available for this run. Replace all TBD values before execution. |
| Android phone (model TBD) | Android (version TBD) | Chrome (version TBD) | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED (0 observed) | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | No real-device hardware was available for this run. Replace all TBD values before execution. |

### Segue loudness listening check

Automated tests can verify routing, gain/compressor parameters, fallback, and player
cleanup contracts. They cannot prove perceived loudness, audibility, pumping, or
clipping on a real device. Record the listening evidence below separately.

| Device/browser | Song | TTS voice | Device output | Clearly audible near original-song level | Pumping/clipping | Result / notes |
| --- | --- | --- | --- | --- | --- | --- |
| iPhone Safari | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED: no iPhone was available for listening. |
| Android Chrome | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED | NOT EXECUTED: no Android device was available for listening. |

#### Repeatable segue loudness procedure

Run the following procedure independently on each device/browser row:

1. Record the actual device model, OS, browser/version, song, TTS voice, and device
   output. Set system media volume to a fixed level (50 percent is recommended) and
   record the actual setting. Disable EQ, sound enhancement, and spatial audio. Use
   the same TTS voice for the complete device run.
2. Confirm the tested build retains track ducking at `0.2` during segue speech.
3. Use the normal DJ queue and wait for a real segue window. For each trial, listen
   to the song at its unducked original level for 10–15 seconds as the baseline,
   then listen to the segue. Do not adjust system or application volume at any point
   during the complete device run.
4. Complete at least three real segue trials and record the actual song for every
   trial. To repeat, restart normal playback or select another track and wait for its
   next segue; do not describe a replay as a newly generated segue or as the same
   generated audio when it is not.
5. For each trial, record whether speech is clearly audible near the original-song
   level. This means no device-volume adjustment is needed, speech is subjectively
   neither noticeably quieter than nor overpowering the unducked baseline, and the
   words remain clear.
6. For every executed trial, the `Pumping/clipping` value must be exactly `NONE HEARD` or
   `HEARD @ <track/time>: <description>`. Record details and evidence in Notes for
   every heard artifact.
7. Mark the device/browser result `PASS` only when all three trials satisfy the
   near-original criterion and all three report `NONE HEARD`. Otherwise mark it
   `FAIL` and explain each failed trial or artifact in Notes. More than three trials
   may be recorded, but do not use extra passes to erase a failure in the required
   three-trial set.

### Repeatable prerequisites

- Enter the tested URL as `<deployment-url>` and record the deployed full commit SHA in Notes. Do not begin until the operator has replaced the URL placeholder.
- Record device model, OS version, and browser version; log in with a test account that can play the selected tracks.
- For the continuity run, prepare the current track plus at least five playable queued tracks.
- For the refill run, separately prepare a short queue with the current track plus one remaining playable track. Keep the queue view or server diagnostics available on a second foreground client so the operator can observe new tracks being appended without unlocking the device under test.
- Connect headphones that can be physically disconnected and reconnected. Ensure the device has enough battery and no deliberate battery-saver mode unless that mode is the subject of the run.

### Repeatable procedure and expectations

1. On an iPhone with a notch or Dynamic Island, inspect the page in portrait and landscape before starting playback. Expected: portrait content is fully below the top sensor area; landscape content clears both left and right rounded/sensor edges; the bottom tab bar and its controls clear the home indicator in both orientations. Record `PASS` or `FAIL` for each edge and orientation, with a screenshot reference on failure.
2. Open `<deployment-url>`, log in, start the current track with a user gesture, and verify audible playback. Expected: playback begins and foreground Wake Lock reports active when supported; otherwise record `UNSUPPORTED` with the browser evidence.
3. With the current track plus at least five queued tracks, lock the screen for 10 uninterrupted minutes. Expected: audio continues without an unexplained stop. Record any stop time to the nearest second in `FAIL` Notes.
4. Keep the device locked long enough to cross at least two track boundaries. Expected: each next track starts automatically. Record the exact observed boundary count in the matrix, including `0` on failure.
5. Exercise lock-screen `play`, `pause`, `previous`, and `next` individually. Expected: each supported action changes playback once and the displayed metadata follows the active track. Record per-action outcomes in Notes; any supported action that does nothing or fires twice is `FAIL`.
6. Repeat from the short-queue prerequisite and observe the second client/server diagnostics when only one queued track remains. Expected: refill is triggered and playable tracks are appended before playback exhausts the queue. Record the pre-refill and post-refill queue counts plus observation source in Notes.
7. While playing, trigger an audio interruption (call, alarm, or another app taking audio focus). Expected: playback follows the OS policy and can resume from the same session afterward without duplicating or skipping queue state. Record the interruption type and whether resume was automatic or manual.
8. Disconnect and reconnect the headphones during playback. Expected: audio does not unexpectedly continue through speakers after disconnect, and playback can resume through the reconnected output without losing the session or queue position.

For every failure, use `FAIL: step <n>; expected=<expected behavior>; actual=<observed behavior>; time=<elapsed or clock time>; evidence=<screenshot/log/reference>; recovery=<automatic/manual/none>` in Notes. For a pass, retain the observed counts and relevant timings rather than writing only `PASS`.
