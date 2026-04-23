export type NcmSong = {
  id: number;
  name: string;
  artists: string[];
};

type NcmClientOptions = {
  getCookie?: () => string | null;
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

export class NcmClient {
  private readonly getCookie: (() => string | null) | undefined;

  constructor(private readonly baseUrl: string, options?: NcmClientOptions) {
    this.getCookie = options?.getCookie;
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
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
      throw new Error('NCM did not return valid qr key');
    }

    const qrJson = await this.getJson('/login/qr/create', {
      key,
      qrimg: 'true',
      timestamp: String(Date.now())
    });

    const qrimg = qrJson?.data?.qrimg;
    const qrurl = qrJson?.data?.qrurl;

    if (typeof qrimg !== 'string' || typeof qrurl !== 'string') {
      throw new Error('NCM did not return qr image payload');
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

    return {
      code: Number(json?.code ?? -1),
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

    const songs = json?.result?.songs ?? [];
    return songs.map((song: any) => ({
      id: song.id,
      name: song.name,
      artists: (song.ar ?? []).map((artist: any) => artist.name)
    }));
  }

  async getSongUrl(id: string): Promise<string | null> {
    const json = await this.getJson('/song/url/v1', {
      id,
      level: 'exhigh'
    });

    const url = json?.data?.[0]?.url;
    return typeof url === 'string' ? url : null;
  }

  async getLyric(id: string): Promise<string | null> {
    const json = await this.getJson('/lyric', { id });
    const lyric = json?.lrc?.lyric;
    return typeof lyric === 'string' ? lyric : null;
  }

  async getPlaylistDetail(id: string): Promise<unknown> {
    return this.getJson('/playlist/detail', { id });
  }

  private async getJson(path: string, query: Record<string, string>): Promise<any> {
    const url = new URL(path, this.baseUrl);
    Object.entries(query).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    const cookie = this.getCookie?.();
    if (cookie && !url.searchParams.has('cookie')) {
      url.searchParams.set('cookie', cookie);
    }

    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`NCM request failed: ${path} (${response.status})`);
    }

    return response.json();
  }
}
