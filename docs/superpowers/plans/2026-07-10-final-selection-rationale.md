# Final Selection Rationale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every displayed and persisted DJ batch rationale derive from the tracks actually appended, while durably recording proposal-to-final diagnostics.

**Architecture:** Add a small final-selection result module that deterministically formats actual appended tracks. MusicAgent and fallback paths construct this result after their final queue filtering, then reuse it for SSE debug output, per-track `track.reason` caching, `track_selected` events, and a new batch-level `selection_completed` event.

**Tech Stack:** TypeScript, Zod, better-sqlite3 JSON event payloads, Vitest.

---

### Task 1: Final-selection result formatter

**Files:**

- Create: `src/server/dj/finalSelectionResult.ts`
- Create: `tests/unit/dj-final-selection-result.spec.ts`

- [ ] **Step 1: Write the failing formatter tests**

Cover an exact four-track batch, whitespace normalization, missing artist metadata, and the 1000-character event limit:

```ts
import { describe, expect, it } from "vitest";
import { buildFinalSelectionResult } from "../../src/server/dj/finalSelectionResult";

describe("final selection result", () => {
  it("builds the batch rationale only from appended tracks", () => {
    const result = buildFinalSelectionResult({
      tracks: [
        {
          id: "1",
          name: "有酒今朝醉",
          artist: "许冠杰",
          reason: "fit",
          source: "search"
        },
        {
          id: "2",
          name: "钟无艳",
          artist: "谢安琪",
          reason: "fit",
          source: "search"
        }
      ],
      proposedRationale: "为你选了卫兰的夏日浪漫。"
    });

    expect(result.rationale).toBe(
      "本次实际补充 2 首：许冠杰《有酒今朝醉》、谢安琪《钟无艳》。"
    );
    expect(result.rationale).not.toContain("卫兰");
    expect(result.proposedRationale).toBe("为你选了卫兰的夏日浪漫。");
  });
});
```

- [ ] **Step 2: Run the formatter test and verify RED**

Run: `pnpm vitest run tests/unit/dj-final-selection-result.spec.ts`

Expected: FAIL because `finalSelectionResult.ts` does not exist.

- [ ] **Step 3: Implement the formatter and result types**

Define `FinalSelectionTrack`, `FinalSelectionDiagnostics`, and `FinalSelectionResult`. Implement `buildFinalSelectionResult()` so `rationale` is derived exclusively from normalized `tracks`, while `proposedRationale` and diagnostics remain separate:

```ts
export function buildFinalSelectionResult(
  input: BuildFinalSelectionResultInput
): FinalSelectionResult {
  const tracks = input.tracks.map(normalizeFinalSelectionTrack);
  const descriptions = tracks.map(track =>
    track.artist
      ? `${track.artist}《${track.name || track.id}》`
      : `《${track.name || track.id}》`
  );
  return {
    tracks,
    rationale: truncate(
      `本次实际补充 ${tracks.length} 首：${descriptions.join("、")}。`,
      1000
    ),
    ...(normalizeText(input.proposedRationale)
      ? { proposedRationale: truncate(input.proposedRationale!, 1000) }
      : {}),
    diagnostics: input.diagnostics ?? {
      appendedCount: tracks.length,
      skippedPicks: []
    }
  };
}
```

- [ ] **Step 4: Run the formatter tests and verify GREEN**

Run: `pnpm vitest run tests/unit/dj-final-selection-result.spec.ts`

Expected: all formatter tests PASS.

### Task 2: MusicAgent final truth source

**Files:**

- Modify: `src/server/dj/musicAgentPickNextResult.ts`
- Modify: `src/server/dj-agent/index.ts`
- Test: `tests/unit/dj-music-agent-pick-next-result.spec.ts`

- [ ] **Step 1: Add a failing proposal/final mismatch regression test**

Create output whose `say` names a skipped fifth artist, exclude that pick at the queue boundary, and capture a new optional `onFinalSelection` callback:

```ts
expect(debugEvent).toMatchObject({
  selectedSay: "本次实际补充 1 首：Fresh Artist《Fresh Song》。",
  selectedTracks: [expect.objectContaining({ id: "301" })],
  skippedPicks: [expect.objectContaining({ id: "302", reason: "id_excluded" })]
});
expect(debugEvent.selectedSay).not.toContain("卫兰");
expect(finalSelection.diagnostics).toMatchObject({
  targetCount: 2,
  requestedPickCount: 2,
  appendedCount: 1
});
```

Also change the existing assertions that previously expected the original batch proposal in the pick-reason cache to expect each corresponding `finalSelection.track.reason`.

- [ ] **Step 2: Run the focused handler test and verify RED**

