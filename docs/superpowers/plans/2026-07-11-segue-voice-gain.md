# Segue Voice Gain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise DJ segue speech by approximately 6 dB with dynamic peak compression while preserving 20 percent song ducking and safe native fallback.

**Architecture:** Add a dependency-injected renderer audio controller that lazily owns one AudioContext and one node chain per TTS element. PlayerView prepares each segue element before playback and releases it on every cleanup path, while all enhancement failures remain isolated from native TTS playback.

**Tech Stack:** TypeScript 5.8, Web Audio API, native `HTMLAudioElement`, React 18, Vitest 3.

---

## File Structure

- Create `src/renderer/audio/segueVoiceGain.ts`: Web Audio context, gain/compressor routing, emergency unity route, release, and disposal.
- Create `tests/unit/segue-voice-gain.spec.ts`: dependency-injected node/context tests in the Node Vitest environment.
- Modify `src/renderer/views/Player/PlayerView.tsx`: controller lifetime, prepare-before-play, and cleanup integration.
- Modify `tests/unit/player-layout.spec.ts`: source-contract assertions for all integration paths and unchanged ducking values.

### Task 1: Segue Voice Gain Controller

**Files:**
- Create: `src/renderer/audio/segueVoiceGain.ts`
- Create: `tests/unit/segue-voice-gain.spec.ts`

- [ ] **Step 1: Write failing routing and parameter tests**

Use minimal fakes rather than jsdom:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  SEGUE_COMPRESSOR_SETTINGS,
  SEGUE_VOICE_GAIN,
  createSegueVoiceGainController
} from '../../src/renderer/audio/segueVoiceGain';

