# DJ Agent Session Log and Personal Context Implementation Plan

> Required sub-skill for implementation: use `superpowers:subagent-driven-development` for parallel review/test work where practical, or `superpowers:executing-plans` for a single-agent implementation pass. Keep checklist status updated as work lands.

## Goal

Build a coherent DJ runtime around a new `DJAgent` orchestration boundary. The first implementation should make automatic song selection and segue generation feel like one continuous DJ, while allowing local LifeMesh context to influence music selection through a privacy-preserving push model.

## Decisions

- Use a per-user `DJ Session Log` for continuity, not as an event-sourcing source of truth.
- Add `DJAgent` as the use-case orchestrator. Keep `MusicAgent` focused on candidate recall, ranking, diversity, and final pick validation.
- Model `DJ Event` at decision/action granularity, not chat-turn granularity.
- Use explicit `correlationId`, `causationEventId`, and `runId` to connect related DJ Events.
- First event set: `listener_request_received`, `directive_updated`, `personal_context_uploaded`, `selection_started`, `track_selected`, `queue_changed`, `segue_generated`.
- Store DJ Events in one append-only `dj_events` table with strict typed payload schemas.
- Store Personal DJ Context uploads as append records. Latest record is current; records from the last 24 hours are available as trend/change signals; older non-current records are deleted.
- Protect Personal DJ Context ingestion with user-scoped Bridge Tokens, not browser JWT reuse and not a global ingest key.
- Bridge Tokens are write-only for Personal DJ Context ingestion.
- A Crossfadio repo skill will call LifeMesh CLI, build a DJ-specific derived payload, and upload it only when explicitly requested or when automation passes an upload flag.

## Architecture Shape

```text
Local LifeMesh / skill
  -> lifemesh bundle "<DJ task>"
  -> Personal DJ Context payload
  -> POST /api/personal-dj-context with Bridge Token

Crossfadio server
  -> validate Bridge Token
  -> store Personal DJ Context record
  -> append personal_context_uploaded DJ Event

DJAgent
  -> buildDjContextSnapshot()
     -> recent DJ Events
     -> current + recent Personal DJ Context
     -> existing MusicAgentContextSummary
  -> pickNext()
     -> MusicAgent
     -> queue adapter
     -> DJ Session Log
  -> generateSegue()
     -> Selection Rationale for target track
     -> recent DJ continuity
     -> existing TTS flow
```

## Phase 1: Storage, Tokens, and Ingestion

### Files

Create:

- `src/server/store/dj-events.ts`
- `src/server/store/personal-dj-context.ts`
- `src/server/store/personal-dj-context-tokens.ts`
- `src/server/http/routes/personal-dj-context.ts`
- `src/server/http/middleware/personalDjContextBridgeAuth.ts`
- `tests/unit/dj-events-store.spec.ts`
- `tests/unit/personal-dj-context-store.spec.ts`
- `tests/unit/personal-dj-context-routes.spec.ts`

Modify:

- `src/server/store/migrations.ts`
- `src/server/http/index.ts`
- `src/server/config.ts` only if token prefix/limits need environment overrides.
- `src/renderer/views/Settings/SettingsView.tsx` only after the backend token lifecycle is working.

### Tasks

- [ ] Add `dj_events` migration.
- [ ] Add `personal_dj_contexts` migration.
- [ ] Add `personal_dj_context_tokens` migration.
- [ ] Implement strict zod payload schemas for the first seven DJ Event types.
- [ ] Implement named per-user token generation with prefix `cfdj_ctx_`, one-time plaintext return, hash-only storage, revoke, and `last_used_at`.
- [ ] Allow multiple active Bridge Tokens per user, with an active-token cap of 10.
- [ ] Implement `POST /api/personal-dj-context` using Bridge Token auth.
- [ ] Implement current/trend lookup:
  - latest non-revoked context is current.
  - prior records within 24 hours are trend records.
  - older non-current records are deleted opportunistically on write/read.
- [ ] Append `personal_context_uploaded` DJ Event on successful upload.
- [ ] Add Settings API for token list/create/revoke using existing JWT auth.
- [ ] Do not broadcast Personal DJ Context uploads to the player SSE stream in the first version.

### Acceptance

- [ ] A valid Bridge Token can upload a strict Personal DJ Context payload.
- [ ] Invalid/revoked Bridge Tokens cannot upload.
- [ ] Bridge Token cannot read settings, queue, messages, or context history.
- [ ] Unknown top-level payload fields are rejected.
- [ ] Oversized payloads are rejected.
- [ ] Latest context remains current until replaced or revoked.
- [ ] Old non-current contexts older than 24 hours are deleted.

## Phase 1.5: Settings Management UI

The backend token lifecycle is part of Phase 1. The Settings UI is useful but should not block LifeMesh push or DJAgent integration.

### Files

Modify:

- `src/renderer/views/Settings/SettingsView.tsx`
- `src/renderer/api.ts`
- `tests/unit/settings-view.spec.ts`

### Tasks

- [ ] Add a Personal Context / Integrations section in Settings.
- [ ] List Bridge Tokens by name, creation time, last used time, and revoked state.
- [ ] Create a Bridge Token through the JWT-protected Settings API.
- [ ] Enforce the active-token cap and show a clear error when the cap is reached.
- [ ] Show token plaintext only once after creation.
- [ ] Revoke tokens.
- [ ] Show current Personal DJ Context status:
  - latest upload time
  - source kind
  - retained recent records count
  - whether current context is active or revoked
- [ ] Add a manual "revoke current Personal DJ Context" action.

### Acceptance

- [ ] A logged-in user can create and revoke Bridge Tokens from Settings.
- [ ] Token plaintext is not shown after the creation response.
- [ ] Settings UI is not required for script-level Phase 1 acceptance.

## Phase 2: DJAgent Pick-next Orchestration

### Files

Create:

- `src/server/dj-agent/index.ts`
- `src/server/dj-agent/context.ts`
- `src/server/dj-agent/events.ts`
- `src/server/dj-agent/ports.ts`
- `tests/unit/dj-agent-context.spec.ts`
- `tests/unit/dj-agent-pick-next.spec.ts`

Modify:

- `src/server/dj/pickNextRun.ts`
- `src/server/dj/musicAgentPickNextResult.ts` only as needed to return structured decisions instead of hiding them inside route-level handling.

### Tasks

- [ ] Add `DjContextSnapshot` as the upper context object.
- [ ] Keep `MusicAgentContextSummary` nested under `DjContextSnapshot.musicSelectionContext`.
- [ ] Include current Personal DJ Context and 24-hour trend records in `DjContextSnapshot`.
- [ ] Expose only Personal DJ Context summary/guidance fields to LLM prompts; keep source refs for Settings, debugging, and audit.
- [ ] Move pick-next use-case orchestration into `DJAgent.pickNext()`.
- [ ] Keep LLM and `MusicAgent` unable to directly mutate queue.
- [ ] Apply queue mutations through a queue port/adapter.
- [ ] Append `selection_started` before MusicAgent execution.
- [ ] Append one `track_selected` per accepted pick, using per-track `Selection Rationale`.
- [ ] Append `queue_changed` after queue mutation, with result summary only.
- [ ] Preserve current HTTP/SSE contract and debug events.
- [ ] Preserve legacy fallback behavior.

### Acceptance

- [ ] Existing pick-next tests still pass.
- [ ] A successful MusicAgent pick-next writes `selection_started`, `track_selected`, and `queue_changed`.
- [ ] `track_selected` includes per-track rationale and batch rationale.
- [ ] Ranked fallback and legacy fallback behavior remains visible in telemetry.
- [ ] Personal DJ Context can influence prompt/context without bypassing CandidatePool validation.

## Phase 3: DJAgent Segue Orchestration

### Files

Create:

- `src/server/dj-agent/segue.ts`
- `tests/unit/dj-agent-segue.spec.ts`

Modify:

- `src/server/http/routes/segue.ts`
- `src/server/agent/segue-context.ts` only if needed to accept DJAgent-provided context.

### Tasks

- [ ] Add `DJAgent.generateSegue()`.
- [ ] Preserve existing segue response schema:
  - `say`
  - `duckingHintSec`
  - `filterSweep`
  - `emotionTag`
- [ ] Preserve current `/api/sse/segue` contract and TTS/cache/fallback behavior.
- [ ] Resolve the target track's most relevant `track_selected` event by explicit relation or track id + recency.
- [ ] Add Selection Rationale and Personal DJ Context guidance to segue prompt context.
- [ ] Do not expose Personal DJ Context source refs or citation labels to the segue LLM prompt.
- [ ] Append `segue_generated` after successful generation.
- [ ] Do not expose private LifeMesh details in generated segue; use `segueGuidance.privacyRule`.

### Acceptance

- [ ] Segue generation can refer to why the next track was selected.
- [ ] Existing segue route tests still pass.
- [ ] `segue_generated` is recorded with from/to track ids and linked selection event when available.
- [ ] TTS behavior remains unchanged.

## Phase 4: Crossfadio Personal DJ Context Skill

### Files

Create:

- `skills/crossfadio-personal-dj-context/SKILL.md`
- `skills/crossfadio-personal-dj-context/scripts/build_personal_dj_context.py`
- `skills/crossfadio-personal-dj-context/scripts/upload_personal_dj_context.py`
- `skills/crossfadio-personal-dj-context/templates/default-task.txt`
- `tests/unit/personal-dj-context-skill.spec.ts` or a script-level smoke test if the repo test harness should not execute Python.

### Default LifeMesh Task

