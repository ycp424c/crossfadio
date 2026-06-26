# MusicAgent Semantic Discovery Optimization Plan

## Context

Recent DJ pick-next runs exposed a recall quality problem: NCM song search works well for exact track and artist queries, but performs poorly for mood, scene, and style phrases such as `city pop 柔和` or `indie pop 中低能量`. Those phrases either return empty results or title-polluted audio that only matches the words in the title.

The current MusicAgent already has a bounded tool loop, candidate pool, ranking, query funnel stats, NCM trend adapters, and candidate quality filtering. The next optimization should keep those pieces, but separate semantic discovery from NCM exact recall.

## Problem Statement

The agent currently lets style and scene terms leak into NCM song search. This makes recall depend on NCM lexical matching instead of on concrete music entities.

Bad shape:

```text
listening intent -> "city pop 中低能量" -> NCM song search -> empty or polluted results
```

Target shape:

```text
listening intent -> semantic discovery -> concrete music entities -> NCM exact recall -> ranking
```

## Goals

- Treat NCM search as exact recall, not semantic discovery.
- Convert listening constraints into concrete music entities before platform recall.
- Use embeddings to retrieve from known entities without requiring a heavy vector database in the first version.
- Keep the seed catalog as a cold-start entry map, not a fixed recommendation library.
- Preserve existing query funnel and ranking feedback, but attach it to entity discovery and recall outcomes.

## Non-goals

- Do not build a full collaborative filtering system.
- Do not make LLM output final NCM IDs without platform verification.
- Do not require DashVector, pgvector, or another managed vector store in the first implementation.
- Do not remove existing ranking, title-first dedupe, quality signals, or batch diversity behavior.

## Domain Model

### Listening intent

The user's current need, built from current text, active directive, moment, queue state, recent play signals, and long-term preferences.

Example:

```text
下午，低能量，city pop，女声，探索一点
```

### Listening constraints

Constraints are not NCM search terms. They are scoring and filtering signals.

Examples:

- `下午`
- `中低能量`
- `不吵`
- `女声`
- `探索`

### Style hints

Style hints can guide discovery, but should not be mechanically combined with constraints for NCM song search.

Examples:

- `city pop`
- `dream pop`
- `cantopop`
- `synth-pop`

### Music entities

Concrete entities that can be verified or expanded through NCM.

Entity types:

- track: `Candy - 具島直子`
- artist: `具島直子`
- album: `miss.G`
- playlist: NCM playlist related to a style or scene
- chart item: NCM top song or trend item

## Proposed Pipeline

```text
MusicAgent context
  -> intent parser
  -> semantic discovery
      -> local semantic index
      -> seed catalog expansion
      -> recent successful picks
      -> liked/history corpus
      -> trend/chart hints
      -> optional LLM entity hypotheses
  -> exact recall
      -> track resolve
      -> artist expansion
      -> album expansion
      -> playlist expansion
      -> chart item resolve
  -> CandidatePool
  -> quality enrichment
  -> ranking and diversity
  -> final picks
```

## Recall Policy

### Entity verification

Discovery output must be verified before it can create playable candidates.

- Track with title and artist: accept only when title approximately matches and the primary artist matches.
- Track with title only: accept only the top result when the title match is high-confidence.
- Artist only: do not create a song candidate directly; use it only for artist expansion.
- Album only: do not create a song candidate directly; use it only for album expansion.
- Failed matches are recorded as rejected discoveries and never enter CandidatePool.

### NCM song search

Allowed:

- exact track query: `Spain Chick Corea`
- exact track and artist query: `Candy 具島直子`
- high-confidence LLM track hypothesis after validation
- track hints from plan segments, charts, playlists, or known catalog entries

Disallowed:

- mood-only phrases: `轻松`, `柔和`
- scene phrases: `下午女声`, `工作不吵`
- style plus energy phrases: `indie pop 中低能量`
- style plus generic vocal phrases unless proven by measured recall quality

### NCM artist search

Use artist search when semantic discovery produces an artist entity. Then expand through artist top songs or artist albums when supported by the NCM adapter.

Needed NCM adapter additions:

- search artists by keyword
- fetch artist top songs
- fetch artist albums

### NCM album search

Use album search when discovery produces an album entity. Then expand album tracks.

Needed NCM adapter additions:

- search albums by keyword
- fetch album detail

### NCM playlist search

Use playlist search for style hints only as a discovery bridge, not as final song search. Playlist tracks still go through CandidatePool, quality enrichment, and ranking.

