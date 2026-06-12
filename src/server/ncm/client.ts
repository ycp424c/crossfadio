import {
  NCM_ERROR_CODE,
  ncmLyricResponseSchema,
  ncmLikedIdsResponseSchema,
  ncmPlaylistDetailResponseSchema,
  ncmSearchResponseSchema,
  ncmSongDetailResponseSchema,
  ncmSongUrlResponseSchema,
  type NcmErrorCode,
  type NcmLyric,
  type NcmPlaylistDetail,
  type NcmSong,
  type NcmSongUrl,
  type NcmTrackQualitySignals
} from '../../shared/schema.js';
import { getLogger } from '../logger.js';

type NcmClientOptions = {
  getCookie?: () => string | null;
  fetchTimeoutMs?: number;
  songUrlQualityCache?: NcmSongUrlQualityCache;
};

export const NCM_SONG_URL_QUALITY_LEVELS = [
  'jymaster',
  'sky',
  'jyeffect',
  'hires',
  'lossless',
  'exhigh',
  'higher',
  'standard'
] as const;

export const NCM_SONG_URL_QUALITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type NcmSongUrlQualityLevel = (typeof NCM_SONG_URL_QUALITY_LEVELS)[number];
export type NcmSongUrlQualityCache = Map<
  string,
  { level: NcmSongUrlQualityLevel; cachedAtMs: number }
>;

type GetSongUrlOptions = {
  qualityCacheKey?: string;
  nowMs?: number;
};

const defaultSongUrlQualityCache: NcmSongUrlQualityCache = new Map();

type NcmSearchHotItem = {
  searchWord?: unknown;
  content?: unknown;
};

type NcmArtistItem = {
  name?: unknown;
};

