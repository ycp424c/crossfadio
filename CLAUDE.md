# Crossfadio — AI Agent Context

Multi-user AI DJ Web App. Node.js + Express BFF (JWT auth, per-user SQLite), React + Tailwind frontend, Web Audio playback engine, Netease Cloud Music as music source.

## Tech Stack

| Layer | Tech |
|-------|------|
| Language | TypeScript (full-stack, shared zod schemas) |
| Frontend | Vite + React 18 + Tailwind CSS 3 + zustand |
| Backend | Node.js + Express HTTP + SSE (127.0.0.1) |
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
    App.tsx         # 4-tab layout: Player / Plan / Chat / Settings
    api.ts          # HTTP client for /api endpoints
    lib-hooks.ts    # useMediaQuery hook (md=768px breakpoint)
    views/          # Player/, Plan/, Settings/
    components/     # player/ (8 components), ui-button
    audio/          # engine, crossfade, prefetch, timeline, lyrics
    sse/client.ts   # SSE client: EventSource for broadcasts, fetch streams for one-shot jobs
  shared/
    schema.ts       # Zod schemas (DTOs, agent I/O; a few legacy WS auth types remain unused)
    types.ts
```

## Conventions

- **No mock in integration paths**: NCM auth, LLM calls in route handlers use real clients injected via middleware
- **All HTTP routes registered in** `src/server/http/index.ts` — single source of truth, split into public and protected
- **LLM/TTS keys from env vars**: `CROSSFADIO_LLM_*` / `CROSSFADIO_TTS_*` required at startup. Only TTS voice is per-user pref.
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
| `CROSSFADIO_LLM_MODEL` | **required** | LLM model name (multi-user) |
| `CROSSFADIO_TTS_BASE_URL` | **required** | TTS API base URL (multi-user) |
| `CROSSFADIO_TTS_API_KEY` | **required** | TTS API key (multi-user) |
| `CROSSFADIO_TTS_VOICE_DEFAULT` | (none) | Default TTS voice, falls back to 'Cherry' |
| `CROSSFADIO_HOST` | `127.0.0.1` | Server bind address |
| `CROSSFADIO_ALLOWED_ORIGINS` | (none) | Comma-separated CORS origins beyond localhost |
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

### Plan
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/plan/today` | Today's plan |
| POST | `/api/plan/regenerate` | Full replan |
| POST | `/api/plan/replan-segment` | Replace one segment |
| POST | `/api/plan/gap-fill` | Fill missing tracks |

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
| GET | `/api/sse/events` | JWT | Persistent EventSource stream (queue/plan events) |
| POST | `/api/sse/chat` | JWT | Chat message + SSE stream response |
| POST | `/api/sse/chat/cancel` | JWT | Cancel active recommendation |
| POST | `/api/sse/segue` | JWT | Segue trigger + SSE stream response |
| POST | `/api/sse/pick-next` | JWT | DJ pick-next + SSE stream response |

### Settings & Location
| PUT | `/api/settings` | JWT | Save TTS voice preference |
| POST | `/api/location` | JWT | Set browser geolocation |

> **Note:** LLM/TTS `baseUrl`, `model`, and `apiKey` come from env vars (`CROSSFADIO_LLM_*`, `CROSSFADIO_TTS_*`), not from the Settings UI. The Settings UI only exposes TTS voice selection.


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

Live deployment runbook (instance, paths, restart, allowlist edits, persona updates) is at [`docs/ops-runbook.md`](docs/ops-runbook.md). Read it before doing anything on the box.

Production-specific topology and access details belong only in the ignored local runbook.

## Architecture Notes

- **4 tabs**: Player, Plan, Chat, Settings — all mounted, visibility toggled via `display:none`
- **Player layout**: Header (logo + nav buttons + NCM chip) + left col (hero + lyrics + timeline + controls) + right col (queue + status)
- **Dual-deck audio**: `AudioContext` with A/B deck rotation, equal-energy crossfade (cos/sin curves), BiquadFilter lowpass sweep
- **Segue timing**: d-12s trigger → d-10s prefetch → d-8s crossfade start → d-7s TTS ducking
- **Agent**: Single-agent, 3 modes (plan/segue/chat), 6-fragment prompt assembly, zod output validation with retry
- **Real-time push**: SSE replaces WebSocket. `GET /api/sse/events` (EventSource) for persistent queue/plan events. `POST /api/sse/{chat,segue,pick-next}` (fetch+ReadableStream) for one-shot streaming tasks with AbortController on client disconnect. The player guards `pick-next` with a local in-flight ref so long-running selection opens only one SSE stream at a time.
- **NCM auth**: QR code login → JWT token (HS256 via `jose`). Cookie encrypted with AES-256-GCM in `users` table. `authMiddleware` + `userScopeMiddleware` on all protected routes. Whitelist management routes additionally require `adminMiddleware` (checks `CROSSFADIO_ADMIN_NCM_ID`).
- **Whitelist**: `allowlist.json` in app data dir controls which NCM user IDs can log in. Admin can manage via Settings UI. Removal also deletes `users` record to immediately revoke existing sessions. `userScopeMiddleware` double-checks `isAllowed()` on every request.
- **Per-user isolation**: All DB tables have `user_id` column. Queue/location are per-user `Map`s. User corpus files under `users/<ncmId>/`.
- **Responsive layout**: `md` = 768px breakpoint, single-column mobile (grid-cols-1), desktop preserves 12-col grid. NCM auth uses full-screen sheet on mobile via `useMediaQuery`. Status panel collapsed to one-line summary on mobile. `viewport-fit=cover` for iPhone safe areas.
