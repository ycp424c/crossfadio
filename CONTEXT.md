# Crossfadio Music Selection

This context names the domain concepts used when Crossfadio recalls, ranks, and selects music candidates for playback.

## Language

**Auto-fill Batch Size**:
The maximum number of songs one automatic fill run may add to the playback queue. It is a per-run selection scope, not the steady-state number of songs kept queued.
_Avoid_: queue target, refill threshold, backup queue size

**Auto-fill Low Water Mark**:
The minimum backup depth that should remain after the currently playing song before an automatic fill run is allowed to start.
_Avoid_: batch size, queue target

**Batch Diversity**:
The expectation that songs chosen in the same DJ pick-next run should avoid clustering around the same primary artist or source when enough viable candidates exist.
_Avoid_: random variety, shuffle

**DJ Pick-next Run**:
A DJ selection run that continues the playback queue by choosing what should play after the current queue, whether invoked by automatic refill or a DJ pick-next endpoint.
_Avoid_: chat recommendation, explicit add-song request

**Pick Order**:
The order in which songs selected by a DJ pick-next run should be appended to the playback queue.
_Avoid_: shuffle order, display order

**Ranked Backfill**:
Additional selections drawn from already recalled and ranked candidates when the primary selection returns fewer songs than the auto-fill batch size.
_Avoid_: random fallback, legacy fallback

**Candidate Quality Signal**:
Evidence about whether a recalled song candidate is likely to be usable and worth selecting, based on platform metadata such as popularity, availability, and metadata completeness.
_Avoid_: quality score, low quality song

**Quality Signals**:
The collection of candidate quality signals attached to a recalled song candidate.
_Avoid_: scores, ranking score

**Title Pollution Signal**:
Evidence that a recalled song candidate's title appears to be assembled from search terms, scene words, or collection-style descriptors rather than naming a specific song.
_Avoid_: title duplicate penalty, same-song dedupe