type NcmTopSongItem = {
  name?: unknown;
  ar?: NcmArtistItem[];
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
  private readonly songUrlQualityCache: NcmSongUrlQualityCache;

  constructor(private readonly baseUrl: string, options?: NcmClientOptions) {
    this.getCookie = options?.getCookie;
    this.fetchTimeoutMs = options?.fetchTimeoutMs ?? 8_000;
    this.songUrlQualityCache = options?.songUrlQualityCache ?? defaultSongUrlQualityCache;
  }

  withCookie(cookie: string): NcmClient {
    return new NcmClient(this.baseUrl, {
      fetchTimeoutMs: this.fetchTimeoutMs,
      getCookie: () => cookie,
      songUrlQualityCache: this.songUrlQualityCache
    });
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

  async getSongUrl(id: string, options: GetSongUrlOptions = {}): Promise<NcmSongUrl | null> {
    const nowMs = options.nowMs ?? Date.now();
    const deadlineAtMs = Date.now() + this.fetchTimeoutMs;
    const levels = this.getSongUrlQualityLevels(options.qualityCacheKey, nowMs);
    let lastFallbackError: NcmApiError | null = null;

    for (const level of levels) {
      try {
        const remainingMs = deadlineAtMs - Date.now();
        if (remainingMs <= 0) {
          throw new NcmApiError(
            NCM_ERROR_CODE.TIMEOUT,
            `NCM song url quality fallback timed out for ncmId=${id}`
          );
        }

        const songUrl = await this.getSongUrlAtLevel(id, level, remainingMs);
        if (songUrl?.url) {
          this.setCachedSongUrlQuality(options.qualityCacheKey, level, nowMs);
          return songUrl;
        }
      } catch (error) {
        if (!isSongUrlQualityFallbackError(error)) {
          throw error;
        }
        if (error.code === NCM_ERROR_CODE.BAD_RESPONSE) {
          getLogger().warn(
            { err: error, id, level, code: error.code },
            'NCM song URL quality fallback after bad response'
          );
        }
        lastFallbackError = error;
      }
    }

    if (lastFallbackError) {
      throw lastFallbackError;
    }

    return null;
  }

  private async getSongUrlAtLevel(
    id: string,
    level: NcmSongUrlQualityLevel,
    timeoutMs?: number
  ): Promise<NcmSongUrl | null> {
    const json = await this.getJson('/song/url/v1', {
      id,
      level
    }, timeoutMs);

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

  private getSongUrlQualityLevels(
    qualityCacheKey: string | undefined,
    nowMs: number
  ): readonly NcmSongUrlQualityLevel[] {
    if (!qualityCacheKey) {
      return NCM_SONG_URL_QUALITY_LEVELS;
    }

    const cached = this.songUrlQualityCache.get(qualityCacheKey);
    if (!cached || nowMs - cached.cachedAtMs >= NCM_SONG_URL_QUALITY_CACHE_TTL_MS) {
      this.songUrlQualityCache.delete(qualityCacheKey);
      return NCM_SONG_URL_QUALITY_LEVELS;
    }

    const cachedIndex = NCM_SONG_URL_QUALITY_LEVELS.indexOf(cached.level);
    if (cachedIndex === -1) {
      this.songUrlQualityCache.delete(qualityCacheKey);
      return NCM_SONG_URL_QUALITY_LEVELS;
    }

    return NCM_SONG_URL_QUALITY_LEVELS.slice(cachedIndex);
  }

  private setCachedSongUrlQuality(
    qualityCacheKey: string | undefined,
    level: NcmSongUrlQualityLevel,
    nowMs: number
  ): void {
    if (!qualityCacheKey) {
      return;
    }

    const cached = this.songUrlQualityCache.get(qualityCacheKey);
    if (cached?.level === level) {
      return;
    }

    this.songUrlQualityCache.set(qualityCacheKey, { level, cachedAtMs: nowMs });
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
      durationMs: typeof track.dt === 'number' ? track.dt : 0,
      ...(track.al?.picUrl ? { coverImgUrl: track.al.picUrl } : {})
    }));

    return {
      id: playlist.id,
      name: playlist.name,
      coverImgUrl: playlist.coverImgUrl ?? null,
      trackCount: typeof playlist.trackCount === 'number' ? playlist.trackCount : tracks.length,
      tracks
    };
  }

  async getLikedSongIds(): Promise<string[]> {
    const loginStatus = await this.getLoginStatus();
    const userId = extractUserId(loginStatus);
    if (!userId) {
      throw new NcmApiError(NCM_ERROR_CODE.UNAUTHORIZED, 'NCM login profile missing userId');
    }

    const json = await this.getJson('/likelist', { uid: userId });
    const parsed = ncmLikedIdsResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new NcmApiError(
        NCM_ERROR_CODE.BAD_RESPONSE,
        `NCM likelist returned malformed payload: ${parsed.error.message}`
      );
    }

    return parsed.data.ids.map(String);
  }

  async getSongDetails(ids: string[]): Promise<NcmPlaylistDetail['tracks']> {
    const normalizedIds = ids
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (normalizedIds.length === 0) {
      return [];
    }

    const json = await this.getJson('/song/detail', { ids: normalizedIds.join(',') });
    const parsed = ncmSongDetailResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new NcmApiError(
        NCM_ERROR_CODE.BAD_RESPONSE,
        `NCM song/detail returned malformed payload: ${parsed.error.message}`
      );
    }

    return parsed.data.songs.map((song) => ({
      id: song.id,
      name: song.name,
      artists: (song.ar ?? [])
        .map((artist) => artist.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0),
      durationMs: typeof song.dt === 'number' ? song.dt : 0,
      ...(song.al?.picUrl ? { coverImgUrl: song.al.picUrl } : {}),
      ...qualitySignalsProperty(buildTrackQualitySignals(song))
    }));
  }

  async likeTrack(id: string, like: boolean): Promise<void> {
    await this.getJson('/like', { id, like: like ? 'true' : 'false', timestamp: String(Date.now()) });
  }

  async getSongWikiSummary(id: string): Promise<Record<string, unknown> | null> {
    const json = await this.getJson('/song/wiki/summary', { id });
    if (!json || typeof json !== 'object') {
      return null;
    }
    return json as Record<string, unknown>;
  }

  async getSearchHotDetail(): Promise<Array<{ searchWord: string; content?: string }>> {
    const json = await this.getJson('/search/hot/detail', {});
    const data: NcmSearchHotItem[] = Array.isArray(json?.data) ? json.data : [];

    return data
      .map((item) => {
        const searchWord = typeof item?.searchWord === 'string' ? item.searchWord.trim() : '';
        const content = typeof item?.content === 'string' ? item.content.trim() : '';
        return {
          searchWord,
          ...(content ? { content } : {})
        };
      })
      .filter((item): item is { searchWord: string; content?: string } => item.searchWord.length > 0)
      .slice(0, 20);
  }

  async getTopSongHints(type = '0'): Promise<
    Array<{ title: string; artist: string; source: 'ncm_top_song'; reason: string }>
  > {
    const json = await this.getJson('/top/song', { type });
    const data: NcmTopSongItem[] = Array.isArray(json?.data) ? json.data : [];

    return data
      .map((song) => {
        const title = typeof song?.name === 'string' ? song.name.trim() : '';
        const artist = Array.isArray(song?.ar)
          ? song.ar
              .map((item) => (typeof item?.name === 'string' ? item.name.trim() : ''))
              .filter((name: string) => name.length > 0)
              .join(' / ')
          : '';
        return {
          title,
          artist,
          source: 'ncm_top_song' as const,
          reason: '新歌速递'
        };
      })
      .filter((item) => item.title.length > 0 && item.artist.length > 0)
      .slice(0, 30);
  }

  async getArtistToplist(): Promise<string[]> {
    const json = await this.getJson('/toplist/artist', {});
    const artists: NcmArtistItem[] = Array.isArray(json?.list?.artists) ? json.list.artists : [];

    return artists
      .map((artist) => (typeof artist?.name === 'string' ? artist.name.trim() : ''))
      .filter((name: string) => name.length > 0)
      .slice(0, 30);
  }

  private async getJson(path: string, query: Record<string, string>, timeoutMs?: number): Promise<any> {
    const response = await this.rawFetch(path, query, timeoutMs);

    if (!response.ok) {
      throw classifyHttpError(path, response.status);
    }

    try {
      return await response.json();
    } catch (error) {
      throw new NcmApiError(NCM_ERROR_CODE.BAD_RESPONSE, `NCM returned non-JSON from ${path}`, error);
    }
  }

  private async rawFetch(
    path: string,
    query: Record<string, string>,
    timeoutMs = this.fetchTimeoutMs
  ): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    Object.entries(query).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    const cookie = this.getCookie?.();
    if (cookie && !url.searchParams.has('cookie')) {
      url.searchParams.set('cookie', cookie);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));

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

