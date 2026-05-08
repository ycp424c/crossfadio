# SSE Migration — 移除 WebSocket，全面迁移到 SSE

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将全部服务端→客户端实时推送从 WebSocket 迁移到 SSE（Server-Sent Events），同时将客户端→服务端通信改为纯 HTTP POST，彻底移除 WebSocket 依赖。

**Architecture:** 4 个 SSE 端点 + 纯 HTTP POST 触发。跨功能的队列/计划同步事件走一个持久 `EventSource` 连接；chat、segue、DJ pick-next 这类有副作用的一次性任务全部使用 `fetch(POST)` + `ReadableStream` 读取 SSE 帧，继续通过 `Authorization` header 鉴权，避免 EventSource 自动重连重复触发任务。

**Tech Stack:** Express `res.write()` 手动 SSE，前端 `EventSource` + `fetch` ReadableStream，零新依赖。

---

## 文件变更总览

| 操作 | 文件 |
|------|------|
| **新增** | `src/server/http/sse.ts` — SSE 工具函数 |
| **新增** | `src/server/http/routes/sse-events.ts` — 持久 SSE + chat SSE + cancel |
| **新增** | `src/renderer/sse/client.ts` — 前端 SSE 客户端 |
| **修改** | `src/server/http/routes/segue.ts` — SSE 响应替代 `broadcastToUser` |
| **修改** | `src/server/http/routes/djNext.ts` — SSE 响应替代 `broadcastToUser` |
| **修改** | `src/server/http/routes/chat.ts` — SSE 响应替代 WS send |
| **修改** | `src/server/http/index.ts` — 注册 SSE 路由，移除 WS 相关代码 |
| **修改** | `src/server/http/broadcast.ts` — 写 SSE 连接替代 WS |
| **修改** | `src/renderer/views/Player/PlayerView.tsx` — WS 监听改 SSE |
| **修改** | `src/renderer/components/player/ChatPanel.tsx` — fetch SSE 替代 WS |
| **修改** | `src/renderer/components/player/RecommendOverlay.tsx` — SSE 替代 WS |
| **删除** | `src/server/http/ws.ts` |
| **删除** | `src/renderer/ws/client.ts` |

---

## SSE 端点设计

| 端点 | 方法 | 触发参数 | 流式事件 | 连接类型 | 前端方式 |
|------|------|----------|----------|----------|----------|
| `/api/sse/events` | GET | —（持久连接） | `queue-updated` `queue-appended` `plan-updated` | 持久，自动重连 | `EventSource` |
| `/api/sse/chat` | POST | body `{ text }` | `chat.delta` → `chat.done` `chat.recommend.*` | 一问一答，响应完关闭 | `fetch` + stream |
| `/api/sse/segue` | POST | body `{ clientRequestId, from, to }` | `segue.delta` → `segue.tts-ready` → `segue.degraded`/`segue.done` | 一次任务，响应完关闭 | `fetch` + stream |
| `/api/sse/pick-next` | POST | body `{}` | `dj.debug` → `queue-appended` → `dj.pick-next.done` | 一次任务，响应完关闭 | `fetch` + stream |
| `/api/sse/chat/cancel` | POST | body `{ jobId }` | 无（返回 200） | — | `fetch` |

---

### Task 1: SSE 工具模块

**Files:**
- Create: `src/server/http/sse.ts`

- [ ] **Step 1: 创建 SSE 写入工具**

```typescript
// src/server/http/sse.ts
import type { Response } from 'express';

/** 初始化 SSE 响应头 */
export function initSseRes(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'   // 禁用 nginx 缓冲
  });
}

/** 写入一条 SSE 事件，自动处理多行 data（\n → \ndata:） */
export function writeSseEvent(res: Response, event: string, data: unknown): void {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  const lines = [
    `event: ${event}`,
    ...payload.split('\n').map((line) => `data: ${line}`),
    ''  // 空行表示事件结束
  ];
  res.write(lines.join('\n') + '\n');
}

/** 写入 SSE comment（心跳） */
export function writeSseComment(res: Response, text: string): void {
  res.write(`: ${text}\n\n`);
}

/** 发送 done 事件并关闭连接 */
export function endSse(res: Response, event: string, data: unknown): void {
  writeSseEvent(res, event, data);
  res.end();
}
```

