# MusicAgent Web Music Discovery Plan

## Context

Crossfadio's MusicAgent already separates semantic discovery from exact platform recall: listening constraints and style hints should become verified music entities before NCM recall. The first semantic discovery backend is the local SQLite semantic index, as recorded in ADR 0001.

The remaining exploration gap is that the local index can be sparse. When the user wants novelty, similar artists, recent releases, or a style area that the local corpus does not know yet, the agent needs a bounded way to learn from public music information without letting web search directly pollute the candidate pool.

## Goal

Add Web Music Discovery as a bounded external discovery stage that produces sourced Music Entity Hints, verifies them into Music Entities, and gradually improves future discovery through durable shared music knowledge, fresh music signals, and user-specific preference evidence.

Target shape:

```text
listening intent
  -> local semantic discovery
  -> exploration gap check
  -> web music discovery
  -> music entity hints
  -> entity verification
  -> exact recall
  -> CandidatePool
  -> ranking and final picks
```

## Non-goals

- Do not let web search results enter CandidatePool directly.
- Do not let the LLM invent NCM IDs or treat a web page mention as playable.
- Do not replace the local semantic index with web search.
- Do not write user-specific taste feedback into shared music knowledge.
- Do not call web search on every DJ pick-next run.
- Do not build a general web crawler in the first version.

## Domain Decisions

- **Web Music Discovery** is an external exploration stage, not NCM recall and not local Semantic Discovery.
- **Music Entity Hints** are sourced leads. They must pass Entity Verification before selection can use them.
- **Durable Music Knowledge** can be shared across users when it describes stable music facts or relationships.
- **Fresh Music Signals** can be cached globally but need recency-aware ranking.
- **Preference Evidence** stays user-specific and must not become objective shared knowledge.
- **Exploration Gap** is a server-side gate made from cheap, explainable signals. It is not an LLM judgment.

ADR 0002 records the architectural boundary: Web Music Discovery runs after local Semantic Discovery when an Exploration Gap remains.

## Exploration Gap Gate

The LLM may request Web Music Discovery, but the server decides whether the request is allowed. The gate should be cheap and deterministic.

Recommended default:

```text
allow_web_music_discovery =
  discoveryMode == explore
  and no cooldown for user + intent cluster
  and (
    explicit explore intent
    or at least two automatic gap signals
  )
```

Explicit explore intent should count strongly. Examples:

- user asks for new music
- user asks for similar artists or similar songs
- current plan/theme asks for recent releases
- current directive asks to explore a style area

Automatic gap signals should be derived from existing local state:

- sparse external candidates: non-liked candidates are below the exploration target
- low source diversity: candidates are dominated by one source
- artist clustered: top artist or artist cluster dominates the shortlist
- semantic discovery empty: local semantic discovery found no enough entities
- query funnel low yield: NCM search had results but added or selected very little
- stale fresh signal: the style or entity cluster has no recent fresh signal
- repeated query cluster: recent runs reuse the same ineffective query family

The gate should log the exact signals used for each allowed or denied web discovery request. This keeps tuning empirical.

## Tool Contract

Add a bounded tool conceptually named `web_music_discovery`.

The input should describe the discovery need, not a raw search string only:

```ts
type WebMusicDiscoveryInput = {
  intent: string;
  focus:
    | 'style_artists'
    | 'style_tracks'
    | 'similar_artists'
    | 'similar_tracks'
    | 'new_releases'
    | 'scene_overview';
  anchors?: Array<{
    type: 'artist' | 'track' | 'album' | 'style';
    name: string;
    artist?: string;
  }>;
  locale?: 'zh-CN' | 'global';
  freshness?: 'durable' | 'recent';
  maxHints?: number;
};
```

The output should be structured hints:

```ts
type MusicEntityHint = {
  kind:
    | 'artist'
    | 'track'
    | 'album'
    | 'playlist'
    | 'chart_item'
    | 'relationship';
  name: string;
  artist?: string;
  relatedName?: string;
  relationshipType?: 'similar_to' | 'represents_style' | 'featured_in_scene' | 'recent_release';
  styles?: string[];
  sourceUrl: string;
  sourceTitle?: string;
  snippet: string;
  confidence: number;
  freshness: 'durable' | 'fresh';
  observedAt: string;
};
```

The tool should not return playable candidates. It returns hints only.

## Entity Verification

Every Music Entity Hint must be verified before it can influence CandidatePool.

Verification policy:

- Track hints must resolve to a platform track identity with a strong title and artist match.
- Artist hints must resolve to a recognizable artist before they can drive artist expansion.
- Album hints must resolve to an album before album-track expansion.
- Relationship hints require both sides to verify.
- Playlist and chart hints can guide recall only after the source is considered trustworthy enough.
- Failed verification should be recorded as rejected discovery, not silently retried forever.

Verified track entities can become Playable Candidates through exact recall. Verified non-track entities can expand into track recall through existing ranking and quality checks.

## Persistence Model

Use separate persistence concepts instead of one generic cache.

### Web Discovery Cache

Short-term cache of raw discovery responses by normalized discovery request.

Purpose:

- avoid repeated web calls for the same intent cluster
- inspect what sources produced hints
- support cooldown decisions

Typical contents:

- normalized request
- provider
- source URLs
- raw snippets or compact extracted records
- observed timestamp
- expiration timestamp

### Shared Music Knowledge

Longer-lived knowledge created from verified and useful hints.

Examples:

- artist belongs to a style or scene
- artist is similar to another artist
- track is representative of a style
- album is associated with a style or period