Run: `pnpm vitest run tests/unit/dj-music-agent-pick-next-result.spec.ts`

Expected: FAIL because debug `selectedSay` still uses `output.say`, cached pick reasons do not yet come from the corresponding final track, and `onFinalSelection` is not supported.

- [ ] **Step 3: Build the result once after queue filtering**

Add `onFinalSelection?(result: FinalSelectionResult): void` to the handler input. After `appendedPicks` and `musicAgentSkippedPicks` are final, call `buildFinalSelectionResult()` with:

```ts
{
  tracks: appendedPicks,
  proposedRationale: output.say,
  diagnostics: {
    targetCount: targetPickCount,
    requestedPickCount: output.picks.length,
    appendedCount: appendedPicks.length,
    finalPickDiagnostics: output.finalPickDiagnostics,
    skippedPicks: musicAgentSkippedPicks
  }
}
```

Use `finalSelection.rationale` for `dj.debug.selectedSay` and all successful/partial batch callback paths. Cache each final track with `setPickReason(track.id, track.reason)` from the same `FinalSelectionResult`; do not cache the batch rationale. Keep the zero-append legacy fallback behavior unchanged.

- [ ] **Step 4: Capture the result in DJAgent**

In `DJAgent.pickNext`, capture the callback result in a local variable and pass it into `appendMusicAgentSelectionEvents`. Do not recompute the final track set from `output.picks`.

- [ ] **Step 5: Run the handler tests and verify GREEN**

Run: `pnpm vitest run tests/unit/dj-music-agent-pick-next-result.spec.ts`

Expected: all tests PASS and the mismatch test proves the original rationale is not user-facing.

### Task 3: Persist `selection_completed`

**Files:**

- Modify: `src/server/store/dj-events.ts`
- Modify: `src/server/dj-agent/events.ts`
- Test: `tests/unit/dj-events-store.spec.ts`
- Test: `tests/unit/dj-agent-pick-next.spec.ts`

- [ ] **Step 1: Add failing schema and orchestration tests**

Add a store round-trip test for:

```ts
appendDjEvent({
  userId: "user-1",
  type: "selection_completed",
  payload: {
    finalTrackIds: ["301"],
    finalRationale: "本次实际补充 1 首：Fresh Artist《Fresh Song》。",
    proposedRationale: "为你选了卫兰和 Fresh Artist。",
    targetCount: 2,
    requestedPickCount: 2,
    appendedCount: 1,
    finalPickDiagnostics: {
      targetPickCount: 2,
      rawPickCount: 2,
      eligiblePickCount: 2,
      acceptedPickCount: 2,
      droppedPickCount: 0,
      titleMotifDroppedCount: 0,
      rankedBackfillCount: 0,
      rejectedPickCount: 0,
      semanticConflictDroppedCount: 0,
      qualityDroppedCount: 0,
      unassessedDroppedCount: 0,
      assessmentValidationFailureCount: 0
    },
    skippedPicks: [{ id: "302", reason: "id_excluded" }]
  }
});
```

Update the DJAgent integration test to require event order `track_selected` -> `selection_completed` -> `queue_changed`, assert every `batchRationale` equals `finalRationale`, and assert `proposedRationale` retains the LLM text.

- [ ] **Step 2: Run the event tests and verify RED**

Run: `pnpm vitest run tests/unit/dj-events-store.spec.ts tests/unit/dj-agent-pick-next.spec.ts`

Expected: FAIL because `selection_completed` is not a valid event type and MusicAgent event recording still uses `output.say`.

- [ ] **Step 3: Add strict event validation**

Extend `djEventTypeSchema` and `payloadSchemas` with `selection_completed`. Validate bounded final IDs, rationale strings, optional counts, the complete optional `finalPickDiagnostics` shape, and bounded skipped-pick entries.

- [ ] **Step 4: Record all MusicAgent events from `FinalSelectionResult`**

Change `appendMusicAgentSelectionEvents` to accept `finalSelection`. Use its tracks and rationale for `track_selected`; append `selection_completed`; make `queue_changed.causationEventId` reference the completion event.

- [ ] **Step 5: Run the event tests and verify GREEN**

Run: `pnpm vitest run tests/unit/dj-events-store.spec.ts tests/unit/dj-agent-pick-next.spec.ts`

Expected: both suites PASS with durable proposal/final diagnostics.

### Task 4: Align legacy and random fallback paths

**Files:**

- Modify: `src/server/dj/eventLogging.ts`
- Modify: `src/server/dj/legacyPickNextResult.ts`
- Modify: `src/server/dj/legacyRandomFallback.ts`
- Test: `tests/unit/dj-legacy-pick-next-result.spec.ts`
- Test: `tests/unit/dj-legacy-random-fallback.spec.ts`

