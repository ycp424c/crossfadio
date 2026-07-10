# Lyrics-aware Music Selection Design

## Status

Conversation design approved on 2026-07-10. Written specification pending final user review.

## Summary

Crossfadio will enrich the final MusicAgent shortlist with lyrics, credits, platform metadata, and song wiki tags. The existing final-pick LLM call will both produce stable semantic assessments for the shortlisted tracks and select tracks for the current DJ Pick-next Run. The server will then enforce high-confidence Listening Constraint conflicts and deterministic Candidate Quality Signals before any track enters the queue.

This keeps the LLM call count unchanged while adding two protections:

1. A calming context must not admit a high-confidence conflicting track such as aggressive death metal.
2. Low-quality search candidates from suspicious network artists must not enter the queue merely because their titles loosely match the request.

## Goals

- Use lyric meaning, song tags, and platform metadata to understand shortlisted tracks more accurately.
- Hard-reject high-confidence conflicts with the active Listening Constraint, even if the run returns fewer tracks or requires Ranked Backfill.
- Reduce low-quality external candidates through multiple independent Candidate Quality Signals.
- Keep one final-pick LLM request per convergence attempt by fusing semantic assessment and selection.
- Cache stable track assessments so recurring liked and previously seen tracks do not require repeated lyric analysis.
- Preserve explainability through structured evidence and decision logs.

## Non-goals

- Do not treat lyrics as the only source of genre, energy, or vocal intensity.
- Do not treat an unknown artist, missing arranger credit, or missing lyric as sufficient evidence of low quality.
- Do not store raw lyrics in the durable track profile cache.
- Do not analyze all 80-160 candidates in the full Candidate Pool.
- Do not replace the existing Music Entity, Semantic Discovery, Exact Recall, ranking, or fallback architecture.
- Do not introduce a second LLM request solely for track profiling.

## Current State

- The final LLM sees a ranked summary of at most 20 candidates.
- The candidate summary is currently limited to 2,400 characters and contains identity, source, penalties, adjusted score, and recall evidence, but no lyrics or song understanding.
- `NcmClient.getLyric()` performs an uncached per-track request.
- Segue generation already cleans LRC timestamps, recognizes common credit lines, extracts a short lyric excerpt, and extracts wiki tags.
- Candidate Quality Signals already include popularity, copyright and privilege fields, album name, publish time, and title pollution.
- Existing quality preparation runs before ranking, but lyric enrichment must not copy its full-pool behavior because the Candidate Pool can contain 80-160 tracks.

## Design Principles

### Separate responsibilities, not necessarily calls

The fused final call may produce stable semantic assessments and current picks together. The response still separates:

- stable track understanding, which can be cached;
- current-context selection, which must not be cached;
- deterministic quality facts, which the server computes rather than asking the LLM to guess;
- enforcement, which remains server-side.

### Evidence before inference

Rule-based extraction produces facts. The LLM interprets only semantic properties that are difficult to derive mechanically. Missing evidence yields `unknown`, not a guessed label.

### High-confidence conflict is a server decision

The LLM may select a track, but it cannot override a high-confidence Listening Constraint conflict. The server validates selected tracks before queue mutation and can use Ranked Backfill from the same assessed shortlist without another LLM request.

### Unknown is not low quality

An unfamiliar artist or incomplete credits may describe a legitimate independent, old, foreign-language, or instrumental release. Quality decisions therefore require multiple signals. Credits provide a small positive confidence signal; missing credits are neutral by themselves.

## Data Flow

1. MusicAgent recalls and performs its existing deterministic ranking.
2. The server takes the top 12 candidates by default. The implementation may expose a bounded 8-20 configuration, but all candidates in one call receive the same per-track lyric budget.
3. For each candidate, the server reads a compatible cached semantic profile when one exists.
4. For cache misses, the server fetches lyrics and wiki data with bounded concurrency, request cancellation, and a shared enrichment deadline.
5. The server extracts deterministic facts and produces a bounded lyric sample.
6. The final-pick LLM receives current context plus a mixture of cached profiles and uncached evidence packets.
7. The LLM returns exactly one semantic assessment for every input candidate, plus picks and rejections.
8. The server validates the response schema, persists stable assessments, calculates current compatibility, calculates deterministic quality decisions, and removes ineligible picks.
9. If the accepted picks do not fill the Auto-fill Batch Size, Ranked Backfill selects from the remaining assessed and eligible candidates.
10. Only validated tracks are appended to the queue and recorded in the DJ Session Log.