Needed NCM adapter additions:

- search playlists by keyword
- fetch playlist detail already exists

## Semantic Index

The semantic index is a local corpus of verified music entities with text descriptions suitable for embedding retrieval.

### Entity record

```ts
type MusicEntity = {
  id: string;
  type: 'track' | 'artist' | 'album' | 'playlist' | 'chart_item';
  provider: 'ncm' | 'catalog' | 'llm_verified';
  providerId?: string;
  title?: string;
  artist?: string;
  album?: string;
  description: string;
  styleHints: string[];
  constraints: string[];
  sourceSignals: string[];
  lastVerifiedAt?: string;
};
```

### Embedding text

Embedding text should describe musical fit, not implementation details.

Example:

```text
track: Candy
artist: 具島直子
style: city pop, japanese pop
fit: female vocal, relaxed, melodic, afternoon, medium-low energy
signals: selected before, not recently repeated
```

### First storage backend

Use SQLite first:

- `music_entities`
- `music_entity_embeddings`
- vector stored as Float32 BLOB or JSON text

Rationale:

- The project already uses SQLite through `better-sqlite3`.
- The expected first corpus is small enough for brute-force cosine search.
- This keeps the first version reversible if the corpus grows.

Move to DashVector, pgvector, or another vector store only when local brute-force search becomes a measured bottleneck or when the corpus becomes shared and large.

## Embedding Provider

Use the existing OpenAI-compatible provider pattern for an embedding client. The current project has separate LLM and TTS config; embedding should get explicit config rather than assuming the TTS key always has embedding permission.

Recommended env vars:

```text
CROSSFADIO_EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
CROSSFADIO_EMBEDDING_API_KEY=...
CROSSFADIO_EMBEDDING_MODEL=text-embedding-v4
CROSSFADIO_EMBEDDING_DIMENSIONS=1024
```

The same Alibaba Cloud account key may work, but startup should validate this with a small embedding health check and fail softly if embeddings are unavailable.

Deployment note: in the first rollout, set `CROSSFADIO_EMBEDDING_API_KEY` to the same Alibaba Cloud Bailian key already used by the existing model integrations, unless production verification shows that the key lacks embedding permissions. Keep the embedding environment variables separate even when the same key value is used.

## Seed Catalog

The seed catalog should not be a recommendation list. It should provide high-confidence discovery entry points for cold start and sparse local corpora.

Example:

```ts
type SeedCatalogEntry = {
  style: string;
  seedArtists: string[];
  seedAlbums: Array<{ title: string; artist?: string }>;
  seedTracks: Array<{ title: string; artist?: string }>;
  adjacentStyles: string[];
};
```

### Diversity controls

- Limit catalog-sourced candidates to a fixed share of the recall budget.
- Penalize seed artists that appeared recently in the queue or recent picks.
- Penalize catalog entries with high recent selected count.
- Mix catalog results with local semantic index, liked/history, trend/chart, and LLM-verified entities.
- Apply existing artist, track, and title motif diversity during final selection.

## LLM Role

The LLM may generate entity hypotheses, not final playable IDs.

Allowed output:

```json
{
  "entities": [
    {
      "type": "artist",
      "name": "具島直子",
      "reason": "city pop 女声，下午中低能量"
    },
    {
      "type": "track",
      "title": "Candy",
      "artist": "具島直子",
      "reason": "city pop 女声，轻快但不吵"
    }
  ],
  "constraints": ["下午", "中低能量", "不吵"],
  "avoidArtists": ["Taylor Swift"]
}
```

Every LLM entity must be verified through NCM or the local entity index before entering CandidatePool.

## Scoring

Candidate scoring should consume listening constraints after recall.

Signals:

- semantic similarity to the current listening intent
- user taste fit
- source confidence
- novelty fit
- time and scene fit
- recent artist penalty
- recent track penalty
- query/entity repeat penalty
- title pollution penalty
- platform quality signals

This keeps `中低能量`, `不吵`, and `女声` as ranking inputs instead of brittle NCM search modifiers.

## Implementation Plan

### Phase 1: Stop semantic phrases from entering NCM song search

- Replace `QueryPlan` search fields with an entity-oriented discovery plan.
- Keep exact track queries from plan segments and known track hints.
- Move style hints and listening constraints out of `recall_from_ncm_search`.
- Add tests proving mood/style constraints are not sent to NCM song search.

### Phase 2: Add local music entity store

