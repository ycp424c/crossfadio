# Resource Tier Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Replace whitelist-only admission with open authenticated access, while treating current allowlist members as priority users with reserved capacity and constraining standard users through persistent daily credits, per-user concurrency, global standard-user capacity, input limits, and reduced background work.

**Architecture:** Keep allowlist.json as the backward-compatible priority-membership source rather than an authorization source. Add a SQLite-backed daily usage bucket and an in-process resource governor for the current single Node process. Apply permits at actual expensive job lifetimes, not only HTTP admission, and return typed 429 resource_limited responses with Retry-After.

**Tech Stack:** TypeScript, Express 4, better-sqlite3, React, Vitest, Node 22.19.0, pnpm 10.18.0.

---

## Scope and non-goals

Required behavior:

- Every valid NCM account can authenticate. Existing allowlist membership is not required for login, normal JWT requests, or Personal DJ Context Bridge tokens.
- Existing allowlist.json entries are priority users. Everyone else is standard.
- Explicitly suspended users remain blocked at login, JWT request, and Bridge-token boundaries; suspension is independent of priority membership.
- Removing a priority user does not delete the users row, revoke the current JWT, or delete user data.
- Standard users have persistent Shanghai-calendar-day credits and lower per-user concurrency.
- Standard users together cannot occupy priority-reserved global capacity.
- Non-SSE background jobs hold permits until actual work completes.
- Basic playback, queue, likes, settings, location, messages, and listening-history endpoints remain usable after AI credits are exhausted.
- Standard users do not automatically trigger full taste analysis or entity indexing from ordinary requests.
- Standard users cannot enable LLM thinking or raise DJ auto-fill above two tracks.
- Public QR endpoints have IP limits, chat has a size limit, and event SSE has tier-aware connection caps.
- Every resource rejection is an explicit 429 rather than an unhandled 500.

Non-goals:

- Do not split provider keys, add Redis, deploy, push, create an MR, or modify production configuration.
- Do not rename allowlist.json or remove compatibility API paths.
- Do not fix the unrelated date-dependent doubao-search unit failure.
- Do not add payments, monetary balances, or a distributed job queue.

## Default policy

Create one policy module with these defaults and positive-integer environment overrides:

~~~
totalConcurrency: 4
standardGlobalConcurrency: 2
standardUserConcurrency: 1
priorityUserConcurrency: 2
standardDailyCredits: 200
priorityDailyCredits: 5000
retryAfterSeconds: 5

chat cost: 4
dj_pick_next cost: 8
segue cost: 2
tts_preview cost: 2
taste_analysis cost: 40
~~~

Environment names:

~~~
CROSSFADIO_RESOURCE_TOTAL_CONCURRENCY
CROSSFADIO_RESOURCE_STANDARD_GLOBAL_CONCURRENCY
CROSSFADIO_RESOURCE_STANDARD_USER_CONCURRENCY
CROSSFADIO_RESOURCE_PRIORITY_USER_CONCURRENCY
CROSSFADIO_RESOURCE_STANDARD_DAILY_CREDITS
CROSSFADIO_RESOURCE_PRIORITY_DAILY_CREDITS
~~~

Invalid overrides fall back to safe defaults. Enforce standardGlobalConcurrency <= totalConcurrency and ensure each daily limit is at least the largest single-operation cost.

## File map

Create:

- src/server/resource-policy.ts: tier resolution and effective limits.
- src/server/store/resource-usage.ts: atomic daily credits.
- src/server/store/user-access-controls.ts: persistent active/suspended safety status.
- src/server/resource-governor.ts: in-process concurrency and permits.
- src/server/http/resource-limit-response.ts: typed 429 responses.
- src/server/http/middleware/ip-rate-limit.ts: public fixed-window limiter.
- tests/unit/resource-policy.spec.ts
- tests/unit/resource-usage-store.spec.ts
- tests/unit/user-access-controls.spec.ts
- tests/unit/resource-governor.spec.ts
- tests/unit/ip-rate-limit.spec.ts