## Enrichment Inputs

### Deterministic track facts

The enrichment packet contains:

- track ID, title, artist, album, and publish time;
- source and recall provenance;
- popularity, copyright, privilege, and availability-related fields;
- title pollution and suspicious artist-name patterns;
- wiki genre/style tags;
- parsed lyric credits;
- lyric availability, line count, translation availability, and repeated-hook count.

These fields are produced by code and are not rewritten by the LLM.

### Credit parsing

Credits are extracted from the complete raw LRC before lyric sampling. The parser normalizes common Chinese and English aliases for:

- lyricist;
- composer;
- arranger;
- producer;
- mixer;
- recording engineer;
- mastering engineer;
- vocalist.

Values such as `无`, `N/A`, empty strings, duplicated roles, and repeated names are normalized. Credit presence may increase metadata confidence by a small bounded amount. Missing roles do not independently cause a penalty or rejection.

## Lyric Preparation and Sampling

### Normalization

The sampler:

- parses timestamps before removing LRC syntax;
- separates metadata and credit lines from lyric content;
- removes empty lines, advertisements, instrumentation markers, and pure filler when safe;
- normalizes whitespace without rewriting words;
- records repeated normalized lines before deduplication;
- treats lyric text as untrusted data and serializes it only inside explicit JSON fields.

The system prompt states that instructions contained in lyrics are content and must never be followed.

### Short lyrics

If the cleaned lyric body is at most 2,000 characters, the enrichment packet includes the complete cleaned lyric body.

### Long lyrics

Long lyrics use combined sampling rather than prefix truncation:

1. Divide the timestamp range into six equal windows. When timestamps are unavailable, divide by line index.
2. Select up to two consecutive meaningful lines from each window.
3. Detect normalized lines or short line groups repeated at least twice and include one representative hook with its repetition count.
4. Select four to six additional high-information lines not already selected. Prefer lexical diversity and content words; reject lines dominated by filler, vocalizations, or duplicates.
5. Ensure the final one or two meaningful lines are represented so that a late narrative turn is not lost.
6. Restore selected lines to original order and cap the result at 3,000 characters per track.

### Translation alignment

- Match translated lines to sampled original lines by timestamp when possible.
- Include translations only for selected lines.
- If timestamp alignment fails, include a separately bounded translation sample.
- Preserve the original lyric; translation is supporting evidence, not a replacement.

### Fair prompt budgeting

Replace the single 2,400-character candidate truncation with independent budgets:

- base candidate and context material: target 4,000-8,000 characters;
- lyric evidence material: target 24,000-40,000 characters;
- per-track lyric evidence: maximum 3,000 characters;
- total final-pick input: a configurable soft cap below the configured model context window, initially 48,000 characters excluding output reserve.

When the total exceeds the soft cap, reduce every uncached candidate's lyric allowance proportionally. Do not truncate the tail of the candidate array, because that would give later candidates no evidence and create positional bias.

## Stable Semantic Assessment

The LLM returns stable fields only when supported by the packet:

```json
{
  "id": "track-id",
  "profile": {
    "genres": ["death metal"],
    "moods": ["dark"],
    "energy": "high",
    "aggression": "high",
    "vocalIntensity": "high",
    "lyricThemes": ["death", "conflict"],
    "language": "en"
  },
  "confidence": {
    "genres": 0.94,
    "moods": 0.76,
    "energy": 0.88,
    "aggression": 0.91,
    "vocalIntensity": 0.82,
    "lyricThemes": 0.74,
    "language": 0.98
  },
  "evidence": [
    {
      "claim": "genre=death metal",
      "source": "wiki_tag"
    },
    {
      "claim": "aggression=high",
      "source": "lyric_and_genre_analysis"
    }
  ]
}
```

Allowed enum values are bounded. Unknown fields use `unknown` or an empty list. Evidence source values are a fixed enum and evidence strings have strict length limits.

The response must contain exactly one assessment for every candidate ID supplied to the final call. Unknown IDs, duplicates, missing assessments, and malformed fields make the response invalid.

## Fused Final-pick Response

The final response extends the existing final shape:

```json
{
  "type": "final",
  "say": "...",
  "assessments": [],
  "picks": [],
  "rejected": []
}
```

