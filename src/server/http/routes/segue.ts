import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { computeStream } from '../../agent/compute.js';
import { buildSystemPrompt } from '../../agent/modes.js';
import { trackSchema } from '../../agent/schema.js';
import type { Fragments } from '../../agent/schema.js';
import { resolveLlmConfig } from '../../llm/config.js';
import type { NcmClient } from '../../ncm/client.js';
import type { SecretStore } from '../../security.js';
import { loadUserCorpus } from '../../user-corpus/loader.js';
import { getRecentPlays } from '../../store/plays.js';
import { getRecentMessages } from '../../store/messages.js';
import { fetchWeather } from '../../weather.js';
import { TtsClient } from '../../tts/client.js';
import { resolveTtsConfig } from '../../tts/config.js';
import { resolveUserCorpusDir } from '../../app-paths.js';
import { broadcast } from '../broadcast.js';
import { getLogger } from '../../logger.js';

const triggerBodySchema = z.object({
  from: trackSchema,
  to: trackSchema
});

type SegueRouteOptions = {
  secrets: SecretStore;
  ncmClient: NcmClient;
};

export function createSegueTriggerHandler(opts: SegueRouteOptions) {
  return (req: Request, res: Response): void => {
    const parsed = triggerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }

    const requestId = randomBytes(8).toString('hex');
    res.json({ ok: true, requestId });

    void runSegueJob(requestId, parsed.data.from, parsed.data.to, opts);
  };
}

async function runSegueJob(
  requestId: string,
  from: z.infer<typeof trackSchema>,
  to: z.infer<typeof trackSchema>,
  opts: SegueRouteOptions
): Promise<void> {
  const logger = getLogger();

  try {
    const llmConfig = resolveLlmConfig(opts.secrets);
    if (!llmConfig) {
      broadcast({ type: 'segue.degraded', requestId, reason: 'no-llm' });
      return;
    }

    const corpus = loadUserCorpus();
    const weather = await fetchWeather();
    const now = new Date();

    const fragments: Fragments = {
      mode: 'segue',
      system: buildSystemPrompt(corpus.djPersona || 'You are a DJ.', 'segue'),
      corpus: {
        taste: corpus.taste,
        routines: corpus.routines,
        moodRules: corpus.moodRules,
        playlists: corpus.playlists
      },
      env: {
        nowIso: now.toISOString(),
        localTime: formatLocalTime(now),
        weather,
        nowPlaying: { id: from.id, name: from.name ?? '', artist: from.artist ?? '', durationMs: null }
      },
      memory: { recentPlays: getRecentPlays(50), recentChat: getRecentMessages(20) },
      input: { kind: 'segueTrigger', from, to },
      trace: { triggeredBy: 'segue-hook', lastDecision: null }
    };

    let sayText = '';
    let finalOutput: unknown = null;

    for await (const event of computeStream(fragments, { llmConfig })) {
      if (event.type === 'delta') {
        sayText += event.say;
        broadcast({ type: 'segue.delta', requestId, say: event.say });
      } else if (event.type === 'done') {
        finalOutput = event.output;
      }
    }

    if (!finalOutput || typeof finalOutput !== 'object' || !('say' in finalOutput)) {
      broadcast({ type: 'segue.degraded', requestId, reason: 'parse-failed' });
      return;
    }

    const segueOutput = finalOutput as {
      say: string;
      duckingHintSec: number;
      filterSweep: boolean;
      emotionTag: string;
    };

    // Synthesize TTS
    const ttsConfig = resolveTtsConfig(opts.secrets);
    if (!ttsConfig) {
      broadcast({
        type: 'segue.tts-ready',
        requestId,
        audioUrl: null,
        segue: segueOutput
      });
      return;
    }

    const ttsClient = new TtsClient(ttsConfig);
    const ttsResult = await ttsClient.synthesize(segueOutput.say);

    // Serve the file via /api/segue/audio/<filename>
    const filename = path.basename(ttsResult.filePath);
    broadcast({
      type: 'segue.tts-ready',
      requestId,
      audioUrl: `/api/segue/audio/${filename}`,
      segue: segueOutput
    });
  } catch (err) {
    logger.warn({ err }, 'Segue job failed');
    broadcast({ type: 'segue.degraded', requestId, reason: 'error' });
  }
}

function formatLocalTime(date: Date): string {
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const day = weekdays[date.getDay()];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `周${day} ${hh}:${mm}`;
}

export function createSegueAudioHandler() {
  return (req: Request, res: Response): void => {
    const filename = req.params.filename;
    if (!filename || /[/\\]/.test(filename)) {
      res.status(400).json({ ok: false, error: 'invalid filename' });
      return;
    }
    const dir = path.join(resolveUserCorpusDir(), '..', 'cache', 'tts');
    res.sendFile(filename, { root: dir }, (err) => {
      if (err) res.status(404).json({ ok: false, error: 'not found' });
    });
  };
}