- [ ] **Step 1: Add failing fallback consistency assertions**

Update fallback tests so their debug `selectedSay`, per-track `batchRationale`, and `selection_completed.finalRationale` all equal the deterministic summary of actual appended tracks. Preserve the original legacy/fallback rationale only as `proposedRationale`.

- [ ] **Step 2: Run fallback tests and verify RED**

Run: `pnpm vitest run tests/unit/dj-legacy-pick-next-result.spec.ts tests/unit/dj-legacy-random-fallback.spec.ts`

Expected: FAIL because fallback paths still expose their proposed rationale and do not emit `selection_completed`.

- [ ] **Step 3: Reuse the final-selection builder in fallback paths**

Construct `FinalSelectionResult` from actual appended/whitelisted tracks before debug emission and event recording. Extend `appendQueueAppendEvents` to accept that result, emit `track_selected`, `selection_completed`, and `queue_changed` in the same order as MusicAgent.

For MusicAgent, legacy LLM, and random fallback success, cache each final track's `track.reason` by track ID from that same result. Reserve batch `rationale` for the UI batch summary, `track_selected.batchRationale`, and `selection_completed`; do not add a batch-reason cache.

- [ ] **Step 4: Run fallback tests and verify GREEN**

Run: `pnpm vitest run tests/unit/dj-legacy-pick-next-result.spec.ts tests/unit/dj-legacy-random-fallback.spec.ts`

Expected: both suites PASS.

### Task 5: Integration and repository verification

**Files:**

- Modify only if required by verified type/test failures: `tests/unit/dj-next.spec.ts`

- [ ] **Step 1: Run all DJ-focused suites**

Run:

```bash
pnpm vitest run \
  tests/unit/dj-final-selection-result.spec.ts \
  tests/unit/dj-music-agent-pick-next-result.spec.ts \
  tests/unit/dj-events-store.spec.ts \
  tests/unit/dj-agent-pick-next.spec.ts \
  tests/unit/dj-legacy-pick-next-result.spec.ts \
  tests/unit/dj-legacy-random-fallback.spec.ts \
  tests/unit/dj-next.spec.ts
```

Expected: all listed suites PASS.

- [ ] **Step 2: Run static validation**

Run: `pnpm check`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 3: Run the repository test wrapper**

Run: `./scripts/run-tests.sh`

Expected: exit 0; the wrapper selects the repository-compatible Node runtime and all tests pass.

- [ ] **Step 4: Check the final diff**

Run:

```bash
git diff --check
git status --short --untracked-files=all
git diff -- src/server/dj src/server/dj-agent src/server/store tests/unit docs/superpowers
```

Expected: no whitespace errors; only the approved design, plan, implementation, and regression tests are changed. Do not commit or push until the user issues `CP`, `CPM`, or `CPD`.

### Task 6: Final hardening (completed in the current implementation)

**Files:**

- Modify: `src/server/dj/finalSelectionResult.ts`
- Modify: `src/server/dj/legacyRandomFallback.ts`
- Modify: `src/server/dj/legacyPickNextResult.ts`
- Modify: `src/server/dj/musicAgentPickNextResult.ts`
- Modify: `src/server/dj/pickNextRun.ts`
- Test: `tests/unit/dj-final-selection-result.spec.ts`
- Test: `tests/unit/dj-legacy-random-fallback.spec.ts`
- Test: `tests/unit/dj-legacy-pick-next-result.spec.ts`
- Test: `tests/unit/dj-music-agent-pick-next-result.spec.ts`
- Test: `tests/unit/dj-pick-next-telemetry.spec.ts`
- Test: `tests/unit/dj-next.spec.ts`

- [x] **Step 1: RED — specify Unicode-safe `FinalSelectionTrack` field boundaries**

Add emoji-heavy inputs and assert the exact JavaScript string-length limits, absence of lone surrogates, blank-name fallback to the already-truncated ID, and use of the same truncated track values in `rationale`:

```ts
expect(track.id.length).toBeLessThanOrEqual(200);
expect(track.name!.length).toBeLessThanOrEqual(300);
expect(track.artist!.length).toBeLessThanOrEqual(300);
expect(track.reason.length).toBeLessThanOrEqual(1000);
expect(track.source.length).toBeLessThanOrEqual(80);
expect(hasLoneSurrogate(Object.values(track).join(""))).toBe(false);
expect(result.rationale).toContain(track.name!);
expect(result.rationale).toContain(track.artist!);
```

Run: `pnpm vitest run tests/unit/dj-final-selection-result.spec.ts`