- Add `music_entities` and `music_entity_embeddings` migrations.
- Add store APIs for upsert, lookup, recent usage, and similarity candidate loading.
- Backfill from liked tracks, recent plays, successful DJ picks, and plan track hints.
- Store entity provenance and usage feedback.

### Phase 3: Add embedding client and local cosine retrieval

- Add OpenAI-compatible embedding client.
- Add embedding config and startup health check.
- Generate embeddings for entity descriptions.
- Query current listening intent against local vectors.
- Keep brute-force cosine first; measure latency before choosing a vector database.

### Phase 4: Add entity expansion tools

- `discover_music_entities`
- `recall_from_entities`
- `recall_from_artists`
- `recall_from_albums`
- `recall_from_playlists`

Add NCM adapter methods for artist, album, and playlist search/detail as needed.

### Phase 5: Update feedback loop

- Record entity funnel stats separately from raw query stats.
- Store entity feedback separately from `music_query_stats`; query stats describe NCM search phrase performance, while entity stats describe discovery source and entity usefulness.
- Track entity source, result count, added count, selected count, and recent repeat penalty.
- Use selected and skipped outcomes to reweight future semantic discovery.

### Phase 6: Evaluate and optionally move to vector database

Only consider DashVector, pgvector, or another vector backend after measuring:

- corpus size
- average semantic lookup latency
- recall quality improvements
- operational complexity

## Observability

Add logs and diagnostics for:

- generated listening intent
- semantic discovery sources used
- entity candidates before NCM verification
- NCM exact recall paths used
- entities rejected by verification
- semantic index hit count
- catalog share of candidate pool
- selected entity source distribution

## Tests

Required regression tests:

- style and constraint phrases never reach NCM song search
- exact track and artist queries still reach NCM
- seed catalog is capped by recall budget
- repeated seed artists are penalized
- semantic index retrieval returns verified entities only
- LLM-generated entities are rejected when NCM verification fails
- CandidatePool still applies title-first dedupe and title pollution filtering

## Open Decisions

### Decision 1: First corpus scope

Decision: user-local corpus first.

Start with the current user's liked tracks, recent plays, successful picks, plan hints, and verified discoveries. Defer a global shared corpus until the local loop proves useful.

### Decision 2: First vector backend

Decision: SQLite brute-force cosine first.

This is reversible and matches the current storage model. Introduce DashVector or pgvector only after local retrieval is measured as insufficient.

### Decision 3: Seed catalog budget

Decision: cap catalog-sourced candidates to 10% of recall before ranking.

This keeps the catalog as a narrow cold-start entry point without letting it dominate the queue. If local semantic retrieval is sparse, the system should prefer verified history, trend/chart hints, or LLM-verified entities before increasing catalog share.

### Decision 4: LLM entity generation

Decision: allow LLM entity hypotheses only after local semantic index, trend/chart hints, and seed catalog fail to provide enough verified entities.

This keeps cost and hallucination pressure lower while preserving exploration. LLM-generated entities must be verified through NCM or the local semantic index before entering CandidatePool.

### Decision 5: Embedding configuration

Decision: keep embedding configuration independent from TTS and LLM configuration, but deploy the first version with the same Alibaba Cloud Bailian API key value.

Use separate `CROSSFADIO_EMBEDDING_*` environment variables so model, dimensions, permissions, and health checks can evolve independently. During the first deployment, populate `CROSSFADIO_EMBEDDING_API_KEY` with the same key currently used for Alibaba Cloud model integrations, then verify embedding access with a startup or deployment smoke check.

### Decision 6: Entity verification strictness

Decision: use strict entity verification before candidates enter CandidatePool.

Tracks with title and artist require both title and primary artist matches. Title-only tracks require a high-confidence top-result match. Artist-only and album-only entities can only drive expansion, not direct song candidate creation. Rejected entities should be recorded for diagnostics and future discovery weighting.

### Decision 7: Entity feedback storage

Decision: store entity feedback separately from `music_query_stats`.

Keep NCM query performance and semantic entity usefulness as separate feedback loops. Query stats answer whether a literal search phrase returned useful platform results; entity stats answer whether a discovered track, artist, album, playlist, or chart item produced viable and selected candidates.

## References

- Alibaba Cloud documentation describes using Bailian/DashScope text embeddings with DashVector for vector retrieval.
- Alibaba Cloud ADBPG documentation shows an OpenAI-compatible embedding configuration using `text-embedding-v4` and DashScope API keys.
