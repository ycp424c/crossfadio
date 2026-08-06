import { computeStream } from '../agent/compute.js';
import { buildSystemPrompt } from '../agent/modes.js';
import { segueOutputSchema, trackSchema, type Fragments, type SegueOutput } from '../agent/schema.js';
import { buildSegueTrackContext } from '../agent/segue-context.js';
import type { LlmConfig } from '../llm/client.js';
import type { NcmClient } from '../ncm/client.js';
import { getLogger } from '../logger.js';
import { saveSegue } from '../store/segues.js';
import { appendDjEvent, getRecentTrackSelectedEvent, type DjEventRecord } from '../store/dj-events.js';
import type { z } from 'zod';
import { buildDjMemorySnapshot } from '../dj-memory/snapshot.js';
import { projectDjMemoryForSegue } from '../dj-memory/projections.js';
import { truncateTtsText, estimateTtsTextUnits } from '../tts/client.js';

export type GenerateSegueInput = {
  userId: string;
  from: z.infer<typeof trackSchema>;
  to: z.infer<typeof trackSchema>;
  ncmClient: NcmClient;
  llmConfig: LlmConfig;
  signal?: AbortSignal;
  emitDelta?: (say: string) => void;
  now?: Date;
  djPickReasonFallback?: string | null;
  /**
   * 可选：口播文本长度上限（"估算字"），由调用方按 TTS provider 能力传入。
   * 在保存 / 返回 / 估时之前统一截断，保证落库文案、前端展示、时长估算与实际合成音频一致。
   */
  maxSayUnits?: number;
};

export type GenerateSegueResult = {
  segue: SegueOutput;
  fromTrack: z.infer<typeof trackSchema>;
  toTrack: z.infer<typeof trackSchema>;
  selectionEvent: DjEventRecord | null;
};

export async function generateSegue(input: GenerateSegueInput): Promise<GenerateSegueResult | null> {
  const logger = getLogger();
  const now = input.now ?? new Date();

  const [trackContext, memorySnapshot] = await Promise.all([
    loadSegueContext(input.from, input.to, input.ncmClient, logger),
    buildDjMemorySnapshot({
      userId: input.userId,
      now
    })
  ]);
  if (input.signal?.aborted) return null;

  const selectionEvent = getRecentTrackSelectedEvent(input.userId, input.to.id);
  const selectionRationale = getSelectionRationale(selectionEvent);

  const fragments: Fragments = {
    mode: 'segue',
    system: buildSystemPrompt('You are a DJ.', 'segue'),
    djMemory: projectDjMemoryForSegue(memorySnapshot),
    input: {
      kind: 'segueTrigger',
      from: trackContext.fromTrack,
      to: trackContext.toTrack,
      context: {
        from: trackContext.fromContext,
        to: trackContext.toContext,
        ...(input.djPickReasonFallback ? { djPickReason: input.djPickReasonFallback } : {}),
        ...(selectionRationale ? { selectionRationale } : {}),
        ...(selectionEvent ? { selectionEventId: selectionEvent.id } : {})
      }
    },
    trace: { triggeredBy: 'segue-hook', lastDecision: null }
  };

  let finalOutput: unknown = null;
  for await (const event of computeStream(fragments, { llmConfig: input.llmConfig, signal: input.signal })) {
    if (input.signal?.aborted) return null;
    if (event.type === 'delta') {
      input.emitDelta?.(event.say);
    } else if (event.type === 'done') {
      finalOutput = event.output;
    }
  }

  const parsed = segueOutputSchema.safeParse(finalOutput);
  if (!parsed.success) return null;
  const segue = parsed.data;

  // 在保存/返回/估时前按 provider 能力统一截断，避免保存完整文案但合成截断音频导致时长与展示不一致。
  let say = segue.say;
  if (input.maxSayUnits && input.maxSayUnits > 0) {
    const truncated = truncateTtsText(say, input.maxSayUnits);
    if (truncated !== say) {
      logger.warn({
        userId: input.userId,
        originalUnits: estimateTtsTextUnits(say),
        maxSayUnits: input.maxSayUnits,
        toTrackId: input.to.id
      }, 'Segue say truncated to TTS provider limit');
    }
    say = truncated;
  }

  saveSegue(input.userId, {
    fromId: input.from.id,
    fromName: trackContext.fromTrack.name,
    toId: input.to.id,
    toName: trackContext.toTrack.name,
    say
  });
  appendDjEvent({
    userId: input.userId,
    type: 'segue_generated',
    correlationId: selectionEvent?.correlationId,
    causationEventId: selectionEvent?.id,
    runId: selectionEvent?.runId ?? undefined,
    trackId: input.to.id,
    payload: {
      fromTrackId: input.from.id,
      toTrackId: input.to.id,
      ...(selectionEvent ? { selectionEventId: selectionEvent.id } : {}),
      segueSummary: say
    }
  });

  return {
    segue: { ...segue, say },
    fromTrack: trackContext.fromTrack,
    toTrack: trackContext.toTrack,
    selectionEvent
  };
}

function getSelectionRationale(event: DjEventRecord | null): string | null {
  const payload = event?.payload;
  if (!payload || typeof payload !== 'object') return null;
  const rationale = (payload as { selectionRationale?: unknown }).selectionRationale;
  return typeof rationale === 'string' && rationale.trim() ? rationale.trim() : null;
}

async function loadSegueContext(
  from: z.infer<typeof trackSchema>,
  to: z.infer<typeof trackSchema>,
  ncmClient: NcmClient,
  logger: ReturnType<typeof getLogger>
): Promise<{
  fromTrack: z.infer<typeof trackSchema>;
  toTrack: z.infer<typeof trackSchema>;
  fromContext: ReturnType<typeof buildSegueTrackContext>;
  toContext: ReturnType<typeof buildSegueTrackContext>;
}> {
  const [detailRows, fromLyric, toLyric, fromWikiSummary, toWikiSummary] = await Promise.all([
    ncmClient.getSongDetails([from.id, to.id]).catch((err) => {
      logger.debug({ err, fromId: from.id, toId: to.id }, 'Failed to load song details for segue context');
      return [];
    }),
    ncmClient.getLyric(from.id).catch((err) => {
      logger.debug({ err, id: from.id }, 'Failed to load source lyric for segue context');
      return null;
    }),
    ncmClient.getLyric(to.id).catch((err) => {
      logger.debug({ err, id: to.id }, 'Failed to load target lyric for segue context');
      return null;
    }),
    ncmClient.getSongWikiSummary(from.id).catch((err) => {
      logger.debug({ err, id: from.id }, 'Failed to load source wiki summary for segue context');
      return null;
    }),
    ncmClient.getSongWikiSummary(to.id).catch((err) => {
      logger.debug({ err, id: to.id }, 'Failed to load target wiki summary for segue context');
      return null;
    })
  ]);

  const detailMap = new Map(detailRows.map((detail) => [String(detail.id), detail]));
  const fromContext = buildSegueTrackContext({
    track: from,
    detail: detailMap.get(from.id) ?? null,
    lyric: fromLyric,
    wikiSummary: fromWikiSummary
  });
  const toContext = buildSegueTrackContext({
    track: to,
    detail: detailMap.get(to.id) ?? null,
    lyric: toLyric,
    wikiSummary: toWikiSummary
  });

  return {
    fromTrack: {
      id: from.id,
      name: fromContext.name,
      artist: fromContext.artist
    },
    toTrack: {
      id: to.id,
      name: toContext.name,
      artist: toContext.artist
    },
    fromContext,
    toContext
  };
}
