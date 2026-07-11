# Mobile Background Playback Design

**Date:** 2026-07-11  
**Status:** Approved for implementation planning  
**Scope:** Web renderer only, with no server API or native-app changes

## Goal

Improve Crossfadio on iPhone Safari and Android Chrome so the mobile player puts
essential playback controls first, automatically keeps the screen awake while music
is playing, exposes complete lock-screen controls, and keeps advancing and refilling
the queue after the screen is locked whenever the browser and operating system allow
it.

## Success Criteria

- The mobile player is usable at 360 CSS pixels without horizontal scrolling, and
  the current track, timeline, and primary transport controls are available in the
  first screenful.
- Starting playback automatically requests a screen wake lock. Pausing, exhausting
  the queue, or unmounting the player releases it.
- The system media UI shows the current title, artist, artwork, and playback state.
  Play, pause, previous, and next actions reuse the player's existing handlers.
- Locking the screen does not intentionally pause playback. An ended track advances
  through the prepared queue, and the DJ refill path remains active in the
  background where the browser permits it.
- Unsupported browser capabilities and rejected requests degrade independently and
  never prevent normal audio playback.

## Platform Boundary

This is a best-effort Web implementation, not an absolute background-execution
guarantee. iOS and Android may freeze a browser page because of battery, memory,
network, or vendor policy. A PWA does not remove that restriction. Guaranteed
long-running background work would require a native audio service, such as a future
Capacitor or dedicated mobile-app implementation.

The implementation must make the likely path reliable by relying on the native
`HTMLAudioElement`, preparing multiple upcoming tracks before suspension, avoiding
timer-dependent track advancement, and recovering cleanly when the page becomes
active again.

## Architecture

### Playback Session Module

Add a small renderer-side playback-session module outside `PlayerView.tsx`. It
coordinates browser media capabilities but does not own the queue or duplicate
player state. Its public inputs are the active audio element, current metadata,
playing state, and callbacks for play, pause, previous, and next.

The module owns three isolated concerns:

1. **Wake lock:** acquire and release `WakeLockSentinel`, handle sentinel release,
   and reacquire after the document becomes visible while playback is active.
2. **Media Session:** publish metadata and playback state, register supported action
   handlers, and clear handlers during disposal.
3. **Page lifecycle:** listen for visibility and page restoration events, reconcile
   auxiliary browser state, and ask the player to recover only when recovery is
   actually required.

`PlayerView` remains authoritative for queue order, current track, stream URL,
play/pause state, retry state, DJ refill, and all user-facing status.

### Data Flow

1. A user gesture starts the existing `HTMLAudioElement`.
2. The successful native `play` event updates React state and the playback session.
3. The playback session requests Wake Lock and updates Media Session.
4. Track metadata changes refresh the lock-screen title, artist, artwork, and
   position state when supported.
5. Lock-screen actions invoke the same handlers as the visible transport controls.
6. Native `ended` advances the existing queue without depending on a background
   interval.
7. The existing DJ refill flow prepares the queue before it approaches exhaustion.

## Mobile Layout

Desktop layout and behavior remain unchanged. Below the existing mobile breakpoint,
the page uses a playback-first order:

1. Compact app/session header, including a low-priority wake-lock status while
   playback is active.
2. Current artwork, title, artist, lyric context, and like action.
3. Timeline and primary transport controls.
4. A compact next-track/queue-readiness summary.
5. Discovery mode, taste, queue details, theme, and diagnostic/status panels.

Previous, play/pause, and next controls use icon-first labels with at least 44 by 44
CSS pixel targets on phones. Secondary shuffle and repeat controls must not crowd the
primary controls; controls without implemented behavior must not become more visually
prominent as part of this work.

The app shell should use dynamic viewport units with a safe fallback and preserve
the existing bottom safe-area padding so mobile browser chrome and the home indicator
do not cover the tab bar.

## Wake Lock Behavior

- Request `navigator.wakeLock.request('screen')` only after audio has started.
- Do not block or delay playback while awaiting the request.
- Release the sentinel after pause, terminal queue exhaustion, or module disposal.
- Treat a system-triggered sentinel release as normal. If the document later becomes
  visible and audio is still playing, request a new sentinel.