it('routes source through gain and compressor with the configured values', async () => {
  const fake = createAudioContextFake();
  const controller = createSegueVoiceGainController({ createContext: () => fake.context });
  const audio = {} as HTMLAudioElement;

  await expect(controller.prepare(audio)).resolves.toBe('enhanced');
  expect(SEGUE_VOICE_GAIN).toBe(2);
  expect(fake.gain.gain.value).toBe(2);
  expect(fake.compressor.threshold.value).toBe(-12);
  expect(fake.compressor.knee.value).toBe(12);
  expect(fake.compressor.ratio.value).toBe(4);
  expect(fake.compressor.attack.value).toBe(0.003);
  expect(fake.compressor.release.value).toBe(0.25);
  expect(fake.connections()).toEqual(['source->gain', 'gain->compressor', 'compressor->destination']);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest tests/unit/segue-voice-gain.spec.ts`

Expected: FAIL because `segueVoiceGain.ts` does not exist.

- [ ] **Step 3: Implement the controller contract and enhanced route**

Export:

```ts
export const SEGUE_VOICE_GAIN = 2;
export const SEGUE_COMPRESSOR_SETTINGS = {
  threshold: -12,
  knee: 12,
  ratio: 4,
  attack: 0.003,
  release: 0.25
} as const;

export type SegueVoiceGainController = {
  prepare(audio: HTMLAudioElement): Promise<'enhanced' | 'native'>;
  release(audio: HTMLAudioElement): void;
  dispose(): Promise<void>;
};

export function createBrowserSegueVoiceGainController(): SegueVoiceGainController {
  return createSegueVoiceGainController({
    createContext: () => {
      const BrowserAudioContext = window.AudioContext ??
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!BrowserAudioContext) throw new Error('Web Audio unavailable');
      return new BrowserAudioContext();
    }
  });
}
```

Inject a small `AudioContextLike` interface. Lazily create one context, resume it
before binding an element, create/configure gain and compressor before source
creation, then connect `source -> gain -> compressor -> destination`. The browser
factory must feature-detect both standard and prefixed constructors without throwing
when neither exists.

- [ ] **Step 4: Run and verify GREEN**

Run: `pnpm vitest tests/unit/segue-voice-gain.spec.ts`

Expected: routing test PASS.

- [ ] **Step 5: Add failing reuse, cleanup, and fallback tests**

Add focused tests for:

```ts
it('reuses one context and does not create a second source for the same element', async () => {
  await controller.prepare(audio);
  await controller.prepare(audio);
  expect(createContext).toHaveBeenCalledOnce();
  expect(context.createMediaElementSource).toHaveBeenCalledOnce();
});

it('uses a unity route when enhanced connection fails after source creation', async () => {
  gain.connect.mockImplementationOnce(() => { throw new Error('connect failed'); });
  await expect(controller.prepare(audio)).resolves.toBe('native');
  expect(source.connect).toHaveBeenLastCalledWith(context.destination);
});

it('releases chains independently and disposes every chain and context', async () => {
  await controller.prepare(first);
  await controller.prepare(second);
  controller.release(first);
  expect(firstNodes.disconnect).toHaveBeenCalled();
  expect(secondNodes.disconnect).not.toHaveBeenCalled();
  await controller.dispose();
  expect(secondNodes.disconnect).toHaveBeenCalled();
  expect(context.close).toHaveBeenCalledOnce();
});
```

Also cover missing/throwing context construction, rejected resume, node creation and
parameter assignment failures, connection failure before source creation, unknown or
repeated release, disconnect rejection, close rejection, multiple audio elements,
and prepare after disposal returning `native`.

- [ ] **Step 6: Run and verify RED**

Run: `pnpm vitest tests/unit/segue-voice-gain.spec.ts`

Expected: new fallback and lifecycle tests FAIL.

- [ ] **Step 7: Implement idempotence, emergency routing, and cleanup**

Keep a `WeakMap<HTMLAudioElement, VoiceNodeChain>` plus an iterable `Set` of active
chains. If failure occurs before source creation, disconnect partial gain/compressor
nodes and return `native`. If it occurs after source creation, disconnect the partial
enhanced route and connect the existing source directly to destination exactly once.
Keep the source in the WeakMap so a released element is reconnected rather than
passed to `createMediaElementSource` again. Add a test that prepares, releases, and
prepares the same element again while asserting the source factory is still called
once.

Catch capability, disconnect, and close failures inside the controller. `dispose`
marks the controller inert before awaiting close.

- [ ] **Step 8: Verify and commit Task 1**

```bash
pnpm vitest tests/unit/segue-voice-gain.spec.ts
pnpm check
git diff --check
git add src/renderer/audio/segueVoiceGain.ts tests/unit/segue-voice-gain.spec.ts
git commit -m "feat(player): amplify segue voice safely"
```

Expected: tests and type-check PASS.

### Task 2: PlayerView Integration

**Files:**
- Modify: `src/renderer/views/Player/PlayerView.tsx`
- Modify: `tests/unit/player-layout.spec.ts`

- [ ] **Step 1: Add failing integration contract tests**

Following the repository's established source-contract style, assert:

```ts
expect(source).toContain("@renderer/audio/segueVoiceGain");
expect(source).toContain('createBrowserSegueVoiceGainController()');
expect(ttsReadyBlock.indexOf('prepare(audio)')).toBeLessThan(ttsReadyBlock.indexOf('.play()'));
expect(finishBlock).toContain('release(audio)');
expect(forceDisposeBlock).toContain('release(');
expect(unmountBlock).toContain('void segueVoiceGainController.dispose()');
expect(source).toContain('const TRACK_DUCKING_VOLUME = 0.2');
expect(source).toContain('const TRACK_DEFAULT_VOLUME = 1');
```

Locate blocks with stable function/event markers, not unrestricted whole-file
contains, so each assertion proves the relevant cleanup path.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest tests/unit/player-layout.spec.ts`

Expected: FAIL because PlayerView has no gain controller.

- [ ] **Step 3: Create one controller for PlayerView lifetime**

Import the browser factory and initialize one controller in a ref or memoized state:

```ts
const segueVoiceGainRef = useRef<SegueVoiceGainController | null>(null);
if (!segueVoiceGainRef.current) {
  segueVoiceGainRef.current = createBrowserSegueVoiceGainController();
}
```

Use a stable local alias for callbacks and call `void controller.dispose()` in the
existing unmount cleanup. Do not recreate the controller on render.

- [ ] **Step 4: Prepare before TTS playback without blocking fallback**

When TTS becomes ready, keep `audio.volume = 1`, register the element, and have the
playback path await `controller.prepare(audio)` before `audio.play()`. Preparation
returns a status and does not throw, so both `enhanced` and `native` continue to
playback. Preserve the existing pending/started race guards after the await.

- [ ] **Step 5: Release on every unload path**

Call `release(audio)` before native unload/disconnect in normal finish, playback
rejection, pending replacement, forced disposal, track change, and unmount. Do not
release a segue merely because another pending clip is staged. Preserve the active
set rule that restores track volume only after the final active voice finishes.

- [ ] **Step 6: Run targeted tests and type-check**

```bash
pnpm vitest tests/unit/segue-voice-gain.spec.ts tests/unit/player-layout.spec.ts tests/unit/player-segue-runtime.spec.ts
pnpm check
```

Expected: PASS with no change to existing segue timing or ducking tests.

- [ ] **Step 7: Commit Task 2**

```bash
git diff --check
git add src/renderer/views/Player/PlayerView.tsx tests/unit/player-layout.spec.ts
git commit -m "feat(player): boost segue playback loudness"
```

### Task 3: Full Verification and Listening Boundary

**Files:**
- Modify: `docs/verification/mobile-background-playback.md`

- [ ] **Step 1: Add a segue loudness listening row without claiming automation proves perception**

Add a manual check for iPhone Safari and Android Chrome that records the song, TTS
voice, device output, whether speech is clearly audible at the original song level,
whether pumping/clipping is heard, and PASS/FAIL notes. Leave it `NOT EXECUTED` unless
real listening evidence is available.

- [ ] **Step 2: Run fresh automated verification**

```bash
pnpm check
pnpm vitest tests/unit/segue-voice-gain.spec.ts tests/unit/player-layout.spec.ts tests/unit/player-segue-runtime.spec.ts
pnpm test
pnpm build:web
git diff --check
```

Expected: all commands exit 0. Record exact file/test counts in the handoff, not as a
claim of perceptual loudness.

- [ ] **Step 3: Inspect the production CSS/JS build boundary**

Confirm the build contains the Web Audio module without adding a server dependency,
and confirm `package.json` / `pnpm-lock.yaml` are unchanged. Verify `git status` has
only the intended documentation change before committing.

- [ ] **Step 4: Commit verification documentation**

```bash
git add docs/verification/mobile-background-playback.md
git commit -m "docs: add segue loudness listening check"
git status --short --branch
```

Expected: clean working tree; real-device listening remains explicitly unexecuted if
no device evidence was collected.
