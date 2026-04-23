import {
  ncmQrStatusSchema,
  nextTrackResponseSchema,
  nowPlayingResponseSchema,
  type NextTrackResponse,
  type NowPlayingResponse
} from '@shared/schema';

type RuntimeConfig = {
  baseUrl: string;
};

const runtime: RuntimeConfig = resolveRuntimeConfig();

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
  if (!runtime.baseUrl) {
    throw new Error(
      `本地 API 地址未注入，无法请求 ${path}。请关闭并重启应用后重试（当前 baseUrl 为空）。`
    );
  }

  const response = await fetch(new URL(path, runtime.baseUrl), {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.headers ?? {})
    }
  });

  const json = await parseJsonResponse(response, path);

  if (!response.ok) {
    const message = typeof json?.message === 'string' ? json.message : `Request failed: ${path}`;
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

export async function createNcmQr(): Promise<NcmQrPayload> {
  return requestJson<NcmQrPayload>('/api/ncm/login/qr');
}

export async function checkNcmQr(key: string) {
  const payload = await requestJson<unknown>(`/api/ncm/login/status?key=${encodeURIComponent(key)}`);
  return ncmQrStatusSchema.parse(payload);
}

export async function logoutNcm(): Promise<void> {
  const payload = await requestJson<{ ok?: boolean }>('/api/ncm/login/logout', { method: 'POST' });
  if (!payload.ok) {
    throw new Error('logout failed');
  }
}

export async function getNowPlaying(ncmId: string): Promise<NowPlayingResponse> {
  const payload = await requestJson<unknown>(`/api/now?ncmId=${encodeURIComponent(ncmId)}`);
  return nowPlayingResponseSchema.parse(payload);
}

export async function getNextTrack(queueIds: string[], currentId: string): Promise<NextTrackResponse> {
  const query = `queue=${encodeURIComponent(queueIds.join(','))}&current=${encodeURIComponent(currentId)}`;
  const payload = await requestJson<unknown>(`/api/next?${query}`);
  return nextTrackResponseSchema.parse(payload);
}

function resolveRuntimeConfig(): RuntimeConfig {
  const raw = window.crossfadio?.getRuntimeConfig?.();
  const baseUrl = typeof raw?.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : '';
  return { baseUrl };
}

async function parseJsonResponse(response: Response, path: string): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type') ?? 'unknown';
  const raw = await response.text();

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
