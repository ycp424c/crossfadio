import {
  NCM_ERROR_CODE,
  ncmLyricResponseSchema,
  ncmPlaylistDetailResponseSchema,
  ncmSearchResponseSchema,
  ncmSongUrlResponseSchema,
  type NcmErrorCode,
  type NcmLyric,
  type NcmPlaylistDetail,
  type NcmSong,
  type NcmSongUrl
} from '../../shared/schema.js';

type NcmClientOptions = {
  getCookie?: () => string | null;
  fetchTimeoutMs?: number;
};

export type NcmQrPayload = {
  key: string;
  qrimg: string;
  qrurl: string;
};

export type NcmQrCheckResult = {
  code: number;
  message: string;
  cookie: string | null;
};

export class NcmApiError extends Error {
  readonly code: NcmErrorCode;
  readonly cause?: unknown;

  constructor(code: NcmErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'NcmApiError';
    this.code = code;
    this.cause = cause;
  }
}

export class NcmClient {
  private readonly getCookie: (() => string | null) | undefined;
  private readonly fetchTimeoutMs: number;

  constructor(private readonly baseUrl: string, options?: NcmClientOptions) {
    this.getCookie = options?.getCookie;
    this.fetchTimeoutMs = options?.fetchTimeoutMs ?? 8_000;
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.rawFetch('/', {});
      return response.ok;
    } catch {
      return false;
    }
  }

  async createLoginQr(): Promise<NcmQrPayload> {
    const keyJson = await this.getJson('/login/qr/key', {
      timestamp: String(Date.now())
    });
    const key = keyJson?.data?.unikey;

    if (typeof key !== 'string' || key.length === 0) {
      throw new NcmApiError(NCM_ERROR_CODE.BAD_RESPONSE, 'NCM did not return valid qr key');
    }

    const qrJson = await this.getJson('/login/qr/create', {
      key,
      qrimg: 'true',
      timestamp: String(Date.now())
    });

    const qrimg = qrJson?.data?.qrimg;
    const qrurl = qrJson?.data?.qrurl;

    if (typeof qrimg !== 'string' || typeof qrurl !== 'string') {
      throw new NcmApiError(NCM_ERROR_CODE.BAD_RESPONSE, 'NCM did not return qr image payload');
    }

    return {
      key,
      qrimg,
      qrurl
    };
  }

  async checkLoginQr(key: string): Promise<NcmQrCheckResult> {
    const json = await this.getJson('/login/qr/check', {
      key,
      timestamp: String(Date.now())
    });

    const code = Number(json?.code ?? -1);
    if (!Number.isFinite(code)) {
      throw new NcmApiError(NCM_ERROR_CODE.BAD_RESPONSE, 'NCM qr check missing numeric code');
    }

    return {
      code,
      message: String(json?.message ?? ''),
      cookie: typeof json?.cookie === 'string' ? json.cookie : null
    };
  }

  async getLoginStatus(): Promise<unknown> {
    return this.getJson('/login/status', {
      timestamp: String(Date.now())
    });
  }

  async logout(): Promise<void> {
    await this.getJson('/logout', {
      timestamp: String(Date.now())
    });
  }

  async searchSongs(keywords: string, limit = 20): Promise<NcmSong[]> {
    const json = await this.getJson('/cloudsearch', {
      keywords,
      type: '1',
      limit: String(limit)
    });

    const parsed = ncmSearchResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new NcmApiError(
        NCM_ERROR_CODE.BAD_RESPONSE,
        `NCM search returned malformed payload: ${parsed.error.message}`
      );
    }

    const songs = parsed.data.result?.songs ?? [];
    return songs.map((song) => ({
      id: song.id,
      name: song.name,
      artists: (song.ar ?? [])
        .map((artist) => artist.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
    }));
  }

  async getSongUrl(id: string): Promise<NcmSongUrl | null> {
    const json = await this.getJson('/song/url/v1', {
      id,
      level: 'exhigh'
    });

    const parsed = ncmSongUrlResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new NcmApiError(
        NCM_ERROR_CODE.BAD_RESPONSE,
        `NCM song/url returned malformed payload: ${parsed.error.message}`
      );
    }

    const first = parsed.data.data?.[0];
    if (!first) {
      return null;
    }

    return {
      id: first.id,
      url: first.url ?? null,
      br: first.br ?? null,
      size: first.size ?? null,
      type: first.type ?? null,
      expireAt: first.expi ?? null
    };
  }

  async getLyric(id: string): Promise<NcmLyric | null> {
    const json = await this.getJson('/lyric', { id });
    const parsed = ncmLyricResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new NcmApiError(
        NCM_ERROR_CODE.BAD_RESPONSE,
        `NCM lyric returned malformed payload: ${parsed.error.message}`
      );
    }

    const lyric = parsed.data.lrc?.lyric;
    if (typeof lyric !== 'string' || lyric.length === 0) {
      return null;
    }

    const translation = parsed.data.tlyric?.lyric;
    return {
      id,
      lyric,
      translation: typeof translation === 'string' && translation.length > 0 ? translation : null
    };
  }

  async getPlaylistDetail(id: string): Promise<NcmPlaylistDetail | null> {
    const json = await this.getJson('/playlist/detail', { id });
    const parsed = ncmPlaylistDetailResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new NcmApiError(
        NCM_ERROR_CODE.BAD_RESPONSE,
        `NCM playlist/detail returned malformed payload: ${parsed.error.message}`
      );
    }

    const playlist = parsed.data.playlist;
    if (!playlist) {
      return null;
    }

    const tracks = playlist.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      artists: (track.ar ?? [])
        .map((artist) => artist.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0),
      durationMs: typeof track.dt === 'number' ? track.dt : 0
    }));

    return {
      id: playlist.id,
      name: playlist.name,
      coverImgUrl: playlist.coverImgUrl ?? null,
      trackCount: typeof playlist.trackCount === 'number' ? playlist.trackCount : tracks.length,
      tracks
    };
  }

  private async getJson(path: string, query: Record<string, string>): Promise<any> {
    const response = await this.rawFetch(path, query);

    if (!response.ok) {
      throw classifyHttpError(path, response.status);
    }

    try {
      return await response.json();
    } catch (error) {
      throw new NcmApiError(NCM_ERROR_CODE.BAD_RESPONSE, `NCM returned non-JSON from ${path}`, error);
    }
  }

  private async rawFetch(path: string, query: Record<string, string>): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    Object.entries(query).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    const cookie = this.getCookie?.();
    if (cookie && !url.searchParams.has('cookie')) {
      url.searchParams.set('cookie', cookie);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

    try {
      return await fetch(url, { method: 'GET', signal: controller.signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw new NcmApiError(NCM_ERROR_CODE.TIMEOUT, `NCM request timed out: ${path}`, error);
      }
      throw new NcmApiError(NCM_ERROR_CODE.UNAVAILABLE, `NCM request failed: ${path}`, error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function classifyHttpError(path: string, status: number): NcmApiError {
  if (status === 301 || status === 401) {
    return new NcmApiError(
      NCM_ERROR_CODE.COOKIE_EXPIRED,
      `NCM authorization expired on ${path} (${status})`
    );
  }
  if (status === 429) {
    return new NcmApiError(NCM_ERROR_CODE.RATE_LIMITED, `NCM rate limited on ${path}`);
  }
  if (status >= 500) {
    return new NcmApiError(NCM_ERROR_CODE.UNAVAILABLE, `NCM upstream error on ${path} (${status})`);
  }
  return new NcmApiError(NCM_ERROR_CODE.UNKNOWN, `NCM request failed: ${path} (${status})`);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}
