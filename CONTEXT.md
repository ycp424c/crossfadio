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

**DJ Session Log**:
A per-user record of DJ-relevant continuity across conversation, selection, playback, and segue moments. It explains the DJ's recent context and decisions without replacing the current playback or storage model.
_Avoid_: event-sourcing source of truth, debug log, raw transcript

**DJ Event**:
A single DJ-relevant decision or context-changing action in the DJ Session Log, such as receiving a listener request, updating a directive, receiving personal DJ context, selecting a track, changing the queue, or generating a segue.
_Avoid_: chat turn, technical event, SSE event, log line

**Selection Rationale**:
The DJ-facing reason an individual playable candidate was chosen for the current moment, including how it fits the listener, queue, context, or transition. A batch-level explanation may accompany a DJ Pick-next Run, but it does not replace the per-track rationale.
_Avoid_: batch summary, debug reason, ranking score, prompt trace

**Personal DJ Context**:
A personal-state summary provided to the DJ for music selection and segue tone. The latest record represents current state, while recent prior records may indicate short-term change; it is derived from an external personal context system and should not be treated as a raw personal data archive or durable Crossfadio memory.
_Avoid_: LifeMesh dump, user profile, raw personal notes

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

**Listening Constraint**:
A non-entity listening preference that describes fit for the current moment, such as energy, scene, vocal presence, or novelty. It should guide discovery and ranking without being treated as a literal platform search phrase.
_Avoid_: search keyword, query modifier

**Music Entity**:
A verifiable music object that can lead to playable candidates, such as a track, artist, album, playlist, or chart item.
_Avoid_: search term, vibe, style word

**Semantic Discovery**:
The step that turns listening constraints and style hints into concrete music entities before platform recall.
_Avoid_: NCM search, style search, query expansion

**Web Music Discovery**:
The step that uses public web information to discover music entity hints for exploration. It expands what Crossfadio may investigate; it does not by itself create playable candidates.
_Avoid_: web search, online recall, internet candidate source

**Music Entity Hint**:
A sourced but not-yet-verified lead that may refer to a music entity or a relationship between music entities. It must be confirmed before it can become a music entity used for selection.
_Avoid_: candidate, search result, recommendation

**Entity Verification**:
The act of confirming that a music entity hint refers to a recognizable music entity or relationship that Crossfadio can safely use for discovery.
_Avoid_: LLM validation, search parsing, candidate filtering

**Playable Candidate**:
A recalled song candidate that has a verified platform track identity and can be considered for playback selection.
_Avoid_: music entity hint, search result, recommendation

**Durable Music Knowledge**:
Music knowledge that is expected to remain useful over time, such as stable artist style associations, similar-artist relationships, or representative works.
_Avoid_: cached search result, fresh trend, user preference

**Fresh Music Signal**:
A time-sensitive music lead whose usefulness depends on recency, such as new releases, current charts, or recent scene activity.
_Avoid_: permanent knowledge, stable preference

**Shared Music Knowledge**:
Music knowledge that is not tied to one user's taste and can be reused across users or sessions.
_Avoid_: user preference, personal taste profile

**Preference Evidence**:
Behavioral evidence about how one user responds to music entities, relationships, or fresh music signals.
_Avoid_: global music knowledge, objective quality

**Exploration Gap**:
Evidence that the current discovery path is not producing enough useful novelty for an exploratory selection, even if the candidate pool is not empty. It is a reason to look for new music entity hints rather than a fallback state.
_Avoid_: empty pool, low score, fallback trigger

**Exact Recall**:
Platform retrieval using a concrete music entity or identifier rather than a mood, scene, or style phrase.
_Avoid_: semantic search, fuzzy search

**Seed Catalog**:
A curated set of high-confidence music entities used as cold-start entry points for discovery. It is an entry map, not a fixed recommendation library.
_Avoid_: recommendation list, fallback playlist

**Semantic Index**:
A searchable collection of known music entities and their listening-fit descriptions, used to find entities similar to the current intent.
_Avoid_: vector database, recommendation model