Shared knowledge should retain provenance and confidence. It should be updated conservatively: one weak web mention should not become high-confidence durable knowledge.

### Fresh Music Signals

Time-sensitive knowledge that decays.

Examples:

- recent release in a style
- current chart or playlist signal
- recent scene activity

Fresh signals can be shared, but ranking should apply user context and recency.

### Preference Evidence

User-specific evidence from selections and playback behavior.

Examples:

- user selected a web-discovered artist
- user skipped a track from a fresh signal
- user repeatedly accepts similar-artist discoveries in one style

Preference evidence can rank or suppress future hints for that user, but must not rewrite shared music knowledge.

## Ranking Integration

Web Music Discovery should affect ranking through verified entities and evidence, not through a new unverified candidate source.

Recommended scoring rules:

- Verified web-discovered track candidates can use source `search`, `style_expansion`, or a future explicit `web_discovery` source only after the schema decision is made.
- Hints with stronger provenance can increase source confidence after verification.
- Fresh Music Signals should increase novelty and freshness, but should not override hard repeat penalties.
- Preference Evidence should adjust user-specific ranking after actual selection or playback, not after mere discovery.
- Liked candidates remain useful as tail fallback, not the primary exploration strategy.

## Failure Modes

The web discovery path must degrade cleanly.

- Web provider unavailable: skip the stage and continue local discovery.
- Search returns noisy results: keep hints rejected or low confidence.
- Verification fails: do not enter CandidatePool.
- Fresh signal expires: stop using it as freshness evidence, but keep durable facts if independently supported.
- Too many hints: keep only the highest-confidence, source-diverse hints.
- Repeated low-yield discovery: activate cooldown for the user and intent cluster.
- LLM requests web discovery when gate denies it: return an observation explaining the denied gap signals and continue local tools.

## Observability

Add logs and debug payload fields that answer:

- Was Web Music Discovery requested?
- Was it allowed or denied?
- Which Exploration Gap signals were present?
- Which discovery request was used?
- How many hints were found?
- How many hints verified?
- How many verified entities entered recall?
- How many resulting candidates were selected?
- Which knowledge records or fresh signals were persisted?

The important metric is not web call count. The important metric is verified, selected, non-repetitive candidates produced from web-discovered knowledge.

## Rollout Plan

### Step 1: Domain and ADR

- Add glossary terms for Web Music Discovery, Music Entity Hint, Entity Verification, Playable Candidate, Durable Music Knowledge, Fresh Music Signal, Shared Music Knowledge, Preference Evidence, and Exploration Gap.
- Record the architectural decision that Web Music Discovery runs after local Semantic Discovery.

### Step 2: Read-only discovery adapter

- Add a provider interface for web music discovery.
- Start with one provider or a test double.
- Return structured Music Entity Hints.
- Do not persist or enter CandidatePool yet.

### Step 3: Exploration Gap gate

- Add deterministic gate signals.
- Log allow and deny decisions.
- Enforce one Web Music Discovery call per DJ pick-next run.
- Add cooldown by user and intent cluster.

### Step 4: Entity Verification

- Verify artist, track, album, playlist, and relationship hints.
- Record rejected discoveries.
- Feed only verified entities into exact recall or semantic index enrichment.

### Step 5: Persistence

- Persist Web Discovery Cache for short-term reuse.
- Persist verified Shared Music Knowledge and Fresh Music Signals with provenance.
- Persist user-specific Preference Evidence separately.

### Step 6: MusicAgent integration

- Add the tool to the bounded tool loop.
- Allow the LLM to request it, but enforce the server gate.
- Include compact verified discovery outcomes in observations.
- Keep final pick validation unchanged: final picks must come from CandidatePool.

### Step 7: Ranking and feedback

- Use verified web discovery provenance as ranking evidence.
- Feed selected and skipped outcomes back into Preference Evidence.
- Track query funnel and discovery funnel metrics together.

### Step 8: Production tuning

- Compare runs with and without web discovery.
- Tune Exploration Gap thresholds by observed enable rate and selected candidate quality.
- Add provider cooldowns if latency or noise is high.

## Test Plan

Unit tests:

- gate allows explicit explore intent
- gate denies comfort mode without explicit explore intent
- gate allows low-yield query funnel plus sparse external candidates
- gate respects cooldown
- web discovery tool returns hints, not candidates
- invalid hints do not enter CandidatePool
- verified track hint becomes exact recall input
- user Preference Evidence does not update Shared Music Knowledge
- expired Fresh Music Signal stops contributing freshness

Integration tests:

- MusicAgent can call Web Music Discovery once in an exploratory run
- denied web discovery produces an observation and continues local recall
- web-discovered verified entities can lead to final LLM picks
- web provider failure falls back to local discovery without legacy random fallback
- repeated low-yield discovery activates cooldown

Ops checks:

- logs expose gate signals and discovery outcomes
- dry-run summary reports requested/allowed/verified/selected counts
- no debug payload leaks full raw web pages

## Open Parameters

These should be tuned after the first instrumentation pass:

- automatic gate threshold: one or two gap signals
- cooldown duration by user and intent cluster
- web discovery timeout
- maximum hints per run
- minimum confidence for persistence
- freshness decay window
- whether to add a dedicated `web_discovery` CandidateSource after verification

## First-version Recommendation

Start conservative:

- explore mode only
- one web discovery call per DJ pick-next run
- explicit explore intent or two automatic gap signals
- short timeout
- hints only, no direct candidates
- track-level verification before any playable candidate
- shared knowledge only after verification
- user feedback stored only as Preference Evidence

This should improve exploration without turning the DJ pick-next path into a slow web-search pipeline.
