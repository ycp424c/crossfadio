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

const runtime: RuntimeConfig = window.crossfadio?.getRuntimeConfig() ?? { baseUrl: '' };

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

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(`${runtime.baseUrl}${path}`);
  const json = await response.json();
  if (!response.ok) {
    const message = typeof json?.message === 'string' ? json.message : `Request failed: ${path}`;
    throw new Error(message);
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
  const response = await fetch(`${runtime.baseUrl}/api/ncm/login/logout`, { method: 'POST' });
  if (!response.ok) {
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