RED signal: overlong fields exceed their limits and blank `name` uses the unbounded ID. GREEN implementation: normalize and Unicode-safe truncate all five fields in `buildFinalSelectionResult`, validate required blanks, then build debug/event rationale from the normalized tracks.

- [x] **Step 2: RED — require a final random-success debug after generic upstream debug**

Seed `emit` with a generic proposal, run a successful random fallback with `debugBroadcastSent: true`, then assert the last debug is the final result and contains no generic content:

```ts
const finalDebug = debugPayloads.at(-1);
expect(debugPayloads).toHaveLength(2);
expect(finalDebug).toMatchObject({
  selectedSay: "本次实际补充 1 首：Artist One《Fallback One》。",
  selectedTracks: [
    expect.objectContaining({ id: "201", source: "legacy_random_fallback" })
  ]
});
expect(JSON.stringify(finalDebug)).not.toContain("generic proposal");
```

Run: `pnpm vitest run tests/unit/dj-legacy-random-fallback.spec.ts`

RED signal: only the upstream debug exists. GREEN implementation: emit the `FinalSelectionResult` debug unconditionally after successful random append so the later payload replaces the generic UI state.

- [x] **Step 3: RED — make every random early branch use an empty path receipt**

Cover both `fallbackIds.length === 0` and `pickedDetails.length === 0` while another path mutates the shared queue. Assert no concurrent ID is attributed, stats are recorded once, and broadcast receives an explicit empty receipt with no success path:

```ts
expect(recordFallbackStats).toHaveBeenCalledTimes(1);
expect(broadcastAppended).toHaveBeenCalledWith(
  userId,
  initialQueueLength,
  targetPickCount,
  emit,
  undefined,
  expect.objectContaining({
    appendedTracks: [],
    fallbackPath: expectedFallbackPath
  })
);
expect(emit).toHaveBeenCalledWith(
  expect.objectContaining({
    type: "dj.pick-next.done",
    added: false,
    addedCount: 0,
    trackIds: []
  })
);
expect(emit).not.toHaveBeenCalledWith(
  expect.objectContaining({ type: "queue-appended" })
);
expect(JSON.stringify(emit.mock.calls)).not.toContain(concurrentTrackId);
```

RED signal: metrics omit `appendedTracks` and queue-length inference reports another path's append. GREEN implementation: record the branch fallback stats exactly once, then call `broadcastAppended` with `path: undefined` and `appendedTracks: []`; never derive a receipt from total queue length.

- [x] **Step 4: RED — require explicit per-path receipts and per-track reason caching**

For MusicAgent, legacy LLM, and random success, assert broadcast/telemetry receives only that path's actual appended tracks. Also use distinct reasons for multiple tracks and assert each cache entry preserves its own reason:

```ts
expect(broadcastAppended).toHaveBeenCalledWith(
  userId,
  initialQueueLength,
  targetPickCount,
  emit,
  expectedBroadcastPath, // undefined for random; metrics still carries fallbackPath
  expect.objectContaining({ appendedTracks: expectedPathTracks })
);
expect(setPickReason).toHaveBeenCalledWith("201", "第一首理由");
expect(setPickReason).toHaveBeenCalledWith("203", "第三首理由");
```

RED signal: success metrics infer shared-queue tracks or cache `finalSelection.rationale` for every track. GREEN implementation: collect path-owned appended tracks, pass them explicitly in `DjPickNextRunMetrics`, and call `setPickReason(track.id, track.reason)` for every successful `FinalSelectionResult` track. `pickNextRun` supplies the random handler with `setPickReason: (trackId, reason) => djPickReasonCache.set(trackId, reason)`.

- [x] **Step 5: GREEN — run focused and full verification**

Run the focused final-hardening matrix:

```bash
pnpm vitest run \
  tests/unit/dj-final-selection-result.spec.ts \
  tests/unit/dj-music-agent-pick-next-result.spec.ts \
  tests/unit/dj-legacy-pick-next-result.spec.ts \
  tests/unit/dj-legacy-random-fallback.spec.ts \
  tests/unit/dj-pick-next-telemetry.spec.ts \
  tests/unit/dj-events-store.spec.ts \
  tests/unit/dj-agent-pick-next.spec.ts \
  tests/unit/dj-next.spec.ts
```

Then run repository-wide validation:

```bash
pnpm check
./scripts/run-tests.sh
git diff --check
git status --short --untracked-files=all
```

Expected GREEN: all focused suites pass, both TypeScript projects pass, the repository wrapper exits zero apart from intentionally skipped real-service smoke tests, and the diff has no whitespace errors.