Modify:

- src/server/store/migrations.ts
- src/server/ncm/auth.ts
- src/server/http/middleware/userScope.ts
- src/server/http/middleware/personalDjContextBridgeAuth.ts
- src/server/http/routes/whitelist.ts
- src/server/http/routes/access-controls.ts
- src/server/http/index.ts
- src/server/http/routes/sse-events.ts
- src/server/http/routes/djNext.ts
- src/server/http/routes/segue.ts
- src/server/http/routes/settings.ts
- src/server/http/routes/taste-analysis.ts
- src/server/llm/config.ts
- src/renderer/views/Settings/SettingsView.tsx
- src/renderer/api.ts
- README.md
- CLAUDE.md
- affected existing unit tests

---

### Task 1: Convert allowlist admission into priority membership

- [ ] Write failing tests first.

Tests must create an isolated data directory, write allowlist.json, call loadAllowlist(), and prove:

~~~
resolveUserTier(priorityUser) === priority
resolveUserTier(ordinaryUser) === standard
ordinary valid NCM login returns authorized plus a JWT
ordinary JWT request reaches next()
ordinary valid Bridge token reaches next()
demotion retains getUserById(userId)
demotion changes the tier to standard
~~~

- [ ] Run the affected tests and confirm old behavior fails:

~~~
fnm exec --using=22.19.0 -- corepack pnpm exec vitest run   tests/unit/resource-policy.spec.ts   tests/unit/ncm-auth.spec.ts   tests/unit/middleware-userscope.spec.ts   tests/unit/personal-dj-context-routes.spec.ts   tests/unit/whitelist-routes.spec.ts
~~~

- [ ] Implement this public contract in resource-policy.ts:

~~~
export type UserTier = 'standard' | 'priority';

export function resolveUserTier(userId: string): UserTier {
  return isAllowed(userId) ? 'priority' : 'standard';
}
~~~

Do not create another priority cache.

- [ ] Remove allowlist authorization checks from NcmAuthService.checkQr, userScopeMiddleware, and personalDjContextBridgeAuth. Retain all missing-user, bad-token, revoked-token, and cookie-decryption checks.

- [ ] Change DELETE /api/whitelist/:ncmId to remove priority membership only. It must not call deleteUser or delete user state.

- [ ] Run the focused tests and require all to pass.

### Task 1B: Preserve an independent suspension boundary

- [ ] Write failing store, auth, middleware, Bridge-token, and admin-route tests.

Add a persistent table with this contract:

~~~
CREATE TABLE user_access_controls (
  user_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
~~~

Tests must prove that missing rows default to active, suspension is idempotent and survives restart, and reactivation restores access without changing priority membership or deleting user data.

- [ ] Implement these store functions in src/server/store/user-access-controls.ts:

~~~
getUserAccessStatus(userId) => 'active' | 'suspended'
setUserAccessStatus(userId, status) => void
listSuspendedUsers() => Array<{ userId, updatedAt }>
~~~

- [ ] Enforce suspended status at all three identity boundaries: NCM login, userScopeMiddleware, and personalDjContextBridgeAuth. A suspended login records blocked_login_attempts and returns forbidden; ordinary standard users do not create blocked attempts.

- [ ] Add admin-protected compatibility-safe routes:

~~~
GET    /api/access/suspended
POST   /api/access/suspended          body { ncmId }
DELETE /api/access/suspended/:ncmId
~~~

Suspending a user takes effect on the next JWT or Bridge request but does not delete the user, JWT, Bridge token, or historical data. Reactivation does not promote the user to priority.

- [ ] Update the existing blocked-attempt unblocking action so it reactivates a suspended user and deletes the selected attempt; it must not add the user to the priority list.

- [ ] Run:

~~~
fnm exec --using=22.19.0 -- corepack pnpm exec vitest run \
  tests/unit/user-access-controls.spec.ts \
  tests/unit/ncm-auth.spec.ts \
  tests/unit/middleware-userscope.spec.ts \
  tests/unit/personal-dj-context-routes.spec.ts \
  tests/unit/whitelist-routes.spec.ts
~~~

Require all to pass before continuing.

### Task 2: Add persistent daily credits

- [ ] Write failing migration and store tests.

Add this table:

~~~
CREATE TABLE resource_usage_buckets (
  user_id TEXT NOT NULL,
  period_key TEXT NOT NULL,
  credits_used INTEGER NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, period_key)
)
~~~