- [ ] **Step 2: 验证类型检查**

```bash
pnpm check
```

---

### Task 2: 持久 SSE 事件流 + Chat SSE + Cancel

**Files:**
- Create: `src/server/http/routes/sse-events.ts`

- [ ] **Step 1: 写 SSE handler**

```typescript
// src/server/http/routes/sse-events.ts
import type { Request, Response } from 'express';
import { z } from 'zod';
import { initSseRes, writeSseEvent, endSse, writeSseComment } from '../sse.js';
import { getLogger } from '../../logger.js';
import type { NcmClient } from '../../ncm/client.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

// ── 持久事件流（队列更新等跨功能事件）────────────────────────────────────────

// per-user SSE 连接池：userId → Set<Response>
const eventClients = new Map<string, Set<Response>>();

/** 注册一个持久 SSE 客户端 */
function addEventClient(userId: string, res: Response): void {
  if (!eventClients.has(userId)) eventClients.set(userId, new Set());
  eventClients.get(userId)!.add(res);
}

/** 注销 */
function removeEventClient(userId: string, res: Response): void {
  eventClients.get(userId)?.delete(res);
}

/** 向指定用户的所有持久 SSE 连接广播事件 */
export function broadcastSse(userId: string, type: string, payload: Record<string, unknown>): void {
  const clients = eventClients.get(userId);
  if (!clients || clients.size === 0) return;
  for (const res of clients) {
    try {
      writeSseEvent(res, type, payload);
    } catch {
      clients.delete(res);
    }
  }
}

/** 持久 SSE 连接处理器 */
export function createSseEventsHandler() {
  return (req: Request, res: Response): void => {
    const userId = (req as AuthedRequest).userId;
    initSseRes(res);

    // 发送初始连接事件
    writeSseEvent(res, 'connected', { userId });

    // 心跳（每 30s）
    const heartbeat = setInterval(() => {
      try { writeSseComment(res, 'ping'); } catch { clearInterval(heartbeat); }
    }, 30_000);

    addEventClient(userId, res);

    res.on('close', () => {
      clearInterval(heartbeat);
      removeEventClient(userId, res);
    });
  };
}

// ── Chat SSE（POST body → stream response）────────────────────────────────────

const chatBodySchema = z.object({ text: z.string().min(1) });

export function createSseChatHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }

    const { userId, ncmClient } = req as AuthedRequest;
    initSseRes(res);
    const controller = new AbortController();
    req.on('close', () => controller.abort(new Error('client-disconnected')));

    const send = (type: string, payload: Record<string, unknown>): void => {
      if (controller.signal.aborted) return;
      try { writeSseEvent(res, type, payload); } catch { controller.abort(new Error('write-failed')); }
    };

    try {
      await handleChatMessage(userId, ncmClient, parsed.data.text, send, controller.signal);
    } catch (err) {
      getLogger().error({ err }, 'Chat SSE handler error');
      try { endSse(res, 'chat.error', { error: 'internal error' }); } catch { /* ignore */ }
    } finally {
      if (!res.writableEnded) res.end();
    }
  };
}

// ── 取消推荐 ─────────────────────────────────────────────────────────────────

const cancelBodySchema = z.object({ jobId: z.string().min(1) });

export function createSseCancelRecommendHandler() {
  return (req: Request, res: Response): void => {
    const parsed = cancelBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }
    cancelActiveRecommend(parsed.data.jobId);
    res.json({ ok: true });
  };
}

// ── 从 chat.ts 引入的核心逻辑 ────────────────────────────────────────────────

// Note: handleChatMessage 和 cancelActiveRecommend 已在 Task 4 提前从 chat.ts 重构而来，
// 接受 send 回调替代直接操作 WS。执行顺序必须先做 Task 4，再做本 Task。
import { handleChatMessage, cancelActiveRecommend } from '../chat-sse-worker.js';
```

