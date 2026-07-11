# Segue Voice Gain Design

**Date:** 2026-07-11  
**Status:** Implemented (2026-07-11, feature completion at `e9030eb`)
**Scope:** Renderer-side segue voice playback only

## Goal

Make each DJ segue voice sound approximately as loud as the song at its original
playback level while the song continues to duck to 20 percent during speech. Apply a
fixed voice gain with dynamic compression so quiet TTS becomes clearly audible
without allowing sudden peaks to clip aggressively.

## Current Behavior

`PlayerView` creates a native `HTMLAudioElement` for each TTS clip and already sets
`audio.volume = 1`. During speech, the track element is reduced from volume `1` to
`0.2`. Because the TTS element is already at the native volume ceiling, increasing
the existing property cannot make a quiet source louder.

## Chosen Approach

Route segue voice elements through Web Audio:

```text
HTMLAudioElement
  -> MediaElementAudioSourceNode
  -> GainNode (+6 dB / gain 2.0)
  -> DynamicsCompressorNode
  -> AudioContext.destination
```

The song remains on the existing native playback path and continues to use volume
`0.2` while a segue is speaking. This change affects only the TTS voice signal.

Server-side file processing and per-clip loudness measurement are out of scope. They
remain possible future options if fixed gain does not produce consistent enough
results across TTS voices.

## Architecture

### Segue Voice Gain Module

Add a focused renderer module, `src/renderer/audio/segueVoiceGain.ts`, which owns Web
Audio setup and cleanup. `PlayerView` supplies TTS audio elements but does not create
or connect audio nodes itself.

The module exposes a small controller:

```ts
type SegueVoiceGainController = {
  prepare(audio: HTMLAudioElement): Promise<'enhanced' | 'native' | 'unavailable'>;
  release(audio: HTMLAudioElement): void;
  dispose(): Promise<void>;
};
```

`prepare` ensures an audio context exists, attempts to resume it, and connects the
given element exactly once. It returns `enhanced` only when the complete Web Audio
route is ready. Unsupported or rejected operations before source binding return
`native` without throwing into the player. A post-source failure returns
`unavailable` only when neither the enhanced route nor an emergency unity route can
safely carry audio.

`release` disconnects the nodes associated with one voice element. `dispose`
disconnects every registered voice and closes the shared context.

### Context and Node Ownership

- One `AudioContext` is lazily created per controller and reused across segue clips.
- Each TTS element receives its own media source, gain, and compressor nodes.
- A `WeakMap<HTMLAudioElement, VoiceNodeChain>` prevents duplicate
  `createMediaElementSource` calls for the same element.
- A separate iterable set tracks active chains so the controller can dispose all of
  them; the `WeakMap` alone is not iterable.
- Releasing one voice never closes the shared context or disconnects another voice.

## Audio Parameters

Use centralized constants rather than inline values:

| Parameter | Value |
|---|---:|
| Voice gain | `2.0` (approximately `+6 dB`) |
| Compressor threshold | `-12 dB` |
| Compressor knee | `12 dB` |
| Compressor ratio | `4:1` |
| Compressor attack | `0.003 s` |
| Compressor release | `0.25 s` |

These are initial listening values, not an assertion of broadcast-standard loudness.
They raise quiet speech while limiting peaks. Future tuning should change constants
or configuration, not player control flow.

## Player Integration

`PlayerView` creates one gain controller for its lifetime.

When a `segue.tts-ready` event supplies a new TTS audio element:

1. Set the element's native volume to `1`.
2. Call `controller.prepare(audio)` before attempting playback.
3. Continue with that element when preparation returns `enhanced` or `native`.
4. If preparation returns `unavailable`, release and unload that element, create a
   fresh native `Audio` replacement for the same URL, and play the replacement
   without preparing it through Web Audio.

The existing segue timing, overlapping-voice handling, and song ducking remain
authoritative. When speech begins, track volume remains `0.2`. When the final active
segue voice finishes, fails, or is removed, track volume returns to `1`.

Every path that unloads a TTS audio element must first call `controller.release`:

