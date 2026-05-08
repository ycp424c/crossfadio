import type { Request, Response } from 'express';
import { z } from 'zod';
import { initSseRes, writeSseEvent, writeSseComment } from '../sse.js';
import { getLogger } from '../../logger.js';
import type { NcmClient } from '../../ncm/client.js';
import { handleChatMessage, cancelActiveRecommend } from '../chat-sse-worker.js';

type AuthedRequest = Request & { userId: string; ncmClient: NcmClient };

// ── 持久事件流（队列更新等跨功能事件）────────────────────────────────────────

// per-user SSE 连接池：userId → Set<Response>
const eventClients = new Map<string, Set<Response>>();

function addEventClient(userId: string, res: Response): void {
  if (!eventClients.has(userId)) eventClients.set(userId, new Set());
  eventClients.get(userId)!.add(res);
}

function removeEventClient(userId: string, res: Response): void {
  eventClients.get(userId)?.delete(res);
}
export function _addEventClientForTests(userId: string, res: Response): void {
  if (!eventClients.has(userId)) eventClients.set(userId, new Set());
  eventClients.get(userId)!.add(res);
}

export function _resetEventClientsForTests(): void {
  eventClients.clear();
}

/** 向指定用户的所有持久 SSE 连接广播事件 */
export function broadcastSse(userId: string, type: string, payload: Record<string, unknown>): void {
  const clients = eventClients.get(userId);
  if (!clients || clients.size === 0) return;
  for (const res of clients) {
    try {
      writeSseEvent(res, type, payload);
    } catch {
      clients.delete(res);
    }
  }
}

/** 持久 SSE 连接处理器 */
export function createSseEventsHandler() {
  return (req: Request, res: Response): void => {
    const userId = (req as AuthedRequest).userId;
    initSseRes(res);

    writeSseEvent(res, 'connected', { userId });

    // 心跳（每 30s）
    const heartbeat = setInterval(() => {
      try { writeSseComment(res, 'ping'); } catch { clearInterval(heartbeat); }
    }, 30_000);

    addEventClient(userId, res);

    res.on('close', () => {
      clearInterval(heartbeat);
      removeEventClient(userId, res);
    });
  };
}

// ── Chat SSE（POST body → stream response）────────────────────────────────────

const chatBodySchema = z.object({ text: z.string().min(1) });

export function createSseChatHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }

    const { userId, ncmClient } = req as AuthedRequest;
    initSseRes(res);
    const controller = new AbortController();
    req.on('close', () => controller.abort(new Error('client-disconnected')));

    const send = (type: string, payload: Record<string, unknown>): void => {
      if (controller.signal.aborted) return;
      try { writeSseEvent(res, type, payload); } catch { controller.abort(new Error('write-failed')); }
    };

    try {
      await handleChatMessage(userId, ncmClient, parsed.data.text, send, controller.signal);
    } catch (err) {
      getLogger().error({ err }, 'Chat SSE handler error');
      try { writeSseEvent(res, 'chat.error', { error: 'internal error' }); } catch { /* ignore */ }
    } finally {
      if (!res.writableEnded) res.end();
    }
  };
}

// ── 取消推荐 ─────────────────────────────────────────────────────────────────

const cancelBodySchema = z.object({ jobId: z.string().min(1) });

export function createSseCancelRecommendHandler() {
  return (req: Request, res: Response): void => {
    const parsed = cancelBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body' });
      return;
    }
    cancelActiveRecommend(parsed.data.jobId);
    res.json({ ok: true });
  };
}