- [ ] **Step 2: 注册路由**

在 `src/server/http/index.ts` 中添加：

```typescript
import {
  createSseEventsHandler,
  createSseChatHandler,
  createSseCancelRecommendHandler
} from './routes/sse-events.js';

// ── SSE routes ───────────────────────────────────────────────────────────
const protect = [authMiddleware, userScopeMiddleware];
app.get('/api/sse/events', protect, createSseEventsHandler());
app.post('/api/sse/chat', protect, createSseChatHandler());
app.post('/api/sse/chat/cancel', protect, createSseCancelRecommendHandler());
```

---

### Task 3: Segue 改造为 SSE（POST + fetch stream）

**Files:**
- Modify: `src/server/http/routes/segue.ts`

- [ ] **Step 1: 重构 segue handler 接受 SSE Response 参数**

当前 `runSegueJob` 中的 `emit` 函数调用 `broadcastToUser`。改为接受 `res: Response`，直接写 SSE：

改动集中在 `createSegueTriggerHandler` — 新增 `createSseSegueHandler`：

```typescript
// src/server/http/routes/segue.ts 新增

import { initSseRes, writeSseEvent, endSse } from '../sse.js';

const sseSegueBodySchema = z.object({
  clientRequestId: z.string().min(1),
  from: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    artist: z.string().optional()
  }),
  to: z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    artist: z.string().optional()
  })
});

export function createSseSegueHandler(opts: SegueRouteOptions) {
  return (req: Request, res: Response): void => {
    const parsed = sseSegueBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }
    if (parsed.data.from.id === parsed.data.to.id) {
      res.status(400).json({ ok: false, error: 'from and to must be different' });
      return;
    }

    const userId = (req as AuthedRequest).userId;
    const ncmClient = getScopedNcmClient(req, opts.ncmClient);

    initSseRes(res);

    const requestId = randomBytes(8).toString('hex');
    const clientRequestId = parsed.data.clientRequestId;
    const controller = new AbortController();
    req.on('close', () => controller.abort(new Error('client-disconnected')));

    const sendSse = (type: string, payload: Record<string, unknown>): void => {
      try { writeSseEvent(res, type, payload); } catch { /* disconnect */ }
    };

    runSegueJobSse(requestId, clientRequestId, parsed.data.from, parsed.data.to, opts, userId, ncmClient, controller.signal, sendSse)
      .then(() => {
        if (!res.writableEnded) res.end();
      })
      .catch((err) => {
        getLogger().error({ err }, 'Segue SSE job failed');
        if (!res.writableEnded) endSse(res, 'segue.degraded', { reason: 'error' });
      });
  };
}

// 从现有 runSegueJob 提取，用 sendSse 替代 emit
async function runSegueJobSse(
  requestId: string,
  clientRequestId: string,
  from: TrackInput,
  to: TrackInput,
  opts: SegueRouteOptions,
  userId: string,
  ncmClient: NcmClient,
  signal: AbortSignal,
  sendSse: (type: string, payload: Record<string, unknown>) => void
): Promise<void> {
  const emit = (type: string, payload: Record<string, unknown>) => {
    if (!signal.aborted) sendSse(type, { ...payload, requestId, clientRequestId });
  };
  // 从现有 runSegueJob 提取主体逻辑，唯一差异是 emit 不再调用 broadcastToUser。
  // delta → emit('segue.delta', { say })
  // tts-ready → emit('segue.tts-ready', { ... })
  // degraded → emit('segue.degraded', { reason })
  // 末尾 done → emit('segue.done', {})
}
```

- [ ] **Step 2: 注册路由**

```typescript
// src/server/http/index.ts
app.post('/api/sse/segue', protect, createSseSegueHandler({ secrets: null as any }));
```

- [ ] **保持向后兼容**：旧的 `POST /api/segue/trigger` 保留不变（内部逻辑复用），直到前端迁移完成后再删除。