- normal `ended` cleanup;
- playback rejection cleanup;
- pending-voice replacement;
- force disposal during track/session changes;
- PlayerView unmount.

PlayerView unmount additionally calls `controller.dispose()` without returning its
promise from the React effect cleanup.

## Native Fallback and Browser Compatibility

Web Audio is an enhancement, not a playback dependency.

Return `native` and continue with the existing `<audio>` output if failure happens
before `createMediaElementSource`. Setup order must therefore resume the context and
create/configure the gain and compressor before binding the media element.

Use fallback for:

- `AudioContext` is unavailable;
- context construction fails;
- a suspended context rejects `resume()`;
- source, gain, or compressor creation fails;
- parameter assignment or node connection fails.

Fallback must avoid partial routing. If setup fails after a media source has been
created, the browser no longer permits returning that element to implicit native
output or creating another source. In that case, detach the partial enhanced chain
and connect the existing source directly to `AudioContext.destination` as an
emergency unity-gain route. This route is reported as `native` because it adds no
gain/compression, even though Web Audio carries the signal. The controller must not
leave the track permanently ducked or mark the segue as failed solely because
enhancement failed.

If the partial enhanced route cannot be safely disconnected, or the direct unity
connection also fails, return `unavailable`. `PlayerView` then replaces the bound
element with a fresh native `Audio` element; the original element's media source
identity cannot be rebound or restored to implicit native output.

Once a media element has been successfully connected to a
`MediaElementAudioSourceNode`, its sound is routed through the AudioContext. The
implementation must not create a second source for that same element or connect the
source directly to destination in parallel with the gain/compressor route.

Mobile browsers may still require an active user gesture to resume AudioContext.
Crossfadio's music session begins with a user play action, but a later resume can
still be rejected by the operating system. That case uses native fallback and does
not block the segue.

## Error Handling

- Public controller methods do not throw Web Audio capability failures into
  `PlayerView`.
- Releasing an already released or unknown element is a no-op.
- Release is identity-specific: it removes only the route owned by the supplied
  media element and never closes the shared context.
- Individual `disconnect()` and context `close()` failures are isolated.
- Failure for one TTS element does not disable enhancement for later elements unless
  context creation itself is unavailable.
- A playback failure remains a playback failure and follows the existing status
  behavior; an enhancement failure alone is not shown as a user-facing error.

## Testing

### Unit Tests

Use dependency-injected AudioContext and node fakes in the existing Node Vitest
environment. Do not require a real browser or jsdom.

Cover:

- source -> gain -> compressor -> destination connection order;
- exact gain and compressor parameter values;
- lazy context creation and reuse;
- idempotent prepare for the same audio element;
- independent chains and cleanup for multiple elements;
- unsupported AudioContext fallback;
- construction, resume, node creation, parameter, and connection failures;
- partial-chain cleanup and unity-gain emergency routing after a post-source setup
  failure;
- releasing unknown/already released elements;
- disposal disconnecting all chains and closing the context;
- rejected disconnect/close operations remaining isolated.

### Player Integration Tests

Following the repository's current source-contract testing style, verify that:

- TTS readiness prepares the element before `play()`;
- normal finish and every forced unload path release the element;
- unmount disposes the controller;
- the track still ducks to `0.2` while speech plays and returns to `1` after the last
  active segue finishes;
- enhancement fallback does not skip native TTS playback.
- `unavailable` replaces the routed element with a fresh native element, while
  pending-object and audio-identity checks prevent a late prepare/play result from
  reviving a replaced or disposed segue.

### Verification Commands

```bash
pnpm vitest tests/unit/segue-voice-gain.spec.ts tests/unit/player-layout.spec.ts
pnpm check
pnpm test
pnpm build:web
git diff --check
```

## Non-Goals

- Changing the TTS model, voice, speed, or server API.
- Server-side ffmpeg processing or cache migration.
- Measuring LUFS/RMS and calculating a unique gain for every clip.
- Changing the song ducking level from `0.2`.
- Changing segue timing, scripts, queue behavior, or crossfade logic.
- Claiming exact perceptual equality across all songs, voices, speakers, and devices.
