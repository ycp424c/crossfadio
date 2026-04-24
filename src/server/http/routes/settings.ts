import type { Request, Response } from 'express';
import { z } from 'zod';
import { getPref, setPref } from '../../store/prefs.js';
import type { SecretStore } from '../../security.js';

// ─── Config schemas ───────────────────────────────────────────────────────────

const llmConfigSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().optional()  // only present on write
});

const ttsConfigSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().default('tts-1'),
  voice: z.string().default('alloy'),
  speed: z.number().min(0.25).max(4.0).default(1.0),
  format: z.enum(['mp3', 'opus', 'aac', 'flac']).default('mp3'),
  apiKey: z.string().optional()
});

const settingsBodySchema = z.object({
  llm: llmConfigSchema.optional(),
  tts: ttsConfigSchema.optional()
});

// ─── GET /api/settings ────────────────────────────────────────────────────────

export function createGetSettingsHandler(secrets: SecretStore) {
  return (_req: Request, res: Response): void => {
    const llm = getPref<{ baseUrl: string; model: string }>('llm.config') ?? null;
    const tts =
      getPref<{ baseUrl: string; model: string; voice: string; speed: number; format: string }>(
        'tts.config'
      ) ?? null;

    res.json({
      ok: true,
      llm: llm
        ? {
            baseUrl: llm.baseUrl,
            model: llm.model,
            hasApiKey: Boolean(secrets.get('llm.apiKey'))
          }
        : null,
      tts: tts
        ? {
            baseUrl: tts.baseUrl,
            model: tts.model,
            voice: tts.voice,
            speed: tts.speed,
            format: tts.format,
            hasApiKey: Boolean(secrets.get('tts.apiKey'))
          }
        : null
    });
  };
}

// ─── PUT /api/settings ────────────────────────────────────────────────────────

export function createSaveSettingsHandler(secrets: SecretStore) {
  return (req: Request, res: Response): void => {
    const parsed = settingsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body', details: parsed.error.issues });
      return;
    }

    const { llm, tts } = parsed.data;

    if (llm) {
      const { apiKey, ...rest } = llm;
      setPref('llm.config', rest);
      if (apiKey !== undefined) {
        if (apiKey) {
          secrets.set('llm.apiKey', apiKey);
        } else {
          secrets.remove('llm.apiKey');
        }
      }
    }

    if (tts) {
      const { apiKey, ...rest } = tts;
      setPref('tts.config', rest);
      if (apiKey !== undefined) {
        if (apiKey) {
          secrets.set('tts.apiKey', apiKey);
        } else {
          secrets.remove('tts.apiKey');
        }
      }
    }

    res.json({ ok: true });
  };
}