---

### Task 4: Chat 重构 — 提取核心逻辑

**Files:**
- Create: `src/server/http/chat-sse-worker.ts`
- Modify: `src/server/http/routes/chat.ts`

- [ ] **Step 1: 提取 chat 消息处理为独立函数**

当前 `createChatMessageHandler` 内部闭包持有 `ws` 引用，直接操作 `ws.send()`。需要提取出纯函数，接受 `send` 回调：

```typescript
// src/server/http/chat-sse-worker.ts
import type { NcmClient } from '../ncm/client.js';
import { LlmClient } from '../llm/client.js';
// ... 其余 imports

let activeRecommendJobs = new Map<string, { controller: AbortController }>();

export function cancelActiveRecommend(jobId: string): void {
  const job = activeRecommendJobs.get(jobId);
  if (job) {
    job.controller.abort();
    activeRecommendJobs.delete(jobId);
  }
}

export async function handleChatMessage(
  userId: string,
  ncmClient: NcmClient,
  text: string,
  send: (type: string, payload: Record<string, unknown>) => void,
  signal?: AbortSignal
): Promise<void> {
  const logger = getLogger();
  
  // ... 原有 chat handler 逻辑，所有 ws.send(payload) 改为 send(type, payload)
  // 队列/计划同步仍调用 broadcastToUser(userId, payload)，由 Task 6 统一转发到持久 /api/sse/events。
  // chat stream 只发送 chat.delta、chat.done、chat.error、chat.recommend.* 这些本次请求的响应事件。
  // 在进入耗时 LLM/NCM 调用前检查 signal?.aborted；推荐流水线继续使用独立 job controller，
  // 但请求断开时也要 abort 当前 job controller，防止后台任务继续消耗资源。
}
```

- [ ] **Step 2: 保持旧的 WS handler 兼容**

`chat.ts` 中保留 `createChatMessageHandler`，内部调用 `handleChatMessage(userId, ncmClient, text, send)`，传入 WS 版本的 `send` 回调。SSE 版本在 `sse-events.ts` 中调用 `handleChatMessage(userId, ncmClient, text, send, controller.signal)`。

- [ ] **Step 3: 验证类型检查**

```bash
pnpm check
```

---

### Task 5: DJ Pick-Next 改造为 SSE（POST + fetch stream）

**Files:**
- Modify: `src/server/http/routes/djNext.ts`

- [ ] **Step 1: 新增 SSE handler**

```typescript
// src/server/http/routes/djNext.ts 新增

import { initSseRes, writeSseEvent, endSse } from '../sse.js';

export function createSseDjPickNextHandler(opts: DjNextOptions) {
  return (req: Request, res: Response): void => {
    const userId = (req as AuthedRequest).userId;
    const ncmClient = getScopedNcmClient(req, opts.ncmClient);

    initSseRes(res);

    const sendSse = (type: string, payload: Record<string, unknown>): void => {
      try { writeSseEvent(res, type, payload); } catch { /* disconnect */ }
    };

    // 如果正在运行，直接返回状态
    if (isRunning.get(userId)) {
      endSse(res, 'dj.pick-next.done', { added: false, reason: 'already-running' });
      return;
    }

    isRunning.set(userId, true);
    const controller = new AbortController();
    req.on('close', () => controller.abort(new Error('client-disconnected')));

    runDjPickNextSse(userId, ncmClient, controller.signal, sendSse)
      .then(() => { if (!res.writableEnded) res.end(); })
      .catch((err) => {
        getLogger().error({ err }, 'DJ pick-next SSE failed');
        if (!res.writableEnded) endSse(res, 'dj.pick-next.done', { added: false, reason: 'error' });
      })
      .finally(() => isRunning.set(userId, false));
  };
}

// 从 doPickNext 改造，所有 broadcastToUser 替换为 sendSse
async function runDjPickNextSse(
  userId: string,
  ncmClient: NcmClient,
  signal: AbortSignal,
  sendSse: (type: string, payload: Record<string, unknown>) => void
): Promise<void> {
  const send = (type: string, payload: Record<string, unknown>) => {
    if (!signal.aborted) sendSse(type, payload);
  };
  // 从现有 doPickNext 提取主体逻辑，所有 broadcastToUser 替换为 send。
  // broadcastToUser(userId, { type: 'dj.debug', ... }) → send('dj.debug', { ... })
  // broadcastToUser(userId, { type: 'dj.pick-next.done', ... }) → send('dj.pick-next.done', { ... })
  // broadcastToUser(userId, { type: 'queue-appended', ... }) → send('queue-appended', { ... })
  // 响应关闭只由 createSseDjPickNextHandler 的 then/catch/finally 负责。
}
```

