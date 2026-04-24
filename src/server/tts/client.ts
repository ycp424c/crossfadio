import { z } from 'zod';
import { buildCacheHash, getCachedFilePath, saveToCache } from './cache.js';

export const ttsConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().default('tts-1'),
  voice: z.string().default('alloy'),
  speed: z.number().min(0.25).max(4.0).default(1.0),
  format: z.enum(['mp3', 'opus', 'aac', 'flac']).default('mp3')
});

export type TtsConfig = z.infer<typeof ttsConfigSchema>;

export type TtsResult = {
  filePath: string;
  cached: boolean;
};

export class TtsClient {
  constructor(private readonly config: TtsConfig) {}

  async synthesize(text: string, opts: { signal?: AbortSignal } = {}): Promise<TtsResult> {
    const hash = buildCacheHash({
      endpoint: this.config.baseUrl,
      model: this.config.model,
      voice: this.config.voice,
      speed: this.config.speed,
      format: this.config.format,
      text
    });

    const cached = getCachedFilePath(hash, this.config.format);
    if (cached) {
      return { filePath: cached, cached: true };
    }

    const resp = await fetch(`${this.config.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        input: text,
        voice: this.config.voice,
        speed: this.config.speed,
        response_format: this.config.format
      }),
      signal: opts.signal
    });

    if (!resp.ok) {
      throw new TtsError(`TTS request failed: ${resp.status} ${resp.statusText}`);
    }

    const data = Buffer.from(await resp.arrayBuffer());
    const filePath = saveToCache(hash, this.config.format, data);
    return { filePath, cached: false };
  }
}

export class TtsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsError';
  }
}
