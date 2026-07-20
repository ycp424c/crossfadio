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
A per-user record of DJ-relevant continuity across conversation, selection, playback, and segue moments. Events are retained for 30 days, while DJ operations consume a bounded projection of at most 20 relevant events from the prior 24 hours; it explains recent context and decisions without replacing the current playback or storage model.
_Avoid_: event-sourcing source of truth, debug log, raw transcript

**DJ Event**:
A single DJ-relevant decision or context-changing action in the DJ Session Log, such as receiving a listener request, updating a directive, receiving personal DJ context, selecting a track, changing the queue, or generating a segue.
_Avoid_: chat turn, technical event, SSE event, log line

**DJ Memory Snapshot**:
A bounded, point-in-time read model assembled from the authoritative queue, listening, preference, directive, exclusion, Personal DJ Context, and DJ Session Log stores for one DJ operation. It carries source and freshness metadata and produces purpose-specific chat, selection, and segue projections without becoming another durable source of truth.
_Avoid_: database, user profile, prompt dump, DJ Session Log

**DJ Configuration**:
Listener- or operator-authored settings that shape DJ behavior, such as persona, configured playlists, routines, or mood rules. System templates are defaults rather than personal facts, and configuration is not Preference Evidence.
_Avoid_: DJ Memory, user profile, inferred preference

**Selection Rationale**:
The DJ-facing reason an individual playable candidate was chosen for the current moment, including how it fits the listener, queue, context, or transition. A batch-level explanation may accompany a DJ Pick-next Run, but it does not replace the per-track rationale.
_Avoid_: batch summary, debug reason, ranking score, prompt trace

**Selection Decision Trace**:
A versioned, structured account of Admission, Recall, Ranking, Batch, and Final decisions, expressed through stable reason codes, actions, provenance, and bounded evidence references. Purpose-specific prompt, log, SSE, and UI projections derive from the same trace without storing raw prompts or private context; the internal diagnostic projection is retained for 7 days.
_Avoid_: Selection Rationale, log line, score table, chain of thought

**Selection Journey**:
A live, user-readable projection of the Selection Decision Trace that explains how the DJ understood the moment, searched, narrowed candidates, balanced the batch, and made the final choice. Stable factual templates provide immediate stages without delaying playback, and a required asynchronous narration step later adds DJ character without changing the underlying facts. Completed journeys are retained for 30 days and the default interface may revisit the prior 24 hours. It never exposes chain of thought, raw private context, or diagnostic scores.
_Avoid_: Debug Trace, loading spinner, Selection Rationale, chain of thought

**Personal DJ Context**:
A fresh but advisory personal-state summary provided to the DJ for soft music-fit guidance and segue tone. It is subordinate to listener-authored requests, exclusions, and directives; it cannot create a hard exclusion or rewrite durable Preference Evidence. It is current for at most 24 hours from its generation time, may declare an earlier expiry, and must not fall back to an older record after expiry. Its payload is deleted after expiry, while the DJ Session Log may retain bounded upload metadata. Recent valid records may indicate short-term change; it is derived from an external personal context system and should not be treated as a raw personal data archive or durable Crossfadio memory.
_Avoid_: LifeMesh dump, user profile, raw personal notes

**Taste Profile**:
A replaceable, versioned summary derived from the listener's liked-music library. It is soft taste guidance with source and generation metadata, not Expressed Preference Evidence, an Explicit Exclusion, or a permanent personal fact.
_Avoid_: taste.md, user-authored preference, permanent profile

**Pick Order**:
The order in which songs selected by a DJ pick-next run should be appended to the playback queue.
_Avoid_: shuffle order, display order

**Ranked Backfill**:
Additional selections drawn from already recalled and ranked candidates when the primary selection returns fewer songs than the auto-fill batch size.
_Avoid_: random fallback, legacy fallback

**Candidate Quality Signal**:
Soft evidence about whether a recalled song candidate is worth selecting, based on metadata such as popularity, title integrity, and completeness. It is distinct from objective Playback Eligibility and may be outweighed by liked provenance or an Explicit Music Request.
_Avoid_: quality score, low quality song

**Quality Signals**:
The collection of candidate quality signals attached to a recalled song candidate.
_Avoid_: scores, ranking score

**Playback Eligibility**:
The source-independent decision that a candidate can objectively be played and has a valid track identity, based on facts such as platform privilege and copyright availability. Liked provenance, Selection Pressure, and an Explicit Music Request cannot override ineligibility.
_Avoid_: Candidate Quality Signal, ranking score, listener preference

**Title Pollution Signal**:
Evidence that a recalled song candidate's title appears to be assembled from search terms, scene words, or collection-style descriptors rather than naming a specific song.
_Avoid_: title duplicate penalty, same-song dedupe

