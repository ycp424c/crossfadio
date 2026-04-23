export type NcmSong = {
  id: number;
  name: string;
  artists: string[];
};

export class NcmClient {
  constructor(private readonly baseUrl: string) {}

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
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

    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`NCM request failed: ${path} (${response.status})`);
    }

    return response.json();
  }
}
