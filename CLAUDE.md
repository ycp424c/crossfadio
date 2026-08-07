# Crossfadio — AI Agent Context

Multi-user AI DJ Web App. Node.js + Express BFF (JWT auth, per-user SQLite), React + Tailwind frontend, Web Audio playback engine, Netease Cloud Music as music source.

## Tech Stack

| Layer | Tech |
|-------|------|
| Language | TypeScript (full-stack, shared zod schemas) |
| Frontend | Vite + React 18 + Tailwind CSS 3 + zustand |
| Backend | Node.js + Express HTTP + SSE (real-time push) |
| Database | better-sqlite3 (`state.db`) |
| Audio | Web Audio API (dual-deck + GainNode + BiquadFilter) |
| Music | NeteaseCloudMusicApi (spawned subprocess) |
| LLM/TTS | OpenAI-compatible (env-var configured, per-user TTS voice) |
| Testing | Vitest (unit + integration) |

## Directory Structure

```
src/
  server/           # Local BFF (Node.js)
    index.ts        # Bootstrap, NCM spawn, graceful shutdown
    app-paths.ts    # Data dir resolution (macOS/Linux/Windows)
    config.ts       # Env var loader + startup validator
    crypto.ts       # AES-256-GCM encrypt/decrypt
    allowlist.ts    # NCM ID allowlist loader
    logger.ts       # pino structured logging
    weather.ts      # wttr.in / openweather
    http/
      index.ts      # Express app setup, all route registration
      sse.ts        # SSE utility (writeSseEvent, initSseRes, endSse)
      routes/       # One file per feature domain
      middleware/   # Auth middleware (JWT + userScope + admin) (multi-user)
    agent/          # compute() + fragments + modes + schema
    llm/            # OpenAI-compatible client (streaming/non-streaming)
    tts/            # TTS client + SHA-256 cache
    ncm/            # spawn.ts, client.ts, auth.ts
    store/          # db.ts, migrations.ts, domain stores
      users.ts      # User CRUD + blocked login attempts (multi-user)
    user-corpus/    # Template bootstrap
  renderer/
    App.tsx         # 3-tab layout: Player / Chat / Settings
    api.ts          # HTTP client for /api endpoints
    lib-hooks.ts    # useMediaQuery hook (md=768px breakpoint)
    lib-motion.ts   # prefers-reduced-motion scroll behavior helper
    views/          # Player/, Settings/ (chat lives in components/player/ChatPanel)
    components/     # player/ (7 components)
    audio/          # engine, crossfade, prefetch, timeline, lyrics
    sse/client.ts   # SSE client: EventSource for broadcasts, fetch streams for one-shot jobs
  shared/
    schema.ts       # Zod schemas (DTOs, SSE events, agent I/O; a few legacy WS auth types remain unused)
    types.ts
```

## Conventions