```text
为 Crossfadio AI DJ 生成当前个人上下文摘要，用于今天的音乐选择、播放能量控制、避免项和两首歌之间的自然过渡语气。只提取对选歌和口播有帮助的低敏/Private 以内信息，不包含原始私密内容、完整日记、账号、地址、健康细节。
```

### Payload Shape

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-08T10:00:00+08:00",
  "summary": "最近在密集写代码，适合低干扰、稳定节奏的音乐。",
  "currentState": {
    "activity": "coding",
    "energy": "medium",
    "attention": "low_distraction",
    "mood": "focused"
  },
  "musicGuidance": {
    "energyCurve": "steady",
    "preferredTextures": ["steady rhythm", "warm vocal"],
    "avoidTextures": ["too noisy", "high drama"],
    "vocalPreference": "mixed",
    "novelty": "balanced"
  },
  "musicHints": [
    {
      "kind": "style",
      "label": "low-distraction city pop",
      "strength": "medium",
      "reason": "fits current focus state"
    }
  ],
  "segueGuidance": {
    "tone": "familiar but discreet",
    "privacyRule": "Acknowledge broad state only; do not reveal concrete private details."
  },
  "source": {
    "kind": "lifemesh_bundle",
    "bundleId": "bundle-id",
    "sliceRefs": [
      {
        "sliceId": "slice-id",
        "evidenceRole": "context",
        "citationLabel": "manual-input-v1:..."
      }
    ]
  }
}
```

### Tasks

- [ ] Build payload from `lifemesh bundle --source all --sensitivity-cap Private --max-slices 12`.
- [ ] Do not upload raw slice content or full bundle.
- [ ] Default behavior writes local JSON only.
- [ ] Upload requires explicit `--upload` or a separate upload script invocation.
- [ ] Support `--task`, `--max-slices`, and `--sensitivity-cap` overrides.
- [ ] Do not enable `--include-unverified` by default.
- [ ] Read `CROSSFADIO_BASE_URL` and `CROSSFADIO_PERSONAL_DJ_CONTEXT_TOKEN`.
- [ ] Print only upload status, expiry/retention semantics, slice count, and summary-level fields.

### Acceptance

- [ ] Skill can generate a valid payload without uploading.
- [ ] Skill can upload with a valid Bridge Token.
- [ ] Skill never prints or uploads raw LifeMesh slice content.
- [ ] Upload result creates a `personal_context_uploaded` DJ Event.

## Phase 5: Chat Integration Later

Chat is not the core first path. Keep the existing chat decision chain in the first implementation.

Later tasks:

- [ ] Append `listener_request_received` when user chat is saved.
- [ ] Append `directive_updated` when queue active directive changes.
- [ ] Append selection events when chat recommendation adds tracks.
- [ ] Consider `DJAgent.handleChat()` only after pick-next and segue are stable.

## End-to-End Acceptance Scenario

```text
1. Local skill builds and uploads Personal DJ Context.
2. Crossfadio stores the upload and records personal_context_uploaded.
3. DJ pick-next starts.
4. DJAgent builds DjContextSnapshot with:
   - recent DJ Events
   - latest Personal DJ Context
   - recent 24-hour Personal DJ Context trend records
   - MusicAgentContextSummary
5. MusicAgent selects tracks.
6. DJAgent records selection_started, one track_selected per pick, and queue_changed.
7. Player triggers segue.
8. DJAgent.generateSegue reads the target track Selection Rationale and Personal DJ Context.
9. Segue naturally connects from current track to selected track without exposing private details.
10. DJAgent records segue_generated.
```

## Verification Commands

Use the repo's existing Node version constraints before SQLite-backed tests:

```bash
eval "$(fnm env)" && fnm use 20.19.5
pnpm vitest run tests/unit/dj-events-store.spec.ts tests/unit/personal-dj-context-store.spec.ts tests/unit/personal-dj-context-routes.spec.ts
pnpm vitest run tests/unit/dj-agent-context.spec.ts tests/unit/dj-agent-pick-next.spec.ts tests/unit/dj-agent-segue.spec.ts
pnpm check
git diff --check
```

For skill smoke testing:

```bash
python3 skills/crossfadio-personal-dj-context/scripts/build_personal_dj_context.py --out /tmp/personal-dj-context.json
python3 skills/crossfadio-personal-dj-context/scripts/upload_personal_dj_context.py --file /tmp/personal-dj-context.json
```

## Non-goals

- Do not turn DJ Session Log into the source of truth for queue or playback state.
- Do not let LifeMesh expose a local server to online Crossfadio.
- Do not store raw LifeMesh bundle content in Crossfadio.
- Do not let Bridge Token read any Crossfadio data.
- Do not make Personal DJ Context force playback of tracks or artists.
- Do not broadcast Personal DJ Context updates to the player in the first version.
- Do not rewrite chat before pick-next and segue continuity are working.