**Listening Constraint**:
A non-entity listening preference that describes fit for the current moment, such as energy, scene, vocal presence, or novelty. It should guide discovery and ranking without being treated as a literal platform search phrase.
_Avoid_: search keyword, query modifier

**Explicit Exclusion**:
A listener-authored instruction to exclude a track or artist until the listener explicitly reverses it. It is durable and must not be inferred from playback behavior alone.
_Avoid_: dislike, Early Skip, temporary ban

**Active Directive**:
A time-bounded listener instruction that guides upcoming selections until it expires or is replaced. It expresses temporary intent rather than durable taste.
_Avoid_: permanent preference, Explicit Exclusion, current chat message

**Temporary Queue Exclusion**:
A short-lived safeguard that prevents a skipped or removed track from being automatically reintroduced into the queue. It is neither an Explicit Exclusion nor negative Preference Evidence.
_Avoid_: ban, dislike, durable preference

**Track Understanding**:
A reusable, versioned semantic assessment of a track, derived from bounded lyric evidence, credits, wiki tags, and platform metadata. It contains a stable profile, per-field confidence, and short source-attributed evidence summaries; raw lyrics are neither logged nor persisted. Cached understanding is reused only while its analyzer version and lyric hash remain current, and a changed lyric hash invalidates the prior semantic profile.
_Avoid_: raw lyric cache, current-scene judgment, permanent ground truth

**Track Compatibility**:
A current-run decision about whether Track Understanding fits the effective Listening Constraints. Query-plan constraints take precedence over fallback context; compatibility is distinct from Candidate Quality, and an uncertain semantic fit is not itself a conflict. `off` disables semantic assessment, `shadow` observes without changing picks, and the two `enforce_*` modes express conflicts and suspicious quality only as traceable soft Ranking pressure. Compatibility never becomes a hard eligibility gate or safety block.
_Avoid_: ranking score, track quality, stable track attribute

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
Traceable, confidence-bearing evidence about how one user responds to music entities, relationships, or fresh music signals. It retains its source and freshness, may decay or be superseded by contrary evidence, and does not include Explicit Exclusions or Active Directives.
_Avoid_: global music knowledge, objective quality

**Expressed Preference Evidence**:
Soft Preference Evidence created when the listener directly states a durable music taste. It has no fixed expiry but may be superseded by a contrary statement; contextual wording belongs to an Active Directive, and an instruction to block playback belongs to an Explicit Exclusion.
_Avoid_: Explicit Exclusion, Active Directive, permanent profile

**Inferred Preference Evidence**:
Soft Preference Evidence inferred from dialogue or listening behavior rather than directly stated as durable taste. It decays over time and repeated evidence may strengthen it only up to a bounded maximum.
_Avoid_: Expressed Preference Evidence, Explicit Exclusion, permanent dislike

**Retrieval History**:
Operational evidence about how prior recall queries performed, used only to deduplicate, order, budget, or temporarily cool down autonomous retrieval work. Attempts are retained for 30 days and policy decisions consume only the prior 14 days. It does not express user taste, does not influence candidate preference ranking, and must not restrict an Explicit Music Request.
_Avoid_: Preference Evidence, negative feedback, query preference

**Explicit Music Request**:
A current listener request that names a desired track, artist, album, playlist, or other Music Entity. It takes precedence over Active Directives and Selection Pressure, but not over an unrevoked Explicit Exclusion or an objective playback constraint.
_Avoid_: search query, style hint, inferred preference

**Selection Pressure**:
Evidence-derived influence that reduces how readily a candidate is recalled, ranked, or selected without becoming a durable exclusion. It is subordinate to an Explicit Music Request and may act differently during autonomous selection than during an explicit request.
_Avoid_: penalty, ban, dislike

**Listening Episode**:
A continuous attempt to listen to one track, beginning only after audio actually starts and ending when it completes, is skipped, fails, or is interrupted. Pausing and resuming the same track remains part of the same episode. Raw episodes are retained for 90 days, while Selection Pressure consumes only the prior 60 days.
_Avoid_: play record, audio URL request, browser playback session

**Listening Exposure**:
The portion of a track actually heard during a Listening Episode. It is evidence for repeat suppression, not by itself a positive or negative preference judgment.
_Avoid_: play count, playback request, skip penalty

**Playback Outcome**:
The final classification of a Listening Episode as completed, skipped, failed, or interrupted. Failed and interrupted outcomes do not imply negative Preference Evidence.
_Avoid_: player state, queue transition, media event

**Early Skip**:
A user-initiated skipped Playback Outcome before the track reaches its midpoint. It creates track-level negative Preference Evidence; only repeated Early Skips across distinct tracks may create primary-artist evidence, while a skip at or after the midpoint is non-negative and collaborators are not inferred.
_Avoid_: dislike, artist ban, failed playback

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