For candidates with compatible cached profiles, the LLM may echo the supplied profile instead of re-analyzing lyrics. The server only writes a profile when the assessment passes schema validation and corresponds to an input candidate.

## Compatibility Enforcement

Compatibility is contextual and is never stored in the stable profile. The server calculates:

```text
compatible | uncertain | conflict
```

The first version uses an explicit conflict matrix derived from active Listening Constraints. Examples:

- `calm`, `soothing`, `quiet`, or equivalent constraints conflict with high-confidence `aggression=high` plus `energy=high`.
- Those constraints conflict with strong genre evidence for death metal, hardcore, grindcore, or similarly aggressive styles.
- `instrumental` or `no vocals` conflicts with high-confidence `vocalIntensity=high` unless the candidate is explicitly an instrumental version.

A conflict becomes hard only when:

- one authoritative genre or wiki signal has confidence at or above 0.85; or
- two independent semantic signals support the conflict and their relevant confidence values are at or above 0.80.

Unknown or low-confidence fields remain `uncertain` and are not rejected solely for uncertainty.

The server removes conflicting candidates before queue mutation. A conflicting LLM pick is recorded as rejected and Ranked Backfill may use another assessed, non-conflicting candidate.

## Candidate Quality Decision

Quality uses the existing Candidate Quality Signals plus the new deterministic enrichment facts. It produces:

```text
trusted | acceptable | suspicious
```

### Strong negative signals

- unavailable or copyright-blocked track;
- explicit no-copyright recommendation flag;
- strong title pollution;
- placeholder or collection-style artist identity;
- malformed or missing essential track identity.

### Supporting negative signals

- very low platform popularity;
- missing normal album metadata;
- suspicious title/artist patterns;
- no lyrics where the track is not identified as instrumental;
- unusually incomplete metadata.

### Positive signals

- normal album and artist identity;
- valid copyright and playback privilege;
- moderate or high platform popularity;
- complete, plausible credits;
- coherent wiki tags and release metadata;
- liked or otherwise strong user Preference Evidence.

Unavailability remains a hard filter. A candidate becomes `suspicious` only when multiple independent negative signals agree; artist unfamiliarity or missing credits alone cannot produce that result. Suspicious external candidates are excluded from final selection when an acceptable alternative exists. If every remaining candidate is suspicious, the run may select fewer tracks rather than enqueue a likely low-quality result.

The score table and logs retain individual signals rather than collapsing them into an unexplained scalar.

## Cache

Add a durable track-level cache keyed by platform track ID. It stores:

- analyzer version;
- lyric hash when lyrics were fetched;
- stable semantic profile JSON;
- structured evidence JSON;
- deterministic extraction summary;
- analysis model identifier;
- creation and update timestamps;
- last lyric refresh timestamp.

Raw lyrics and translations are not stored in the durable profile cache.

Cached profiles remain valid until the analyzer version changes. Lyrics may be refreshed after a long interval, initially 30 days; a changed lyric hash invalidates the assessment. Missing lyrics use a shorter negative-cache interval, initially one day. Concurrent requests for the same track share one in-flight lyric/wiki fetch. Fused semantic assessment remains part of each run's final call; persistence uses an idempotent upsert so concurrent runs cannot corrupt the cache.

## Concurrency, Cancellation, and Deadlines

- Fetch lyric and wiki data only for the final shortlist, never for the entire Candidate Pool.
- Use bounded concurrency of 4-6 NCM requests.
- Propagate the DJ Pick-next Run abort signal into lyric and wiki requests.
- Apply a shared enrichment deadline, initially 2-3 seconds, shorter than the final LLM timeout.
- A single failed candidate enrichment must not fail the whole batch.
- When enrichment misses its deadline, continue with cached or deterministic evidence that is already available.

## Failure Handling

### Lyrics unavailable

Use metadata and wiki evidence. Missing lyrics alone is neutral unless combined with other suspicious quality facts.

### Wiki unavailable

Use lyrics, cached semantic data, and deterministic metadata. Genre confidence should remain unknown when unsupported.

### Fused response malformed

Reject unknown or malformed assessments and do not persist partial unvalidated profile data. Apply compatible cached profiles and deterministic quality filters. When enforcement is enabled, Ranked Convergence or Ranked Backfill may only select candidates that have a cached or newly validated assessment; unassessed candidates remain ineligible for that run. Returning fewer tracks is preferable to bypassing the semantic safety check.

