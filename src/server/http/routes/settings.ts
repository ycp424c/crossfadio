import { getOrGenerateDailyThemeWithin } from '../../daily-theme.js';
import { fetchWeather } from '../../weather.js';
import { loadCorpusFile } from '../../user-corpus/loader.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { NcmClient } from '../../ncm/client.js';
import { getPref, setPref } from '../../store/prefs.js';
import { getConfig } from '../../config.js';
import { DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from '../../../shared/tts.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };
export type DiscoveryMode = 'explore' | 'comfort';

function getDiscoveryMode(userId: string): DiscoveryMode {
  return getPref<DiscoveryMode>(userId, 'discovery.mode') === 'comfort' ? 'comfort' : 'explore';
}

// ── GET /api/settings ─────────────────────────────────────────────────────────

export function createGetSettingsHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const config = getConfig();
    const userVoice = getPref<string>(userId, 'tts.voice');
    const dailyThemeEnabled = getPref<boolean>(userId, 'dailyTheme.enabled') !== false;
    const discoveryMode = getDiscoveryMode(userId);

    res.json({
      ok: true,
      llm: {
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        hasApiKey: Boolean(config.llm.apiKey)
      },
      tts: {
        baseUrl: config.tts.baseUrl,
        model: DEFAULT_TTS_MODEL,
        hasApiKey: Boolean(config.tts.apiKey),
        voice: userVoice ?? config.tts.voiceDefault ?? DEFAULT_TTS_VOICE,
        voiceDefault: config.tts.voiceDefault
      },
      dailyThemeEnabled,
      discoveryMode
    });
  };
}

// ── PUT /api/settings ─────────────────────────────────────────────────────────

const settingsBodySchema = z.object({
  tts: z.object({ voice: z.string().min(1) }).optional(),
  dailyThemeEnabled: z.boolean().optional(),
  discoveryMode: z.enum(['explore', 'comfort']).optional()
});
export function createSaveSettingsHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const parsed = settingsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body', details: parsed.error.issues });
      return;
    }
    if (parsed.data.tts?.voice) {
      setPref(userId, 'tts.voice', parsed.data.tts.voice);
    }
    if (parsed.data.dailyThemeEnabled !== undefined) {
      setPref(userId, 'dailyTheme.enabled', parsed.data.dailyThemeEnabled);
    }
    if (parsed.data.discoveryMode !== undefined) {
      setPref(userId, 'discovery.mode', parsed.data.discoveryMode);
    }
    res.json({ ok: true });
  };
}

// ── GET /api/settings/player-context ──────────────────────────────────────────

export function createGetPlayerContextHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const { userId } = req as AuthedRequest;
    const enabled = getPref<boolean>(userId, 'dailyTheme.enabled') !== false;
    const discoveryMode = getDiscoveryMode(userId);
    const [theme, weather] = await Promise.all([
      enabled ? getOrGenerateDailyThemeWithin(3_000) : Promise.resolve(null),
      fetchWeather(userId)
    ]);
    const taste = loadCorpusFile(userId, 'taste.md');

    res.json({
      ok: true,
      theme: theme ? { theme: theme.theme, keywords: theme.keywords } : null,
      weather,
      taste,
      discoveryMode
    });
  };
}