- [ ] **Step 2: 注册路由**

```typescript
// src/server/http/index.ts
app.post('/api/sse/pick-next', protect, createSseDjPickNextHandler({ secrets: null as any }));
```

---

### Task 6: Broadcast 模块适配 SSE

**Files:**
- Modify: `src/server/http/broadcast.ts`

- [ ] **Step 1: 改为写 SSE 连接**

```typescript
// src/server/http/broadcast.ts
import { broadcastSse } from './routes/sse-events.js';

export function broadcastToUser(userId: string, payload: unknown): void {
  const data = payload as Record<string, unknown>;
  const type = typeof data.type === 'string' ? data.type : 'unknown';
  broadcastSse(userId, type, data);
}

// 移除 WS 相关代码（registerWss, broadcast 等）
```

---

### Task 7: 前端 SSE 客户端

**Files:**
- Create: `src/renderer/sse/client.ts`

- [ ] **Step 1: 创建 SSE 客户端模块**

```typescript
// src/renderer/sse/client.ts

type SseEventHandler = (event: string, data: unknown) => void;

// ── 持久事件流（EventSource，自动重连，仅用于无副作用广播）────────────────────

let eventsSource: EventSource | null = null;
let eventToken: string | null = null;

export function initSseEvents(token: string): void {
  if (eventToken === token && eventsSource?.readyState === EventSource.OPEN) return;
  closeSseEvents();
  eventToken = token;

  const url = new URL('/api/sse/events', window.location.origin);
  url.searchParams.set('token', token);
  eventsSource = new EventSource(url.toString());

  for (const eventType of ['connected', 'queue-updated', 'queue-appended', 'plan-updated']) {
    eventsSource.addEventListener(eventType, (e) => {
      notifyListeners(eventType, parseSseData((e as MessageEvent).data));
    });
  }
}

const listeners = new Set<SseEventHandler>();

export function addSseListener(handler: SseEventHandler): () => void {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

function notifyListeners(event: string, data: unknown): void {
  for (const h of listeners) h(event, data);
}

// ── Chat (fetch + ReadableStream，POST body → SSE stream) ─────────────────────

export type SseStreamEvent = { type: string; data: Record<string, unknown> };

export async function* streamChat(text: string): AsyncGenerator<SseStreamEvent> {
  yield* postSseStream('/api/sse/chat', { text });
}

export async function* streamSegue(input: {
  clientRequestId: string;
  from: { id: string; name?: string; artist?: string };
  to: { id: string; name?: string; artist?: string };
}): AsyncGenerator<SseStreamEvent> {
  yield* postSseStream('/api/sse/segue', input);
}

export async function* streamPickNext(): AsyncGenerator<SseStreamEvent> {
  yield* postSseStream('/api/sse/pick-next', {});
}

export async function cancelRecommend(jobId: string): Promise<void> {
  await postJson('/api/sse/chat/cancel', { jobId });
}

async function* postSseStream(path: string, body: unknown): AsyncGenerator<SseStreamEvent> {
  const token = getRequiredToken();
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) throw new Error(`SSE request failed: ${response.status}`);
  if (!response.body) throw new Error('SSE response body is empty');

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\n\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const parsed = parseSseFrame(frame);
      if (parsed) yield parsed;
    }
  }
  if (buffer.trim()) {
    const parsed = parseSseFrame(buffer);
    if (parsed) yield parsed;
  }
}

function parseSseFrame(frame: string): SseStreamEvent | null {
  let type = 'message';
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\n/)) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) type = line.slice(6).trimStart();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  const parsed = parseSseData(raw);
  return { type, data: typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : { raw: parsed } };
}

function parseSseData(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function postJson(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getRequiredToken()}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
}

function getRequiredToken(): string {
  const token = eventToken ?? localStorage.getItem('crossfadio_jwt');
  if (!token) throw new Error('Missing auth token');
  return token;
}

export function closeSseEvents(): void {
  eventsSource?.close();
  eventsSource = null;
  eventToken = null;
}
```