- **No mock in integration paths**: NCM auth, LLM calls in route handlers use real clients injected via middleware
- **All HTTP routes registered in** `src/server/http/index.ts` — single source of truth, split into public and protected
- **LLM/TTS runtime from env vars**: `CROSSFADIO_LLM_*` / `CROSSFADIO_TTS_*` are required at startup. LLM thinking mode and TTS voice are per-user prefs; base URLs, API keys, and model names remain server-wide env config.
- **JWT auth required for protected routes**: `Authorization: Bearer <token>` header, verified by `authMiddleware`
- **Error codes**: `NCM_E_*` for NCM errors, zod validation for DTOs at boundaries
- **TypeScript strict**: `pnpm check` runs `tsc --noEmit` on both tsconfigs, must pass before commit
- **Commit style**: Conventional commits in Chinese (`feat(player):`, `fix(dj):`, `refactor(...):`, `style(...):`)

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CROSSFADIO_PORT` | `4318` | Web server port |
| `CROSSFADIO_DATA_DIR` | OS-specific | App data directory |
| `CROSSFADIO_SECRET_KEY` | (none) | (deprecated) Encryption key for secrets.json |
| `CROSSFADIO_NCM_COMMAND` | `pnpm exec NeteaseCloudMusicApi` | NCM API launch command |
| `CROSSFADIO_NCM_ARGS` | (none) | Additional NCM CLI args |
| `CROSSFADIO_NCM_PORT` | `3000` | NCM API port |
| `CROSSFADIO_NCM_CWD` | app path | NCM process working directory |
| `CROSSFADIO_NCM_HEALTH_PATH` | `/` | NCM health check path |
| `CROSSFADIO_NCM_DISABLE_AUTO` | (auto-enabled) | Set to `1` to disable auto-launch |
| `CROSSFADIO_JWT_SECRET` | **required** | HS256 signing key for JWT tokens (multi-user) |
| `CROSSFADIO_JWT_TTL_DAYS` | `7` | JWT token validity in days |
| `CROSSFADIO_LLM_BASE_URL` | **required** | LLM API base URL (multi-user) |
| `CROSSFADIO_LLM_API_KEY` | **required** | LLM API key (multi-user) |
| `CROSSFADIO_LLM_MODEL` | **required** | Server-wide LLM model name; review the provider-switch checklist in `docs/ops-runbook.md` before changing it |
| `CROSSFADIO_TTS_PROVIDER` | `aliyun-qwen` | TTS provider: `aliyun-qwen` \| `openai-compatible` \| `tencent-cloud` (腾讯云语音合成 1073) |
| `CROSSFADIO_TTS_BASE_URL` | (provider-dependent) | TTS API base URL, required for `aliyun-qwen` / `openai-compatible` |
| `CROSSFADIO_TTS_API_KEY` | (provider-dependent) | TTS API key, required for `aliyun-qwen` / `openai-compatible` |
| `CROSSFADIO_TTS_SECRET_ID` | (provider-dependent) | 腾讯云 CAM SecretId，`tencent-cloud` 专用（TC3 签名） |
| `CROSSFADIO_TTS_SECRET_KEY` | (provider-dependent) | 腾讯云 CAM SecretKey，`tencent-cloud` 专用（TC3 签名） |
| `CROSSFADIO_TTS_VOICE_DEFAULT` | provider-dependent | Default TTS voice; required for `openai-compatible`, otherwise falls back to `Cherry` |
| `CROSSFADIO_TTS_MODEL` | provider-dependent | Required for `openai-compatible`; `aliyun-qwen` defaults to `qwen3-tts-flash` |
| `CROSSFADIO_EMBEDDING_API_KEY` | (disabled) | Optional semantic discovery embedding API key |
| `CROSSFADIO_EMBEDDING_BASE_URL` | DashScope compatible URL | Optional embedding API base URL |
| `CROSSFADIO_EMBEDDING_MODEL` | `text-embedding-v4` | Optional embedding model name |
| `CROSSFADIO_EMBEDDING_DIMENSIONS` | `1024` | Optional embedding vector dimensions |
| `CROSSFADIO_EMBEDDING_SEND_DIMENSIONS` | `1` | Set to `0` to omit the `dimensions` field (models like TokenHub `kinfra-text-embedding-4b` reject it; actual dimensions come from the response) |
| `CROSSFADIO_HOST` | `127.0.0.1` | Server bind address |
| `CROSSFADIO_ALLOWED_ORIGINS` | (none) | Comma-separated CORS origins beyond localhost |
| `CROSSFADIO_DAILY_THEME_TIMEOUT_MS` | `15000` | Daily theme LLM generation timeout (ms) |
| `CROSSFADIO_SEARCH_API_KEY` | (disabled) | Optional Doubao Search (豆包搜索 Custom 版) API key; enables real-time hot topics in daily theme generation |
| `CROSSFADIO_SEARCH_TIMEOUT_MS` | `3000` | Doubao Search request timeout (ms); search failure degrades to static date info only |
| `CROSSFADIO_ADMIN_NCM_ID` | (none) | NCM user ID with whitelist admin privileges |

## HTTP API Routes

### Health & Runtime
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Service health |
| GET | `/api/runtime` | Service version + health (public) |

### NCM
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/ncm/status` | NCM process status |
| GET/POST | `/api/ncm/login/qr` | Create QR login key |
| GET | `/api/ncm/login/status` | Poll QR status |
| GET | `/api/ncm/login/session` | Current login state |
| POST | `/api/ncm/login/logout` | Logout (new path) |
| POST | `/api/ncm/logout` | Logout (legacy path) |

### Playback
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/now` | Current track URL + lyrics |
| GET | `/api/next` | Next track for prefetch |
| POST | `/api/plays` | Log play start |
| PATCH | `/api/plays/:id` | Log play end |

### Queue & Likes
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/queue/liked` | Get liked songs queue |
| GET | `/api/queue/liked/ids` | Get liked song IDs only |
| POST | `/api/queue/like` | Toggle like on a track |
| PUT | `/api/queue/state` | Persist queue state |

