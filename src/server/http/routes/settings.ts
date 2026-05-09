import { getDailyTheme } from '../../daily-theme.js';
import { loadCorpusFile } from '../../user-corpus/loader.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { NcmClient } from '../../ncm/client.js';
import { getPref, setPref } from '../../store/prefs.js';
import { getConfig } from '../../config.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

// ── GET /api/settings ─────────────────────────────────────────────────────────

export function createGetSettingsHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const config = getConfig();
    const userVoice = getPref<string>(userId, 'tts.voice');

    res.json({
      ok: true,
      llm: {
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        hasApiKey: Boolean(config.llm.apiKey)
      },
      tts: {
        baseUrl: config.tts.baseUrl,
        hasApiKey: Boolean(config.tts.apiKey),
        voice: userVoice ?? config.tts.voiceDefault ?? 'Cherry',
        voiceDefault: config.tts.voiceDefault
      }
    });
  };
}

// ── PUT /api/settings ─────────────────────────────────────────────────────────

const settingsBodySchema = z.object({
  tts: z.object({ voice: z.string().min(1) }).optional()
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
    res.json({ ok: true });
  };
}

// ── GET /api/settings/player-context ──────────────────────────────────────────

export function createGetPlayerContextHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const theme = getDailyTheme();
    const taste = loadCorpusFile(userId, 'taste.md');

    res.json({
      ok: true,
      theme: theme ? { theme: theme.theme, keywords: theme.keywords } : null,
      taste
    });
  };
}