- [ ] **Step 2: 验证前端构建**

```bash
pnpm build:web
```

---

### Task 8: 前端视图迁移

**Files:**
- Modify: `src/renderer/views/Player/PlayerView.tsx`
- Modify: `src/renderer/components/player/ChatPanel.tsx`
- Modify: `src/renderer/components/player/RecommendOverlay.tsx`

- [ ] **Step 1: PlayerView — segue + DJ + queue 事件迁移**

将 `onWsMessage` 中的 segue/dj/queue 处理改为 SSE：

```typescript
// PlayerView.tsx — 替换 useEffect 中的 onWsMessage
import { initSseEvents, streamSegue, streamPickNext, addSseListener, closeSseEvents } from '@renderer/sse/client';
import { getStoredToken } from '@renderer/api';

useEffect(() => {
  const token = getStoredToken();
  if (!token) return;
  initSseEvents(token);

  // 持久事件：queue-updated, queue-appended
  const unsub = addSseListener((event, data) => {
    if (event === 'queue-updated') {
      // ... 现有 queue-updated 处理逻辑
    } else if (event === 'queue-appended') {
      // ... 现有 queue-appended 处理逻辑
    }
  });

  return () => {
    unsub();
    closeSseEvents();
  };
}, []);

// Segue 触发改为 POST stream；没有 EventSource 自动重连，所以不会重复触发副作用。
async function triggerSegue(from: SegueTrackInput, to: SegueTrackInput, clientRequestId: string) {
  for await (const { type, data } of streamSegue({
    clientRequestId,
    from: serializeSegueTrack(from),
    to: serializeSegueTrack(to)
  })) {
    if (type === 'segue.delta') {
      // ... 现有 segue.delta 处理
    } else if (type === 'segue.tts-ready') {
      // ... 现有 segue.tts-ready 处理
    } else if (type === 'segue.degraded' || type === 'segue.done') {
      break;
    }
  }
}

// DJ pick-next 触发改为：
async function triggerPickNext() {
  for await (const { type, data } of streamPickNext()) {
    if (type === 'dj.debug') {
      // ... 现有 dj.debug 处理
    } else if (type === 'queue-appended') {
      // ... 现有 queue-appended 处理
    } else if (type === 'dj.pick-next.done') {
      // ... 现有 dj.pick-next.done 处理
      break;
    }
  }
}
```

- [ ] **Step 2: ChatPanel — fetch + stream**

```typescript
// ChatPanel.tsx
import { streamChat } from '@renderer/sse/client';

async function handleSend(text: string) {
  setSending(true);
  try {
    for await (const { type, data } of streamChat(text)) {
      if (type === 'chat.delta') {
        setMessages(prev => { /* append delta */ });
      } else if (type === 'chat.done') {
        setMessages(prev => { /* finalize */ });
        break;
      }
    }
  } catch (err) {
    // error handling
  } finally {
    setSending(false);
  }
}
```

- [ ] **Step 3: RecommendOverlay — SSE 替代 WS**

推荐进度属于单次 chat POST stream 响应，`RecommendOverlay` 不再订阅全局 `onWsMessage`。把 `ChatPanel` 中收到的 `chat.recommend.started` / `chat.recommend.progress` 通过现有组件状态或轻量 zustand store 传给 `RecommendOverlay`；取消按钮调用 `cancelRecommend(jobId)`。

