# Final Selection Rationale Design

## Problem

MusicAgent currently returns an LLM-authored batch rationale together with proposed picks. The picks then pass through eligibility filtering, title-motif diversification, ranked backfill, queue exclusion, and deduplication. The UI and DJ event log still expose the original batch rationale even when the final appended tracks differ from the proposal.

This allows a rationale to name an artist or track that was never appended. It also leaves insufficient durable evidence to explain whether a proposed pick was removed by MusicAgent post-processing or by the queue boundary.

## Goals

- Make the displayed batch rationale describe only tracks that were actually appended.
- Give UI debug payloads, per-track DJ events, and queue events one shared final-selection truth source.
- Preserve the original LLM rationale for diagnostics without presenting it as the final result.
- Persist enough batch-level diagnostics to explain future proposal-to-queue differences.
- Add no extra LLM call and no new latency-sensitive dependency.

## Non-goals

- Change candidate recall, ranking, lyrics-aware eligibility, or queue deduplication behavior.
- Rewrite per-track selection reasons.
- Make legacy and random fallback paths use MusicAgent diagnostics they do not have.
- Generate a second natural-language summary with an LLM.

## Architecture

### Final selection result

Introduce a focused helper that builds a final batch result after all queue-level filtering has completed. Its required input is the actual appended picks; optional diagnostic input contains the original LLM rationale and MusicAgent/queue diagnostics.

The result contains:

- `tracks`: the actual appended picks in queue order;
- `rationale`: a deterministic Chinese summary listing only those tracks;
- `proposedRationale`: the original LLM-authored rationale, for diagnostics only;
- `diagnostics`: target/requested/appended counts, `finalPickDiagnostics`, and queue-level `skippedPicks` when available.

The deterministic rationale format is:

```text
本次实际补充 N 首：艺人《歌名》、艺人《歌名》。
```

Every `FinalSelectionTrack` field is whitespace-normalized and Unicode-safe truncated in the helper before any consumer sees it. The exact JavaScript string-length limits are `id <= 200`, `name <= 300`, `artist <= 300`, `reason <= 1000`, and `source <= 80`. A blank `name` falls back to the already-truncated `id`; required blank `id`, `reason`, and `source` values remain invalid. `rationale` is built from those same truncated tracks, so `dj.debug` and persisted events consume identical bounded values without independently normalizing or truncating them. Missing artist metadata renders the track title without inventing an artist.

### Single truth source

`handleMusicAgentPickNextOutput` creates the final selection result exactly once from `appendedPicks`. The same object supplies:

- `dj.debug.selectedTracks`;
- `dj.debug.selectedSay`;
- each `track_selected.batchRationale`;
- the new batch-level completion event;
- each track's own `reason`, cached by track ID for downstream segue generation.

The original `output.say` must not be used in any of those user-facing or final-selection fields. Batch `rationale` is used only for the UI batch summary, `track_selected.batchRationale`, and `selection_completed`; it is never written into the per-track reason cache.

MusicAgent success, legacy LLM success, and random fallback success each pass an explicit path-owned receipt to broadcast/telemetry. Its `appendedTracks` contains only tracks appended by that path, never a slice inferred from the shared queue after asynchronous work.

Random fallback has an additional UI ordering rule: after a successful append it always emits a final `dj.debug` built from its `FinalSelectionResult`, even if an upstream generic debug was already emitted. The final payload is deliberately later so it replaces the generic proposal in the UI with the actual selected tracks and final batch rationale.

### Durable completion event

Add a `selection_completed` DJ event with a strict payload:

```ts
{
  finalTrackIds: string[];
  finalRationale: string;
  proposedRationale?: string;
  targetCount?: number;
  requestedPickCount?: number;
  appendedCount: number;
  finalPickDiagnostics?: FinalPickDiagnostics;
  skippedPicks: Array<{
    id?: string;
    name?: string;
    artist?: string;
    reason: 'id_excluded' | 'dedupe_excluded' | 'no_remaining_slots';
    dedupeKey?: string;
  }>;
}
```

The event shares the selection correlation/run identifiers and is written after `track_selected` events and before `queue_changed`. `track_selected.selectionRationale` remains the per-track reason, while `track_selected.batchRationale` becomes the final deterministic rationale.

Legacy LLM and random fallback paths also emit `selection_completed`, but may omit MusicAgent-only diagnostics. Their final rationale is still derived from the tracks they actually append.

## Data flow

1. Selection begins and writes `selection_started`.
2. MusicAgent produces proposed picks, per-track reasons, an original rationale, and post-processing diagnostics.
3. Eligibility/diversification produces final MusicAgent picks.
4. Queue exclusion/deduplication produces `appendedPicks` and `skippedPicks`.
5. The final-selection helper builds the deterministic rationale from `appendedPicks`.
6. The server caches each final track's `track.reason` by track ID from that same result.
7. The server emits the debug payload from the final result.
8. The DJ event layer writes `track_selected`, `selection_completed`, then `queue_changed` from the same result.
9. The renderer displays `selectedSay` and `selectedTracks` without independently rebuilding either value.

## Error and compatibility behavior

- Empty appended results do not emit a successful `selection_completed` event.
- Partial batches emit `selection_completed` with their actual appended count and skipped-pick diagnostics.
- Every random fallback early or zero-own-append branch, including no eligible fallback IDs and empty fetched details, broadcasts an explicit receipt with `appendedTracks: []` and `path: undefined`. Telemetry therefore emits `dj.pick-next.done` with `added: false`, `addedCount: 0`, and empty track IDs, and never emits `queue-appended` or attributes concurrently queued tracks to random fallback.
- Each such random fallback branch records its corresponding fallback stats exactly once before broadcasting: `no_candidates` for no eligible IDs and `legacy_random_fallback` for empty details.
- Older databases require no table migration because DJ event payloads are stored as JSON and event types are application-validated strings.
- Older renderer clients continue to consume `dj.debug`; only the correctness of `selectedSay` changes.
- Diagnostic payloads are bounded by existing event size/count limits and do not include lyrics or other raw model context.

## Testing

- Unit-test the final rationale formatter with multiple tracks, whitespace, missing artists, and truncation boundaries.
- Assert the exact 200/300/300/1000/80 field limits with emoji inputs, no lone surrogate, blank-name fallback to the truncated ID, and rationale reuse of the same normalized track values.
- Add a regression test where the proposed rationale names a fifth artist but only four picks survive; assert that `selectedSay`, each `batchRationale`, and `selection_completed.finalRationale` contain only the four appended tracks.
- Assert random success emits its final debug after an upstream generic debug and that the final payload contains no generic proposal track or rationale.
- Assert random early branches report an empty path receipt, a false/zero done payload, no concurrent queue IDs, no `queue-appended`, and exactly one fallback-stats record.
- Assert MusicAgent, legacy LLM, and random success telemetry receives only each path's explicit appended-track receipt.
- Assert that `selection_completed.proposedRationale` retains the original text for diagnosis.
- Assert that partial queue append persists `finalPickDiagnostics` and `skippedPicks`.
- Extend DJ event store schema tests for `selection_completed` validation and round-trip reads.
- Run focused DJ/MusicAgent tests, type checking, and the repository test wrapper before completion.

## Success criteria

- No user-facing batch rationale can mention a track or artist absent from the corresponding final appended track list.
- The exact final rationale can be reconstructed from persisted DJ events.
- A future shortfall can be classified from durable `finalPickDiagnostics` and `skippedPicks` without relying on transient server logs.
- Existing candidate selection and queue behavior remain unchanged.