Store tests cover same-day accumulation, user isolation, Shanghai-day rollover, exact-limit success, overflow rejection, and persistence after DB close/reopen.

- [ ] Run:

~~~
fnm exec --using=22.19.0 -- corepack pnpm exec vitest run   tests/unit/resource-policy.spec.ts   tests/unit/resource-usage-store.spec.ts   tests/unit/dj-v2-migrations.spec.ts
~~~

- [ ] Implement ResourceOperation as chat, dj_pick_next, segue, tts_preview, and taste_analysis. Implement EffectiveResourcePolicy and environment parsing with a test reset hook.

- [ ] Implement this store contract:

~~~
reserveDailyCredits({
  userId,
  credits,
  limit,
  now
}) => {
  periodKey,
  creditsUsed,
  creditsRemaining
}
~~~

Use formatShanghaiDate(now). Perform insert, conditional update, and readback in one immediate transaction. The SQL update must enforce credits_used + requested <= limit. Throw a dedicated quota error containing the period key, limit, and used amount.

- [ ] Run the three focused files and require all pass.

### Task 3: Implement reserved concurrency

- [ ] Write failing governor tests for:

~~~
standard per-user limit 1
priority per-user limit 2
standard global limit 2
priority can acquire the remaining two slots while standard is saturated
total capacity rejects every tier when four slots are occupied
release is idempotent
quota rejection rolls back counters
concurrency rejection does not charge credits
different Shanghai dates use different buckets
~~~

- [ ] Implement these contracts:

~~~
ResourceLimitError.code =
  daily_quota_exceeded |
  user_concurrency_exceeded |
  standard_capacity_exceeded |
  global_capacity_exceeded

acquireResourcePermit(userId, operation, now?) => {
  tier,
  operation,
  creditsUsed,
  creditsRemaining,
  release()
}
~~~

Admission order: validate concurrency, tentatively increment counters, reserve persistent credits, roll counters back if credit reservation fails, return the permit. Charge credits on admission; downstream failures are not refunded.

- [ ] Implement a JSON 429 serializer with Retry-After:

~~~
{
  ok: false,
  error: 'resource_limited',
  reason: error.code,
  operation: error.operation,
  message: safe Chinese message
}
~~~

Do not expose global counts or another user's usage.

- [ ] Run resource-governor and global-error focused tests.

### Task 4: Guard complete expensive job lifetimes

- [ ] Write failing lifetime tests that prove:

~~~
chat holds a permit until handleChatMessage resolves or aborts
SSE pick-next holds a permit through runner completion
fire-and-forget pick-next holds after the HTTP response and until job completion
SSE and fire-and-forget segue hold through synthesis completion
TTS preview releases on success and failure
taste analysis releases on success, null, timeout, and exception
rejection returns 429 before provider/job work starts
one manual taste analysis consumes one charge, not two
~~~

- [ ] Acquire before initializing SSE or starting work. Release from finally.

- [ ] For fire-and-forget routes, acquire before returning success and release only in the asynchronous job finally block. If rejected, return 429 and do not report that a job started.

- [ ] For SSE, reject before initSseRes so a denied request stays ordinary JSON.

- [ ] Put exactly one taste-analysis permit boundary at a shared level covering manual and scheduler paths.

- [ ] Run:

~~~
fnm exec --using=22.19.0 -- corepack pnpm exec vitest run   tests/unit/resource-governor.spec.ts   tests/unit/chat-dj-events.spec.ts   tests/unit/dj-next.spec.ts   tests/unit/segue-routes.spec.ts   tests/unit/settings-routes.spec.ts
~~~