- [ ] **Step 4: 验证前端编译**

```bash
pnpm check
pnpm build:web
```

---

### Task 9: 清理 — 删除 WS 代码

**Files:**
- Delete: `src/server/http/ws.ts`
- Delete: `src/renderer/ws/client.ts`
- Modify: `src/server/http/index.ts` — 移除 WS 相关 import 和 setupWsServer
- Modify: `src/server/http/index.ts` — 从 `LocalServer` 返回类型和返回值中移除 `wsUrl`
- Modify: `src/server/http/routes/chat.ts` — 移除旧 WS handler（如果 SSE 版本已稳定）
- Modify: `AGENTS.md` / 项目说明文档 — 更新 WS 描述为 SSE

- [ ] **Step 1: 移除服务端 WS**

```typescript
// src/server/http/index.ts
// 删除: import { setupWsServer } from './ws.js';
// 删除: setupWsServer(server, { ... });
// 删除: 对 chat.ts createChatMessageHandler 的引用（如果已弃用）
// 删除: LocalServer.wsUrl 字段和 return { wsUrl }
```

- [ ] **Step 2: 移除前端 WS 客户端**

删除 `src/renderer/ws/client.ts`，清理所有 `import { ... } from '@renderer/ws/client'` 引用。

- [ ] **Step 3: 更新文档**

将项目说明里的 WebSocket 章节改为 SSE：客户端打开 `/api/sse/events` 持久接收队列/计划广播，chat/segue/pick-next 通过 POST stream 接收本次任务事件。

- [ ] **Step 4: 全量测试**

```bash
pnpm check
pnpm test
pnpm build
```

---

### Task 10: JWT 认证适配持久 EventSource

**Files:**
- Modify: `src/server/http/middleware/auth.ts` — 支持 query param token（仅用于无副作用的持久 EventSource）
- Modify: `src/renderer/sse/client.ts` — `/api/sse/events` URL 带上 token；所有一次性 POST stream 继续使用 Authorization header

- [ ] **Step 1: authMiddleware 支持 query token**

```typescript
// src/server/http/middleware/auth.ts — 在 Bearer header 检查前添加
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  // 先检查 query param（EventSource 用）
  let token = typeof req.query.token === 'string' ? req.query.token : null;
  
  // 再检查 Authorization header
  if (!token) {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      token = header.slice(7);
    }
  }

  if (!token) {
    res.status(401).json({ ok: false, error: 'unauthorized', message: '缺少认证令牌' });
    return;
  }
  // ... 后续逻辑不变
}
```

- [ ] **Step 2: 前端持久 EventSource URL 带 token**

```typescript
// src/renderer/sse/client.ts
const url = new URL('/api/sse/events', window.location.origin);
url.searchParams.set('token', eventToken!);
```

- [ ] **Step 3: 不要给有副作用的一次性任务使用 EventSource**

`/api/sse/chat`、`/api/sse/segue`、`/api/sse/pick-next` 均使用 `fetch(..., { method: 'POST', headers: { Authorization: 'Bearer ...' } })`，不要把 token 放进 URL，也不要使用 EventSource，避免浏览器自动重连重复触发任务。

---

## 执行顺序

1. Task 1: SSE 工具模块
2. Task 4: Chat 核心逻辑提取（先创建 `chat-sse-worker.ts`，避免 Task 2 import 未定义模块）
3. Task 10: JWT 认证适配持久 EventSource
4. Task 2: 持久 SSE 事件流 + Chat SSE
5. Task 3: Segue SSE
6. Task 5: DJ Pick-Next SSE
7. Task 6: Broadcast 适配 SSE
8. Task 7: 前端 SSE 客户端
9. Task 8: 前端视图迁移
10. Task 9: 清理 WS 代码

每个 Task 结束后运行 `pnpm check && pnpm test`，前端 Task 额外运行 `pnpm build:web`。
