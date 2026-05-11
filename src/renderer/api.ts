import {
  ncmQrStatusSchema,
  likedQueueResponseSchema,
  nextTrackResponseSchema,
  nowPlayingResponseSchema,
  type LikedQueueResponse,
  type NextTrackResponse,
  type NowPlayingResponse
} from '@shared/schema';

type RuntimeConfig = {
  baseUrl: string;
};

type RuntimeInfo = {
  ok: boolean;
};

// ── JWT storage ────────────────────────────────────────────────────────────────

const JWT_KEY = 'crossfadio_jwt';

export function getStoredToken(): string | null {
  return localStorage.getItem(JWT_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(JWT_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(JWT_KEY);
}

type NcmQrPayload = {
  key: string;
  qrimg: string;
  qrurl: string;
};

type NcmSession = {
  ok: boolean;
  hasCookie: boolean;
  profile: unknown | null;
};

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const runtime = resolveRuntimeConfig();
  const token = getStoredToken();

  let response: Response;
  try {
    response = await fetch(new URL(path, runtime.baseUrl), {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {})
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown network error';
    throw new Error(`请求 ${path} 失败（baseUrl=${runtime.baseUrl}）：${message}`);
  }

  const json = await parseJsonResponse(response, path);

  if (!response.ok) {
    const message = typeof json?.message === 'string'
      ? json.message
      : typeof json?.error === 'string'
        ? json.error
        : `Request failed: ${path}`;
    throw new Error(message);
  }

  if (!json || typeof json !== 'object') {
    throw new Error(`接口 ${path} 返回了空响应或非 JSON 对象。`);
  }

  return json as T;
}

export async function getNcmSession(): Promise<NcmSession> {
  return requestJson<NcmSession>('/api/ncm/login/session');
}

export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  return requestJson<RuntimeInfo>('/api/runtime');
}

export async function createNcmQr(): Promise<NcmQrPayload> {
  return requestJson<NcmQrPayload>('/api/ncm/login/qr');
}

export async function checkNcmQr(key: string) {
  const payload = await requestJson<unknown>(`/api/ncm/login/status?key=${encodeURIComponent(key)}`);
  const result = ncmQrStatusSchema.parse(payload);
  if (result.hint === 'authorized' && result.token) {
    storeToken(result.token);
  }
  return result;
}

export async function logoutNcm(): Promise<void> {
  const payload = await requestJson<{ ok?: boolean }>('/api/ncm/login/logout', { method: 'POST' });
  clearToken();
  if (!payload.ok) {
    throw new Error('logout failed');
  }
}

export async function getNowPlaying(
  ncmId: string,
  meta?: { name?: string; artist?: string }
): Promise<NowPlayingResponse> {
  let query = `ncmId=${encodeURIComponent(ncmId)}`;
  if (meta?.name) query += `&name=${encodeURIComponent(meta.name)}`;
  if (meta?.artist) query += `&artist=${encodeURIComponent(meta.artist)}`;
  const payload = await requestJson<unknown>(`/api/now?${query}`);
  return nowPlayingResponseSchema.parse(payload);
}

export async function getNextTrack(queueIds: string[], currentId: string): Promise<NextTrackResponse> {
  const query = `queue=${encodeURIComponent(queueIds.join(','))}&current=${encodeURIComponent(currentId)}`;
  const payload = await requestJson<unknown>(`/api/next?${query}`);
  return nextTrackResponseSchema.parse(payload);
}

export async function getLikedQueue(limit = 100): Promise<LikedQueueResponse> {
  const payload = await requestJson<unknown>(`/api/queue/liked?limit=${encodeURIComponent(String(limit))}`);
  return likedQueueResponseSchema.parse(payload);
}

export async function getLikedTrackIds(): Promise<string[]> {
  const payload = await requestJson<{ ok: boolean; ids: string[] }>('/api/queue/liked/ids');
  return payload.ids ?? [];
}

export async function toggleLikeTrack(id: string, like: boolean): Promise<void> {
  const result = await requestJson<{ ok: boolean }>('/api/queue/like', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, like })
  });
  if (!result.ok) throw new Error('Failed to toggle like');
}

export async function saveQueueState(
  queue: Array<string | { id: string; name?: string; artists?: string[]; durationMs?: number }>,
  currentIndex: number
): Promise<void> {
  const result = await requestJson<{ ok: boolean }>('/api/queue/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queue, currentIndex })
  });
  if (!result.ok) throw new Error('Failed to save queue state');
}

export async function pickNextTrack(
  queue: Array<{ id: string; name?: string; artists?: string[]; durationMs?: number }> = [],
  currentIndex = 0
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>('/api/dj/pick-next', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queue, currentIndex })
  });
}

export async function updateLocation(lat: number, lon: number): Promise<void> {
  await requestJson<{ ok: boolean }>('/api/location', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lon })
  });
}

export type RecentMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export async function getRecentChatMessages(limit = 50): Promise<RecentMessage[]> {
  const payload = await requestJson<{ ok: boolean; messages: RecentMessage[] }>(
    `/api/messages/recent?limit=${encodeURIComponent(String(limit))}`
  );
  return payload.messages ?? [];
}

export type SegueTrackInput = {
  id: string;
  name?: string;
  artists?: string[];
};