function buildTrackQualitySignals(song: {
  pop?: number;
  fee?: number;
  copyright?: number;
  noCopyrightRcmd?: unknown | null;
  privilege?: { st?: number; toast?: boolean } | null;
  al?: { name?: string | null } | null;
  originCoverType?: number;
  publishTime?: number;
  mv?: number;
}): NcmTrackQualitySignals | undefined {
  const signals: NcmTrackQualitySignals = {};
  const popularity = clampPopularity(song.pop);
  if (popularity !== undefined) signals.popularity = popularity;
  if (Number.isInteger(song.fee)) signals.fee = song.fee;
  if (Number.isInteger(song.copyright)) signals.copyright = song.copyright;
  if (song.noCopyrightRcmd !== undefined && song.noCopyrightRcmd !== null) signals.noCopyrightRcmd = true;
  const privilegeSt = song.privilege?.st;
  if (Number.isInteger(privilegeSt)) signals.privilegeSt = privilegeSt;
  const privilegeToast = song.privilege?.toast;
  if (typeof privilegeToast === 'boolean') signals.privilegeToast = privilegeToast;
  if (typeof song.al?.name === 'string' && song.al.name.trim()) signals.albumName = song.al.name.trim();
  if (Number.isInteger(song.originCoverType)) signals.originCoverType = song.originCoverType;
  if (Number.isInteger(song.publishTime)) signals.publishTime = song.publishTime;
  const mv = song.mv;
  if (typeof mv === 'number' && Number.isInteger(mv)) signals.mv = mv > 0;

  return Object.keys(signals).length > 0 ? signals : undefined;
}

function clampPopularity(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function qualitySignalsProperty(
  qualitySignals: NcmTrackQualitySignals | undefined
): { qualitySignals?: NcmTrackQualitySignals } {
  return qualitySignals ? { qualitySignals } : {};
}

function extractUserId(loginStatus: unknown): string | null {
  if (!loginStatus || typeof loginStatus !== 'object') {
    return null;
  }

  const root = loginStatus as {
    profile?: { userId?: unknown };
    data?: { profile?: { userId?: unknown } };
  };
  const userId = root.data?.profile?.userId ?? root.profile?.userId;
  return typeof userId === 'number' || typeof userId === 'string' ? String(userId) : null;
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

function isSongUrlQualityFallbackError(error: unknown): error is NcmApiError {
  return (
    error instanceof NcmApiError &&
    (error.code === NCM_ERROR_CODE.BAD_RESPONSE || error.code === NCM_ERROR_CODE.UNKNOWN)
  );
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}