### DJ / Segue / Chat
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/dj/pick-next` | Legacy DJ pick-next trigger (kept for compatibility; player uses `/api/sse/pick-next`) |
| POST | `/api/segue/trigger` | Legacy segue trigger (kept for compatibility; player uses `/api/sse/segue`) |
| GET | `/api/segue/audio/*` | Serve cached segue audio |
| GET | `/api/messages/recent` | Recent chat messages |


### Whitelist (admin only)
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/whitelist` | JWT+admin | List allowlist entries |
| GET | `/api/whitelist/blocked` | JWT+admin | List blocked login attempts |
| POST | `/api/whitelist` | JWT+admin | Add user to allowlist |
| DELETE | `/api/whitelist/:ncmId` | JWT+admin | Remove user from allowlist (also deletes user session) |
| POST | `/api/whitelist/unblock/:id` | JWT+admin | Unblock a login attempt (adds to allowlist) |

### SSE
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/sse/events` | JWT | Persistent EventSource stream (queue events) |
| POST | `/api/sse/chat` | JWT | Chat message + SSE stream response |
| POST | `/api/sse/chat/cancel` | JWT | Cancel active recommendation |
| POST | `/api/sse/segue` | JWT | Segue trigger + SSE stream response |
| POST | `/api/sse/pick-next` | JWT | DJ pick-next + SSE stream response |

### Settings & Location
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/settings` | JWT | Get settings (LLM/TTS config + per-user LLM thinking/TTS voice + dailyThemeEnabled + discoveryMode) |
| PUT | `/api/settings` | JWT | Save preferences (LLM thinking, TTS voice, dailyThemeEnabled, discoveryMode) |
| GET | `/api/settings/player-context` | JWT | Player context (daily theme + taste + discoveryMode) |
| POST | `/api/settings/analyze-taste` | JWT | Analyze music taste from liked songs |
| POST | `/api/location` | JWT | Set browser geolocation |

> **Note:** LLM/TTS `baseUrl`, `model`, and `apiKey` come from env vars (`CROSSFADIO_LLM_*`, `CROSSFADIO_TTS_*`), not from the Settings UI. The Settings UI exposes per-user LLM thinking mode when the configured provider/model supports it, plus TTS voice selection, daily theme toggle, and player-side discovery mode.

## Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Start dev (server + web concurrently)
pnpm dev:server       # Server only (tsx watch)
pnpm dev:web          # Frontend only (vite)
pnpm check            # Type-check both tsconfigs
pnpm test             # Run all Vitest tests
pnpm build            # Production build
pnpm start            # Start production server
```

## Production

Real deployment identifiers, paths, runtime configuration, log locations and operational commands live only in the ignored `.local/ops/production-runbook.md` and `.local/ops/production.env`. Read them before any production action. If either file is missing or stale, stop and ask the environment owner to restore it.

[`docs/ops-runbook.md`](docs/ops-runbook.md) defines the repository privacy boundary. `./scripts/deploy.sh` contains reusable deployment logic and refuses to operate without an explicit local private configuration.

## Architecture Notes

- **3 tabs**: Player, Chat, Settings — all mounted, visibility toggled via `display:none`
- **Player layout**: Header (logo + nav buttons + NCM chip) + full-width discovery mode rail + main player column (cover-backed hero + lyrics + timeline + controls + context panels) + queue/status column
- **Discovery mode**: User pref `discovery.mode` is `explore` (default) or `comfort`. Explore treats taste as an expansion seed and blends daily theme, time, weather, and DJ persona; comfort treats taste as a stronger anchor.
- **NCM cover art**: `NcmClient.getSongDetails()` maps `/song/detail` `al.picUrl` to `coverImgUrl`; queue, now/next, and DJ appended tracks carry it to `NowPlayingHero` and `QueuePanel`.
- **Dual-deck audio**: `AudioContext` with A/B deck rotation, equal-energy crossfade (cos/sin curves), BiquadFilter lowpass sweep
- **Segue timing**: d-12s trigger → d-10s prefetch → d-8s crossfade start → d-7s TTS ducking
- **Agent**: Single-agent, 2 modes (segue/chat), 6-fragment prompt assembly, zod output validation with retry
- **Real-time push**: SSE replaces WebSocket. `GET /api/sse/events` (EventSource) for persistent queue events. `POST /api/sse/{chat,segue,pick-next}` (fetch+ReadableStream) for one-shot streaming tasks with AbortController on client disconnect. The player guards `pick-next` with a local in-flight ref so long-running selection opens only one SSE stream at a time. Renderer retries `/api/sse/segue` up to three attempts on transient `502/503/504`.
- **NCM auth**: QR code login → JWT token (HS256 via `jose`). Cookie encrypted with AES-256-GCM in `users` table. `authMiddleware` + `userScopeMiddleware` on all protected routes. Whitelist management routes additionally require `adminMiddleware` (checks `CROSSFADIO_ADMIN_NCM_ID`).
- **Whitelist**: `allowlist.json` in app data dir controls which NCM user IDs can log in. Admin can manage via Settings UI. Removal also deletes `users` record to immediately revoke existing sessions. `userScopeMiddleware` double-checks `isAllowed()` on every request.
- **Per-user isolation**: All DB tables have `user_id` column. Queue/location are per-user `Map`s. User corpus files under `users/<ncmId>/`.
- **Daily theme**: LLM-generated daily radio theme (holidays, solar terms, artist anniversaries + optional Doubao Search hot topics when `CROSSFADIO_SEARCH_API_KEY` is set; search failure degrades to static date info only). Per-user toggle in Settings (pref `dailyTheme.enabled`). When disabled, DJ pick-next and segue skip theme context. Timeout controlled by `CROSSFADIO_DAILY_THEME_TIMEOUT_MS` (default 15s). Generated theme is persisted in the `meta` table so restarts keep the same theme within a day.
- **LLM thinking**: Per-user and disabled by default. TokenHub `hy3` / `hy3-preview` requests set `max_tokens` to 128,000 when thinking is enabled because reasoning and the final answer share the output budget. Provider/model switches must re-check thinking support, parameter constraints, and output budgets as documented in `docs/ops-runbook.md`.
- **Responsive layout**: `md` = 768px breakpoint, single-column mobile (grid-cols-1), desktop preserves 12-col grid. NCM auth uses full-screen sheet on mobile via `useMediaQuery`. Status panel collapsed to one-line summary on mobile. `viewport-fit=cover` for iPhone safe areas.