export async function triggerSegue(
  from: SegueTrackInput,
  to: SegueTrackInput,
  clientRequestId: string
): Promise<{ ok: boolean; requestId: string; clientRequestId: string }> {
  return requestJson<{ ok: boolean; requestId: string; clientRequestId: string }>(
    '/api/segue/trigger',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientRequestId,
        from: serializeSegueTrack(from),
        to: serializeSegueTrack(to)
      })
    }
  );
}

function serializeSegueTrack(track: SegueTrackInput): { id: string; name?: string; artist?: string } {
  const payload: { id: string; name?: string; artist?: string } = { id: track.id };
  if (track.name) payload.name = track.name;
  if (track.artists && track.artists.length > 0) {
    payload.artist = track.artists.join(' / ');
  }
  return payload;
}

export type LlmSettings = {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
};

export type TtsSettings = {
  baseUrl: string;
  hasApiKey: boolean;
  voice: string;
  voiceDefault: string | null;
};

export type SettingsResponse = {
  ok: boolean;
  llm: LlmSettings;
  tts: TtsSettings;
  dailyThemeEnabled: boolean;
};

export type SaveSettingsPayload = {
  tts?: { voice: string };
  dailyThemeEnabled?: boolean;
};

export async function getSettings(): Promise<SettingsResponse> {
  return requestJson<SettingsResponse>('/api/settings');
}

export async function saveSettings(payload: SaveSettingsPayload): Promise<void> {
  const result = await requestJson<{ ok: boolean }>('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!result.ok) throw new Error('Failed to save settings');
}

export async function analyzeTaste(): Promise<{ ok: boolean; taste: string; message?: string }> {
  return requestJson<{ ok: boolean; taste: string; message?: string }>('/api/settings/analyze-taste', { method: 'POST' });
}

export type PlayerContextResponse = {
  ok: boolean;
  theme: { theme: string; keywords: string[] } | null;
  taste: string;
};

export async function getPlayerContext(): Promise<PlayerContextResponse> {
  return requestJson<PlayerContextResponse>('/api/settings/player-context');
}


// ── Whitelist ───────────────────────────────────────────────────────────────────

export type BlockedAttempt = {
  id: number;
  ncm_id: string;
  profile_json: string | null;
  attempted_at: string;
};

export async function getWhitelist(): Promise<{ ok: boolean; entries: string[] }> {
  return requestJson<{ ok: boolean; entries: string[] }>('/api/whitelist');
}

export async function getBlockedAttempts(): Promise<{ ok: boolean; blocked: BlockedAttempt[] }> {
  return requestJson<{ ok: boolean; blocked: BlockedAttempt[] }>('/api/whitelist/blocked');
}

export async function addToWhitelist(ncmId: string): Promise<void> {
  const result = await requestJson<{ ok: boolean }>('/api/whitelist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ncmId })
  });
  if (!result.ok) throw new Error('Failed to add to whitelist');
}

export async function removeFromWhitelist(ncmId: string): Promise<void> {
  const result = await requestJson<{ ok: boolean }>(
    `/api/whitelist/${encodeURIComponent(ncmId)}`,
    { method: 'DELETE' }
  );
  if (!result.ok) throw new Error('Failed to remove from whitelist');
}

export async function unblockUser(id: number): Promise<{ ok: boolean; ncmId: string }> {
  return requestJson<{ ok: boolean; ncmId: string }>(
    `/api/whitelist/unblock/${encodeURIComponent(String(id))}`,
    { method: 'POST' }
  );
}

export type PlanTrack = {
  query: string;
  reason?: string;
};

export type PlanSegment = {
  id: string;
  label: string;
  timeRange: string;
  mood: string;
  energyPct: number;
  tracks: PlanTrack[];
};

export type PlanOutput = {
  mode: 'plan';
  date: string;
  segments: PlanSegment[];
  narrative?: string;
};

export type PlanResponse = {
  ok: boolean;
  plan: PlanOutput;
};

export async function getTodayPlan(): Promise<PlanResponse> {
  return requestJson<PlanResponse>('/api/plan/today');
}

export async function regeneratePlan(): Promise<PlanResponse> {
  return requestJson<PlanResponse>('/api/plan/regenerate', { method: 'POST' });
}

export async function replanSegment(segmentId: string): Promise<PlanResponse> {
  return requestJson<PlanResponse>('/api/plan/replan-segment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segmentId })
  });
}

function resolveRuntimeConfig(): RuntimeConfig {
  const baseUrl = window.location.origin.replace(/\/+$/, '');
  return { baseUrl };
}

async function parseJsonResponse(response: Response, path: string): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? 'unknown';
  const raw = await response.text();
  return parseJsonRaw(raw, contentType, path);
}

function parseJsonRaw(raw: string, contentType: string, path: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return (parsed ?? {}) as Record<string, unknown>;
  } catch {
    const normalized = raw.trimStart().toLowerCase();
    if (normalized.startsWith('<!doctype') || normalized.startsWith('<html')) {
      throw new Error(
        `接口 ${path} 返回了 HTML 而非 JSON（content-type: ${contentType}）。通常是 API baseUrl 未正确注入。`
      );
    }

    throw new Error(
      `接口 ${path} 返回了非 JSON 响应（content-type: ${contentType}，preview: ${previewRaw(raw)}）。`
    );
  }
}

function previewRaw(raw: string): string {
  return raw.replace(/\s+/g, ' ').slice(0, 80);
}