- Avoid repeated request loops after rejection. A later user play action or
  visibility restoration may retry once through the normal state transition.
- Expose `active`, `unsupported`, and transient `unavailable` status to the player.
  Show active status quietly; show unsupported/unavailable information once without
  persistent error noise.

## Media Session Behavior

- Update `MediaMetadata` whenever the current track changes. Use available title,
  artist, and cover artwork; omit missing fields rather than inventing values.
- Keep `navigator.mediaSession.playbackState` aligned with real audio `play` and
  `pause` events, not optimistic button clicks.
- Register `play`, `pause`, `previoustrack`, and `nexttrack` when the browser accepts
  them. An unsupported individual action is ignored without disabling the rest.
- Map play, pause, previous, and next to existing player callbacks so queue state has
  one authority.
- Update position state from native media timing at a throttled, browser-safe rate
  when `setPositionState` is supported and duration is valid.
- Clear all installed action handlers when the module is disposed.

## Background Queue Continuity

The player should target at least five prepared tracks after the current track while
actively playing. Refill starts before the page is likely to be suspended. This is a
readiness target, not a second queue, and it must reuse existing refill deduplication
and in-flight guards.

Track advancement continues to use the native `ended` event and the same persistent
audio element. The implementation must not introduce a polling timer as the primary
background transition mechanism.

DJ refill remains allowed after the page is hidden, but the next several transitions
must not require a successful background request. If a stream URL expires or the
browser rejects automatic continuation, enter the existing recoverable playback
state. On foreground restoration, reconcile the audio element and show a clear manual
resume action rather than retrying indefinitely or reporting a false playing state.

`stalled` and `suspend` events are diagnostic signals and do not immediately replace
the stream. A real media `error` continues through the existing bounded retry and
fresh-stream recovery path.

## Error Handling and Observability

Auxiliary capability failures are isolated:

- Wake Lock failure changes only wake-lock status.
- Media Session metadata or one action-handler failure disables only that operation.
- Invalid artwork is omitted from later metadata updates.
- Browser lifecycle recovery must not reset the queue or create a second audio
  element.

Development logging should distinguish unsupported capability, rejected request,
system-released wake lock, automatic reacquisition, background track transition, and
manual-resume-required states. User-facing text stays concise and actionable.

## Testing

### Unit Tests

Tests for the playback-session module must cover:

- acquire after confirmed play and release after pause;
- system release followed by visible-page reacquisition;
- unsupported and rejected Wake Lock degradation;
- Media Session metadata and playback-state synchronization;
- lock-screen action mapping to existing callbacks;
- tolerance of unsupported individual action handlers;
- cleanup of action handlers, listeners, and wake lock on disposal.

### Player Integration Tests

Tests around the extracted player behavior must cover:

- metadata refresh after a track transition;
- native ended advancement while the document is hidden;
- early DJ refill at the background-readiness threshold;
- autoplay rejection producing a truthful recoverable state;
- foreground reconciliation without duplicate advancement or duplicate refill.

Implementation follows red-green-refactor: each production behavior begins with a
focused failing test.

### Automated Verification

Run:

```bash
pnpm check
pnpm vitest <targeted playback-session and player tests>
pnpm test
pnpm build:web
```

### Device Verification

Verify on at least one current iPhone Safari device and one current Android Chrome
device:

1. Confirm playback prevents automatic screen sleep while the page is foregrounded.
2. Manually lock the device for ten minutes and cross at least two track boundaries.
3. Validate title, artist, artwork, play, pause, previous, and next on the lock screen.
4. Start with a short queue and confirm the DJ prepares additional tracks.
5. Test interruption and recovery after an incoming call or equivalent audio focus
   loss, headphone removal, and returning to the foreground.
6. Record the device model, OS version, browser version, and any platform limitation
   in the verification report.

## Non-Goals

- Native iOS or Android projects, app-store delivery, or native background services.
- PWA installation or offline playback.
- Server API, database, queue protocol, or DJ selection-policy changes.
- Guaranteed background networking under operating-system process suspension.
- Redesigning the desktop player or unrelated settings/chat screens.
