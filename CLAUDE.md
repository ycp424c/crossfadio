# Crossfadio — AI Agent Context

Local AI DJ Web App. Node.js + Express BFF, React + Tailwind frontend, Web Audio playback engine, Netease Cloud Music as music source.

## Tech Stack

| Layer | Tech |
|-------|------|
| Language | TypeScript (full-stack, shared zod schemas) |
| Frontend | Vite + React 18 + Tailwind CSS 3 + zustand |
| Backend | Node.js + Express + WebSocket (127.0.0.1) |
| Database | better-sqlite3 (`state.db`) |
| Audio | Web Audio API (dual-deck + GainNode + BiquadFilter) |
| Music | NeteaseCloudMusicApi (spawned subprocess) |
| LLM/TTS | OpenAI-compatible (user-configured endpoint) |
| Testing | Vitest (unit + integration) |

## Directory Structure

```
src/
  server/           # Local BFF (Node.js)
    index.ts        # Bootstrap, NCM spawn, graceful shutdown
    app-paths.ts    # Data dir resolution (macOS/Linux/Windows)
    security.ts     # secrets.json encryption wrapper
    logger.ts       # pino structured logging
    scheduler.ts    # Cron-based plan generation + hourly checks
    weather.ts      # wttr.in / openweather
    http/
      index.ts      # Express app setup, all route registration
      ws.ts         # WebSocket server (auth + chat)
      routes/       # One file per feature domain
    agent/          # compute() + fragments + modes + schema
    llm/            # OpenAI-compatible client (streaming/non-streaming)
    tts/            # TTS client + SHA-256 cache
    ncm/            # spawn.ts, client.ts, auth.ts
    store/          # db.ts, migrations.ts, domain stores
    user-corpus/    # Template bootstrap
  renderer/
    App.tsx         # 4-tab layout: Player / Plan / Chat / Settings
    api.ts          # HTTP client for /api endpoints
    views/          # Player/, Plan/, Settings/
    components/     # player/ (8 components), ui-button
    audio/          # engine, crossfade, prefetch, timeline, lyrics
    ws/client.ts    # WebSocket client
  shared/
    schema.ts       # Zod schemas (DTOs, WS events, agent I/O)
    types.ts
```

## Conventions

- **No mock in integration paths**: NCM auth, LLM calls in route handlers use real clients injected via options
- **All HTTP routes registered in** `src/server/http/index.ts` — single source of truth
- **Secrets never leave the server**: `SecretStore` wraps `secrets.json`, browser only sees `hasApiKey` / `hasCookie` booleans or masked values
- **Error codes**: `NCM_E_*` for NCM errors, zod validation for DTOs at boundaries
- **TypeScript strict**: `pnpm check` runs `tsc --noEmit` on both tsconfigs, must pass before commit
- **Commit style**: Conventional commits in Chinese (`feat(player):`, `fix(dj):`, `refactor(...):`, `style(...):`)

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CROSSFADIO_PORT` | `4318` | Web server port |
| `CROSSFADIO_DATA_DIR` | OS-specific | App data directory |
| `CROSSFADIO_SECRET_KEY` | (none) | Encryption key for secrets.json |
| `CROSSFADIO_NCM_COMMAND` | `pnpm exec NeteaseCloudMusicApi` | NCM API launch command |
| `CROSSFADIO_NCM_ARGS` | (none) | Additional NCM CLI args |
| `CROSSFADIO_NCM_PORT` | `3000` | NCM API port |
| `CROSSFADIO_NCM_CWD` | app path | NCM process working directory |
| `CROSSFADIO_NCM_HEALTH_PATH` | `/` | NCM health check path |
| `CROSSFADIO_NCM_DISABLE_AUTO` | (auto-enabled) | Set to `1` to disable auto-launch |

## HTTP API Routes

### Health & Runtime
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Service health |
| GET | `/api/runtime` | Session token + static dir info |

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
| POST | `/api/dj/pick-next` | DJ picks next track |
| POST | `/api/segue/trigger` | Trigger segue generation |
| GET | `/api/segue/audio/*` | Serve cached segue audio |
| GET | `/api/messages/recent` | Recent chat messages |

### Settings & Location
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/settings` | Read settings (keys masked) |
| PUT | `/api/settings` | Save settings |
| POST | `/api/settings/test-llm` | Test LLM connection |
| POST | `/api/settings/test-tts` | Test TTS + preview audio |
| POST | `/api/location` | Set browser geolocation |

### WebSocket `/ws`

Client connects and sends auth token as first message. Events:
- **C→S**: `auth`, `chat`, `ping`
- **S→C**: `auth.ok`, `chat.delta`, `chat.done`, `segue.tts-ready`, `plan-updated`, `queue-updated`, `dj.debug`

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

## Architecture Notes

- **4 tabs**: Player, Plan, Chat, Settings — all mounted, visibility toggled via `display:none`
- **Player layout**: Header (logo + nav buttons + NCM chip) + left col (hero + lyrics + timeline + controls) + right col (queue + status)
- **Dual-deck audio**: `AudioContext` with A/B deck rotation, equal-energy crossfade (cos/sin curves), BiquadFilter lowpass sweep
- **Segue timing**: d-12s trigger → d-10s prefetch → d-8s crossfade start → d-7s TTS ducking
- **Agent**: Single-agent, 3 modes (plan/segue/chat), 6-fragment prompt assembly, zod output validation with retry
- **NCM auth**: QR code login only, cookie persisted in secrets.json via SecretStore
