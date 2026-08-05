import {
  ncmQrStatusSchema,
  likedQueueResponseSchema,
  nextTrackResponseSchema,
  nowPlayingResponseSchema,
  queueTrackSchema,
  type LikedQueueResponse,
  type NextTrackResponse,
  type NowPlayingResponse,
  type QueueTrackDto
} from '@shared/schema';
import type { AutoFillBatchSize, DiscoveryMode } from '@shared/dj';
import type {
  ListeningEpisodeCheckpoint,
  ListeningEpisodeCreate,
  ListeningEpisodeFinalize,
  ListeningEpisodeKeepaliveCheckpoint
} from '@shared/listening';
import {
  selectionJourneySnapshotSchema,
  type SelectionJourneySnapshot
} from '@shared/selection';

type RuntimeConfig = {
  baseUrl: string;
};

type RuntimeInfo = {
  ok: boolean;
};

type RequestJsonOptions = {
  authToken?: string;
};

type GetNowPlayingOptions = RequestJsonOptions & {
  freshStream?: boolean;
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

async function requestJson<T>(
  path: string,
  init?: RequestInit,
  requestOptions?: RequestJsonOptions
): Promise<T> {
  const runtime = resolveRuntimeConfig();
  const token = requestOptions?.authToken ?? getStoredToken();

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
    throw new HttpJsonError(response.status, message, json);
  }

  if (!json || typeof json !== 'object') {
    throw new Error(`接口 ${path} 返回了空响应或非 JSON 对象。`);
  }

  return json as T;
}

class HttpJsonError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly payload: Record<string, unknown> | null
  ) {
    super(message);
  }
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
  requestOptions?: GetNowPlayingOptions
): Promise<NowPlayingResponse> {
  const query = `ncmId=${encodeURIComponent(ncmId)}${requestOptions?.freshStream ? '&fresh=1' : ''}`;
  const init = requestOptions?.freshStream ? { cache: 'no-store' as const } : undefined;
  const payload = await requestJson<unknown>(`/api/now?${query}`, init, requestOptions);
  return nowPlayingResponseSchema.parse(payload);
}

