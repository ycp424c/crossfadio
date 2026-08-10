import { getOrGenerateDailyThemeWithin } from '../../daily-theme.js';
import { fetchWeather } from '../../weather.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { NcmClient } from '../../ncm/client.js';
import { getPref, setPref } from '../../store/prefs.js';
import { getConfig } from '../../config.js';
import { TtsClient } from '../../tts/client.js';
import { resolveTtsConfig } from '../../tts/config.js';
import { supportsThinkingControl } from '../../llm/client.js';
import { buildSegueAudioUrl } from './segue.js';
import { DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, TENCENT_TTS_VOICE_IDS, TTS_PREVIEW_TEXT, QWEN3_TTS_VOICES } from '../../../shared/tts.js';
import { resolveEffectiveVoiceForProvider } from '../../tts/config.js';
import type { TtsProvider } from '../../config.js';
import { getTtsVoicePreference, setTtsVoicePreference } from '../../tts/preferences.js';
import {
  AUTO_FILL_BATCH_SIZE_MAX,
  AUTO_FILL_BATCH_SIZE_MIN,
  DEFAULT_AUTO_FILL_BATCH_SIZE,
  DISCOVERY_MODE_VALUES,
  parseDiscoveryMode,
  parseAutoFillBatchSize
} from '../../../shared/dj.js';
import type { DiscoveryMode } from '../../../shared/dj.js';
import { getCurrentTasteProfile } from '../../store/taste-profiles.js';
import { resolveUserTier, type UserTier } from '../../resource-policy.js';
import {
  acquireResourcePermit,
  ResourceLimitError,
  type ResourcePermit
} from '../../resource-governor.js';
import { sendResourceLimitResponse } from '../resource-limit-response.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

function getDiscoveryMode(userId: string): DiscoveryMode {
  return parseDiscoveryMode(getPref<DiscoveryMode>(userId, 'discovery.mode'));
}

function getAutoFillBatchSize(userId: string): number {
  return parseAutoFillBatchSize(getPref<number>(userId, 'dj.autoFillBatchSize'));
}

// 音色值必须与当前 TTS provider 匹配，避免把腾讯 VoiceType 数字存给阿里云（反之亦然）。
export function isVoiceValidForProvider(voice: string, provider: TtsProvider): boolean {
  if (provider === 'tencent-cloud') {
    return (TENCENT_TTS_VOICE_IDS as readonly string[]).includes(voice);
  }
  if (provider === 'aliyun-qwen') {
    return (QWEN3_TTS_VOICES as readonly string[]).includes(voice);
  }
  return voice.length > 0;
}

// ── GET /api/settings ─────────────────────────────────────────────────────────

export function createGetSettingsHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const config = getConfig();
    const tier = resolveUserTier(userId);
    const thinkingCapable = tier === 'priority';
    const batchCapable = tier === 'priority';
    const userVoice = getTtsVoicePreference(userId, config.tts.provider);
    const dailyThemeEnabled = getPref<boolean>(userId, 'dailyTheme.enabled') !== false;
    const discoveryMode = getDiscoveryMode(userId);
    const storedBatchSize = getAutoFillBatchSize(userId);
    const storedThinking = getPref<boolean>(userId, 'llm.thinkingEnabled') === true;

    res.json({
      ok: true,
      resourceTier: tier,
      resourceCapabilities: {
        thinking: thinkingCapable,
        configurableAutoFillBatchSize: batchCapable
      },
      llm: {
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        hasApiKey: Boolean(config.llm.apiKey),
        // Standard users are always reported with thinking disabled, and the
        // effective auto-fill batch is clamped to 2 regardless of stored prefs.
        thinkingEnabled: thinkingCapable && storedThinking,
        thinkingSupported: supportsThinkingControl(config.llm.model, config.llm.baseUrl)
      },
      tts: {
        provider: config.tts.provider,
        baseUrl: config.tts.baseUrl ?? '',
        model: config.tts.provider === 'tencent-cloud'
          ? 'TextToVoice'
          : (config.tts.model ?? DEFAULT_TTS_MODEL),
        hasApiKey: config.tts.provider === 'tencent-cloud'
          ? Boolean(config.tts.secretId && config.tts.secretKey)
          : Boolean(config.tts.apiKey),
        // 按 provider 归一化：tencent 模式下无效音色（如默认 'Cherry'）回落到合法 VoiceType id，
        // 保证前端原样回传时能通过 PUT 校验。
        voice: resolveEffectiveVoiceForProvider(
          userVoice ?? config.tts.voiceDefault ?? DEFAULT_TTS_VOICE,
          config.tts.provider,
          config.tts.voiceDefault ?? DEFAULT_TTS_VOICE
        ),
        voiceDefault: config.tts.voiceDefault
      },
      dailyThemeEnabled,
      discoveryMode,
      autoFillBatchSize: batchCapable ? storedBatchSize : DEFAULT_AUTO_FILL_BATCH_SIZE
    });
  };
}

