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

  for (const eventType of ['connected', 'queue-updated', 'queue-appended']) {
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

export async function* streamPickNext(input: {
  queue: Array<{ id: string; name?: string; artists?: string[]; durationMs?: number; coverImgUrl?: string | null }>;
  currentIndex: number;
}): AsyncGenerator<SseStreamEvent> {
  yield* postSseStream('/api/sse/pick-next', input);
}

export async function cancelRecommend(jobId: string): Promise<void> {
  await postJson('/api/sse/chat/cancel', { jobId });
}

async function* postSseStream(path: string, body: unknown): AsyncGenerator<SseStreamEvent> {
  const token = getRequiredToken();
  const serializedBody = JSON.stringify(body);
  const response = await fetchSseWithRetry(path, token, serializedBody);

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

async function fetchSseWithRetry(path: string, token: string, body: string): Promise<Response> {
  const maxAttempts = path === '/api/sse/segue' ? 3 : 1;
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body
    });
    if (response.ok || !isRetryableSseStatus(response.status) || attempt === maxAttempts) {
      return response;
    }
    lastResponse = response;
  }

  return lastResponse ?? new Response(null, { status: 599 });
}

function isRetryableSseStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
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