### Task 5: Apply standard-tier feature caps

- [ ] Write failing tests proving standard requests do not schedule automatic taste analysis or entity indexing, while priority requests still do.

- [ ] Test that standard thinking remains disabled even with a stored true preference.

- [ ] Test settings GET returns autoFillBatchSize 2 for standard users and PUT rejects attempts to enable thinking or save a larger batch.

- [ ] In userScopeMiddleware, schedule automatic taste analysis and indexing only for priority users.

- [ ] Add settings response fields:

~~~
resourceTier: 'standard' | 'priority'
resourceCapabilities: {
  thinking: boolean
  configurableAutoFillBatchSize: boolean
}
~~~

- [ ] Reject disallowed settings writes with 403 and error resource_tier_restricted. Do not silently persist ignored values.

- [ ] Run middleware, settings, and llm-config tests.

### Task 6: Harden public and connection entry points

- [ ] Write deterministic limiter tests with an injected clock.

Limits:

~~~
QR creation: 5 per IP per 10 minutes
QR status: 40 per IP per 60 seconds
chat text: trimmed 1 to 2000 characters
event SSE: standard 1 connection, priority 3 connections
~~~

- [ ] The fixed-window limiter must key only on Express req.ip, return 429 with Retry-After, isolate IPs, and prune expired buckets. Do not parse forwarded headers directly.

- [ ] Apply independent limiter instances to GET/POST /api/ncm/login/qr and GET /api/ncm/login/status.

- [ ] Reject excess event connections before initSseRes. Closing a stream releases its count exactly once.

- [ ] Run IP limiter, SSE, and server route tests.

### Task 7: Update UI and docs

- [ ] Update renderer tests first. User-facing wording must say 优先资源用户 or 资源保障名单 and must not claim ordinary users cannot log in.

- [ ] Demotion confirmation must say access and data remain, but resource limits become standard.

- [ ] Add a separate suspension section using the new access-control routes. Its wording must distinguish temporary safety suspension from priority demotion; reactivation must not promote a user.

- [ ] Keep wire paths compatible, but rename local renderer functions/types toward priority membership where safe.

- [ ] README.md and CLAUDE.md must document:

~~~
all valid NCM users can authenticate
allowlist.json means priority resource membership
daily-credit defaults
reserved concurrency defaults
429 resource_limited plus Retry-After
standard background restrictions
SQLite persists credits across restarts
concurrency counters are single-process only
strict upstream guarantees require separate provider credentials in a future phase
~~~

- [ ] Run settings-view and renderer-api tests.

### Task 8: Final DSH validation

- [ ] Run git diff --check and require exit 0.

- [ ] Run type checks:

~~~
fnm exec --using=22.19.0 -- corepack pnpm check
~~~

- [ ] Run all new and affected focused tests; require exit 0.

- [ ] Run the complete suite:

~~~
fnm exec --using=22.19.0 -- corepack pnpm test
~~~

Known baseline on 2026-08-10: tests/unit/doubao-search.spec.ts has one unrelated stable failure because its first fixture hard-codes PublishTime 2026-08-07T09:00:00+08:00 while production filtering drops topics older than 36 hours. No additional failure is acceptable, and this task must not edit that test.

- [ ] Run production builds:

~~~
fnm exec --using=22.19.0 -- corepack pnpm build
~~~

- [ ] Self-review the full diff and verify:

~~~
no standard auth boundary uses isAllowed as authorization
all three identity boundaries reject a persistently suspended user
demotion deletes no user or user state
fire-and-forget jobs do not release at response time
one operation is not double charged
standard global occupancy never exceeds its cap
priority admission works while standard capacity is saturated
all release paths are idempotent
no secrets, env files, production files, commits, pushes, or deployments were created
~~~

- [ ] Report status, changed files, focused tests, full suite with exact baseline failure, type/build results, concerns, and git status. Do not commit or push.