// ── PUT /api/settings ─────────────────────────────────────────────────────────

const settingsBodySchema = z.object({
  llm: z.object({ thinkingEnabled: z.boolean() }).optional(),
  tts: z.object({ voice: z.string().min(1) }).optional(),
  dailyThemeEnabled: z.boolean().optional(),
  discoveryMode: z.enum(DISCOVERY_MODE_VALUES).optional(),
  autoFillBatchSize: z.number().int().min(AUTO_FILL_BATCH_SIZE_MIN).max(AUTO_FILL_BATCH_SIZE_MAX).optional()
});
export function createSaveSettingsHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const config = getConfig();
    const parsed = settingsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body', details: parsed.error.issues });
      return;
    }
    // Standard-tier capability caps: reject disallowed writes explicitly with
    // 403 resource_tier_restricted instead of silently ignoring them.
    const tier = resolveUserTier(userId);
    if (tier === 'standard') {
      if (parsed.data.llm?.thinkingEnabled === true) {
        res.status(403).json({
          ok: false,
          error: 'resource_tier_restricted',
          message: '标准资源档位无法启用深度思考'
        });
        return;
      }
      if (parsed.data.autoFillBatchSize !== undefined
        && parsed.data.autoFillBatchSize > DEFAULT_AUTO_FILL_BATCH_SIZE) {
        res.status(403).json({
          ok: false,
          error: 'resource_tier_restricted',
          message: '标准资源档位最多每次自动补歌 2 首'
        });
        return;
      }
    }
    if (parsed.data.tts?.voice) {
      const voice = parsed.data.tts.voice.trim();
      if (!isVoiceValidForProvider(voice, config.tts.provider)) {
        res.status(400).json({ ok: false, error: `invalid voice for current TTS provider (${config.tts.provider})` });
        return;
      }
      setTtsVoicePreference(userId, config.tts.provider, voice);
    }
    if (parsed.data.llm?.thinkingEnabled !== undefined) {
      setPref(userId, 'llm.thinkingEnabled', parsed.data.llm.thinkingEnabled);
    }
    if (parsed.data.dailyThemeEnabled !== undefined) {
      setPref(userId, 'dailyTheme.enabled', parsed.data.dailyThemeEnabled);
    }
    if (parsed.data.discoveryMode !== undefined) {
      setPref(userId, 'discovery.mode', parsed.data.discoveryMode);
    }
    if (parsed.data.autoFillBatchSize !== undefined) {
      setPref(userId, 'dj.autoFillBatchSize', parsed.data.autoFillBatchSize);
    }
    res.json({ ok: true });
  };
}

// ── POST /api/settings/tts-preview ───────────────────────────────────────────

const ttsPreviewBodySchema = z.object({
  voice: z.string().min(1).optional()
});

export function createPreviewTtsHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const { userId } = req as AuthedRequest;
    const parsed = ttsPreviewBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body', details: parsed.error.issues });
      return;
    }

    let permit: ResourcePermit;
    try {
      permit = acquireResourcePermit(userId, 'tts_preview');
    } catch (err) {
      if (err instanceof ResourceLimitError) {
        sendResourceLimitResponse(res, err);
        return;
      }
      throw err;
    }

    try {
      const config = resolveTtsConfig(userId);
      const voice = parsed.data.voice ?? config.voice;
      const previewConfig = { ...config, voice };
      const client = new TtsClient(previewConfig);

      const result = await client.synthesize(TTS_PREVIEW_TEXT);
      res.json({
        ok: true,
        audioUrl: buildSegueAudioUrl(result.filePath),
        cached: result.cached,
        voice,
        model: previewConfig.model
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'TTS preview failed';
      res.status(502).json({ ok: false, error: message });
    } finally {
      permit.release();
    }
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
    const taste = getCurrentTasteProfile(userId)?.profile.summary ?? '';

    res.json({
      ok: true,
      theme: theme ? { theme: theme.theme, keywords: theme.keywords } : null,
      weather,
      taste,
      discoveryMode
    });
  };
}