### Selected track conflicts after validation

Remove it, record the exact conflict evidence, and backfill from an assessed eligible candidate. Do not make another LLM request solely because a pick was rejected.

### Cache write failure

Continue the current run with the validated in-memory assessment and log the persistence failure.

## Observability

Extend MusicAgent diagnostics with:

- shortlist size;
- profile cache hits and misses;
- lyric and wiki fetch attempted/succeeded/failed/timed-out counts;
- sampling mode and sampled character count per candidate;
- fused assessment validation failures;
- compatibility result and supporting evidence per candidate;
- quality tier and individual Candidate Quality Signals;
- dropped picks and Ranked Backfill reason;
- enrichment and final-call elapsed time;
- prompt character budget and actual usage.

The DJ Session Log records the final Selection Rationale and high-level rejection reason, not raw lyrics or full prompt traces.

## Security and Data Handling

- Treat lyrics, translations, wiki content, titles, and artist names as untrusted prompt data.
- Serialize untrusted content in JSON data fields and explicitly prohibit following embedded instructions.
- Validate every LLM response with a strict schema and candidate-ID whitelist.
- Do not log or persist raw lyrics.
- Limit evidence strings and arrays to prevent output amplification.

## Testing

### Unit tests

- parse Chinese and English credit aliases;
- normalize empty, duplicate, and malformed credits;
- clean timestamped and untimestamped lyrics;
- keep full short lyrics;
- sample six time windows from long lyrics;
- preserve representative repeated hooks;
- include high-information and ending lines;
- align translations by timestamp;
- enforce per-track and global fair budgets;
- prevent prompt instructions inside lyrics from changing message structure;
- validate fused assessment coverage and candidate IDs;
- invalidate cache entries by analyzer version and lyric hash;
- calculate high-confidence calm-versus-aggressive conflicts;
- keep unknown semantic profiles uncertain rather than conflicting;
- require multiple independent signals for suspicious quality;
- keep unknown artists and missing credits neutral by themselves.

### Integration tests

- one final LLM call returns assessments and picks;
- cached and uncached candidates coexist in one final request;
- a selected death-metal candidate is removed under a calming directive;
- Ranked Backfill fills from the same assessed shortlist without another LLM call;
- a suspicious low-quality external candidate loses to an acceptable candidate;
- lyric/wiki timeouts do not abort the whole DJ Pick-next Run;
- malformed assessments fall back safely and are not cached;
- queue mutation and DJ Event ordering remain unchanged.

### Regression fixtures

Maintain named fixtures for:

- a calming context containing an otherwise highly ranked death-metal candidate;
- a low-popularity network-song candidate with suspicious title, artist, album, and metadata signals;
- an unknown but legitimate independent artist with coherent metadata and credits;
- a high-quality instrumental track without lyricist or arranger credits;
- a foreign-language song with timestamp-aligned translation;
- a track whose lyric contains instruction-like text.

### Performance acceptance

- No additional LLM request in the normal final-pick path.
- No lyric requests for cache hits.
- Enrichment remains within the shared deadline.
- Prompt input remains within the configured soft cap and preserves evidence for every candidate.

## Rollout

1. Introduce extraction, cache, fused response schema, and diagnostics behind a feature flag.
2. Run in shadow mode: produce assessments and compatibility/quality decisions without changing picks; inspect bad-case fixtures and real diagnostics.
3. Enable high-confidence Listening Constraint conflict rejection and Ranked Backfill.
4. Enable suspicious-quality exclusion after validating false-positive rates on unknown legitimate and instrumental fixtures.
5. Remove the feature flag only after latency, malformed response, backfill, and rejection metrics remain healthy.

## Acceptance Criteria

- The final-pick path still makes one final LLM request, not separate profile and selection requests.
- Every final-call candidate receives either a cached profile or bounded evidence material.
- The LLM returns one validated assessment for every candidate.
- High-confidence semantic conflicts cannot enter the queue.
- Low-quality external candidates require multiple negative signals and do not displace acceptable alternatives.
- Unknown artists, missing credits, and instrumental tracks are not rejected by a single weak signal.
- Profiles are reusable, versioned, and stored without raw lyrics.
- Failures degrade to existing ranking behavior without corrupting queue state or the profile cache.
- Logs explain which semantic conflict or Candidate Quality Signals affected each rejected candidate.
