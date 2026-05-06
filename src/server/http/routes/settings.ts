import type { Request, Response } from 'express';
import { z } from 'zod';
import { getPref, setPref } from '../../store/prefs.js';
import type { SecretStore } from '../../security.js';
import { LlmClient } from '../../llm/client.js';
import { TtsClient, type TtsConfig } from '../../tts/client.js';
import { DEFAULT_TTS_CONFIG } from '../../tts/config.js';
import { buildSegueAudioUrl } from './segue.js';

// ─── Config schemas ───────────────────────────────────────────────────────────

const llmConfigSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().optional()  // only present on write
});

const ttsConfigSchema = z.object({
  provider: z.enum(['openai-compatible', 'aliyun-qwen']).default('aliyun-qwen'),
  baseUrl: z.string().url(),
  model: z.string().default('qwen-tts'),
  voice: z.string().default('Cherry'),
  speed: z.number().min(0.25).max(4.0).default(1.0),
  format: z.enum(['mp3', 'opus', 'aac', 'flac']).default('mp3'),
  apiKey: z.string().optional()
});

const settingsBodySchema = z.object({
  llm: llmConfigSchema.optional(),
  tts: ttsConfigSchema.optional()
});

const llmTestBodySchema = z.object({
  llm: llmConfigSchema.partial().optional()
});

const ttsTestBodySchema = z.object({
  tts: ttsConfigSchema.partial().optional()
});

// ─── GET /api/settings ────────────────────────────────────────────────────────

export function createGetSettingsHandler(secrets: SecretStore) {
  return (_req: Request, res: Response): void => {
    const llm = getPref<{ baseUrl: string; model: string }>('__legacy__', 'llm.config') ?? null;
    const tts =
      getPref<{ provider?: string; baseUrl: string; model: string; voice: string; speed: number; format: string }>(
        '__legacy__', 'tts.config'
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
            provider: tts.provider ?? inferTtsProvider(tts),
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
      setPref('__legacy__', 'llm.config', rest);
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
      setPref('__legacy__', 'tts.config', rest);
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

export function createTestLlmSettingsHandler(secrets: SecretStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = llmTestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body', details: parsed.error.issues });
      return;
    }

    const llm = resolveEffectiveLlmConfig(parsed.data.llm, secrets);
    if (!llm) {
      res.status(400).json({ ok: false, error: 'missing llm config', message: '请先配置并保存 LLM 的 Base URL / Model / API Key' });
      return;
    }

    try {
      const client = new LlmClient(llm);
      const output = await client.complete(
        [
          { role: 'system', content: 'You are a concise assistant.' },
          { role: 'user', content: 'Reply with: LLM settings test OK' }
        ],
        { temperature: 0, maxTokens: 24 }
      );
      res.json({
        ok: true,
        model: output.model,
        preview: output.content.trim().slice(0, 120),
        message: 'LLM 配置测试成功'
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: 'llm test failed',
        message: err instanceof Error ? err.message : 'LLM 请求失败'
      });
    }
  };
}

export function createTestTtsSettingsHandler(secrets: SecretStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = ttsTestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body', details: parsed.error.issues });
      return;
    }

    const tts = resolveEffectiveTtsConfig(parsed.data.tts, secrets);
    if (!tts) {
      res.status(400).json({ ok: false, error: 'missing tts config', message: '请先配置并保存 TTS 的 Base URL / Model / API Key' });
      return;
    }

    try {
      const client = new TtsClient(tts);
      const text = '这是一条 TTS 配置测试语音，听到这句话说明当前配置生效。';
      const result = await client.synthesize(text);
      res.json({
        ok: true,
        cached: result.cached,
        audioUrl: buildSegueAudioUrl(result.filePath),
        message: 'TTS 配置测试成功'
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: 'tts test failed',
        message: err instanceof Error ? err.message : 'TTS 请求失败'
      });
    }
  };
}

function inferTtsProvider(tts: { baseUrl?: string; model?: string }): 'openai-compatible' | 'aliyun-qwen' {
  if (tts.baseUrl?.includes('dashscope.aliyuncs.com') || tts.model === 'qwen-tts') {
    return 'aliyun-qwen';
  }

  return 'openai-compatible';
}

function resolveEffectiveLlmConfig(
  patch: Partial<z.infer<typeof llmConfigSchema>> | undefined,
  secrets: SecretStore
): { baseUrl: string; model: string; apiKey: string } | null {
  const stored = getPref<{ baseUrl: string; model: string }>('__legacy__', 'llm.config');
  const baseUrl = patch?.baseUrl?.trim() || stored?.baseUrl;
  const model = patch?.model?.trim() || stored?.model;
  const apiKey = normalizeApiKey(patch?.apiKey) ?? secrets.get('llm.apiKey');

  if (!baseUrl || !model || !apiKey) {
    return null;
  }

  return { baseUrl, model, apiKey };
}

function resolveEffectiveTtsConfig(
  patch: Partial<z.infer<typeof ttsConfigSchema>> | undefined,
  secrets: SecretStore
): TtsConfig | null {
  const stored: Partial<{
    provider: 'openai-compatible' | 'aliyun-qwen';
    baseUrl: string;
    model: string;
    voice: string;
    speed: number;
    format: 'mp3' | 'opus' | 'aac' | 'flac';
  }> = getPref('__legacy__', 'tts.config') ?? {};

  const provider = patch?.provider ?? stored.provider ?? inferTtsProvider(stored);
  const baseUrl = patch?.baseUrl?.trim() || stored.baseUrl || DEFAULT_TTS_CONFIG.baseUrl;
  const model = patch?.model?.trim() || stored.model || DEFAULT_TTS_CONFIG.model;
  const voice = patch?.voice?.trim() || stored.voice || DEFAULT_TTS_CONFIG.voice;
  const speed = patch?.speed ?? stored.speed ?? DEFAULT_TTS_CONFIG.speed;
  const format = patch?.format ?? stored.format ?? DEFAULT_TTS_CONFIG.format;
  const apiKey = normalizeApiKey(patch?.apiKey) ?? secrets.get('tts.apiKey');

  if (!baseUrl || !model || !voice || !apiKey) {
    return null;
  }

  return {
    provider,
    baseUrl,
    model,
    voice,
    speed,
    format,
    apiKey
  };
}

function normalizeApiKey(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