export async function putListeningEpisode(
  clientEpisodeId: string,
  input: ListeningEpisodeCreate,
  options?: { keepalive?: boolean; authToken?: string }
): Promise<void> {
  await requestJson(`/api/listening-episodes/${encodeURIComponent(clientEpisodeId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    keepalive: options?.keepalive
  }, { authToken: options?.authToken });
}

export async function patchListeningEpisode(
  clientEpisodeId: string,
  input: ListeningEpisodeCheckpoint | ListeningEpisodeFinalize,
  options?: { keepalive?: boolean; authToken?: string }
): Promise<void> {
  await requestJson(`/api/listening-episodes/${encodeURIComponent(clientEpisodeId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    keepalive: options?.keepalive
  }, { authToken: options?.authToken });
}

export async function patchListeningEpisodeKeepalive(
  clientEpisodeId: string,
  input: ListeningEpisodeKeepaliveCheckpoint,
  options?: { authToken?: string }
): Promise<void> {
  await requestJson(`/api/listening-episodes/${encodeURIComponent(clientEpisodeId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    keepalive: true
  }, { authToken: options?.authToken });
}

export async function getNextTrack(
  queueIds: string[],
  currentId: string,
  requestOptions?: RequestJsonOptions
): Promise<NextTrackResponse> {
  const query = `queue=${encodeURIComponent(queueIds.join(','))}&current=${encodeURIComponent(currentId)}`;
  const payload = await requestJson<unknown>(`/api/next?${query}`, undefined, requestOptions);
  return nextTrackResponseSchema.parse(payload);
}

export async function getLikedQueue(
  limit = 100,
  requestOptions?: RequestJsonOptions
): Promise<LikedQueueResponse> {
  const payload = await requestJson<unknown>(
    `/api/queue/liked?limit=${encodeURIComponent(String(limit))}`,
    undefined,
    requestOptions
  );
  return likedQueueResponseSchema.parse(payload);
}

export async function getLikedTrackIds(requestOptions?: RequestJsonOptions): Promise<string[]> {
  const payload = await requestJson<{ ok: boolean; ids: string[] }>(
    '/api/queue/liked/ids',
    undefined,
    requestOptions
  );
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
  queue: Array<string | { id: string; name?: string; artists?: string[]; durationMs?: number; coverImgUrl?: string | null }>,
  currentIndex: number,
  temporaryBanTracks: Array<{ id: string; name?: string; artists?: string[] }>,
  revision: number,
  mutationId: string,
  options?: RequestJsonOptions
): Promise<QueueStateSaveResult> {
  const body = JSON.stringify({ queue, currentIndex, temporaryBanTracks, revision, mutationId });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await requestJson<{
        ok: boolean;
        queue: unknown;
        currentIndex: unknown;
        revision: unknown;
      }>('/api/queue/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body
      }, options);
      if (!result.ok) throw new Error('Failed to save queue state');
      const authoritativeQueue = queueTrackSchema.array().safeParse(result.queue);
      const authoritativeRevision = Number(result.revision);
      const authoritativeIndex = Number(result.currentIndex);
      if (!authoritativeQueue.success || !Number.isInteger(authoritativeRevision) || authoritativeRevision < 0
        || !Number.isInteger(authoritativeIndex) || authoritativeIndex < 0) {
        throw new Error('Queue save returned an invalid authoritative snapshot');
      }
      return {
        ok: true,
        queue: authoritativeQueue.data,
        currentIndex: authoritativeIndex,
        revision: authoritativeRevision
      };
    } catch (error) {
      if (error instanceof HttpJsonError) {
        if (error.status !== 409 || !error.payload) throw error;
        const authoritativeQueue = queueTrackSchema.array().safeParse(error.payload.queue);
        const authoritativeRevision = Number(error.payload.revision);
        const authoritativeIndex = Number(error.payload.currentIndex);
        if (!authoritativeQueue.success || !Number.isInteger(authoritativeRevision) || authoritativeRevision < 0
          || !Number.isInteger(authoritativeIndex) || authoritativeIndex < 0) throw error;
        return {
          ok: false,
          error: 'queue_revision_conflict',
          queue: authoritativeQueue.data,
          currentIndex: authoritativeIndex,
          revision: authoritativeRevision
        };
      }
      if (attempt === 1) throw error;
    }
  }
  throw new Error('Queue state retry exhausted');
}

export type QueueStateSaveResult =
  | {
      ok: true;
      queue: QueueTrackDto[];
      currentIndex: number;
      revision: number;
    }
  | {
      ok: false;
      error: 'queue_revision_conflict';
      queue: QueueTrackDto[];
      currentIndex: number;
      revision: number;
    };

export async function pickNextTrack(
  queue: Array<{ id: string; name?: string; artists?: string[]; durationMs?: number; coverImgUrl?: string | null }>,
  currentIndex: number,
  revision: number
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>('/api/dj/pick-next', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queue, currentIndex, revision })
  });
}

export async function getSelectionJourneyHistory(
  limit = 20,
  requestOptions?: RequestJsonOptions
): Promise<SelectionJourneySnapshot[]> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
  const payload = await requestJson<{ ok: boolean; journeys: unknown[] }>(
    `/api/dj/selection-journeys?limit=${encodeURIComponent(String(safeLimit))}`,
    undefined,
    requestOptions
  );
  return selectionJourneySnapshotSchema.array().parse(payload.journeys ?? []);
}

export async function updateLocation(
  lat: number,
  lon: number,
  requestOptions?: RequestJsonOptions
): Promise<void> {
  await requestJson<{ ok: boolean }>('/api/location', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lon })
  }, requestOptions);
}

export type RecentMessage = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

export async function getRecentChatMessages(
  limit = 50,
  requestOptions?: RequestJsonOptions
): Promise<RecentMessage[]> {
  const payload = await requestJson<{ ok: boolean; messages: RecentMessage[] }>(
    `/api/messages/recent?limit=${encodeURIComponent(String(limit))}`,
    undefined,
    requestOptions
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
  thinkingEnabled: boolean;
  thinkingSupported: boolean;
};

export type TtsSettings = {
  provider: 'aliyun-qwen' | 'openai-compatible' | 'tencent-cloud';
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  voice: string;
  voiceDefault: string | null;
};

export type SettingsResponse = {
  ok: boolean;
  llm: LlmSettings;
  tts: TtsSettings;
  dailyThemeEnabled: boolean;
  discoveryMode: DiscoveryMode;
  autoFillBatchSize: AutoFillBatchSize;
};

export type SaveSettingsPayload = {
  llm?: { thinkingEnabled: boolean };
  tts?: { voice: string };
  dailyThemeEnabled?: boolean;
  discoveryMode?: DiscoveryMode;
  autoFillBatchSize?: AutoFillBatchSize;
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

export type TtsPreviewResponse = {
  ok: boolean;
  audioUrl: string;
  cached: boolean;
  voice: string;
  model: string;
};

export async function previewTtsVoice(voice: string): Promise<TtsPreviewResponse> {
  const result = await requestJson<TtsPreviewResponse>('/api/settings/tts-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice })
  });
  if (!result.ok) throw new Error('Failed to generate TTS preview');
  return result;
}

export async function analyzeTaste(): Promise<{ ok: boolean; taste: string; message?: string }> {
  return requestJson<{ ok: boolean; taste: string; message?: string }>('/api/settings/analyze-taste', { method: 'POST' });
}

export type PlayerContextResponse = {
  ok: boolean;
  theme: { theme: string; keywords: string[] } | null;
  weather: { location: string; tempC: number; desc: string } | null;
  taste: string;
  discoveryMode: DiscoveryMode;
};

export async function getPlayerContext(requestOptions?: RequestJsonOptions): Promise<PlayerContextResponse> {
  return requestJson<PlayerContextResponse>('/api/settings/player-context', undefined, requestOptions);
}

// ── Personal DJ Context ────────────────────────────────────────────────────────

export type PersonalDjContextStatusRecord = {
  id: string;
  generatedAt: string;
  uploadedAt: string;
  summary: string;
  sourceKind: string;
  sourceBundleId: string | null;
  sliceCount: number;
  musicHintCount: number;
  revokedAt: string | null;
};

export type PersonalDjContextStatusResponse = {
  ok: boolean;
  current: PersonalDjContextStatusRecord | null;
  latest: PersonalDjContextStatusRecord | null;
  currentActive: boolean;
  trendCount: number;
  retainedRecordCount: number;
};

export type PersonalDjContextToken = {
  id: string;
  name: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type CreatedPersonalDjContextToken = PersonalDjContextToken & {
  token: string;
};

export async function getPersonalDjContextStatus(): Promise<PersonalDjContextStatusResponse> {
  return requestJson<PersonalDjContextStatusResponse>('/api/settings/personal-dj-context');
}

export async function revokeCurrentPersonalDjContext(): Promise<{ ok: boolean; revoked: boolean }> {
  return requestJson<{ ok: boolean; revoked: boolean }>('/api/settings/personal-dj-context/revoke-current', {
    method: 'POST'
  });
}

export async function listPersonalDjContextTokens(): Promise<{ ok: boolean; tokens: PersonalDjContextToken[] }> {
  return requestJson<{ ok: boolean; tokens: PersonalDjContextToken[] }>('/api/settings/personal-dj-context/tokens');
}

export async function createPersonalDjContextToken(name?: string): Promise<{ ok: boolean; token: CreatedPersonalDjContextToken }> {
  return requestJson<{ ok: boolean; token: CreatedPersonalDjContextToken }>('/api/settings/personal-dj-context/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(name?.trim() ? { name: name.trim() } : {})
  });
}

export async function revokePersonalDjContextToken(id: string): Promise<{ ok: boolean; revoked: boolean }> {
  return requestJson<{ ok: boolean; revoked: boolean }>(
    `/api/settings/personal-dj-context/tokens/${encodeURIComponent(id)}`,
    { method: 'DELETE' }
  );
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
