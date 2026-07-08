import type { Request, Response } from 'express';
import { z } from 'zod';
import { appendDjEvent } from '../../store/dj-events.js';
import { getDb } from '../../store/db.js';
import {
  getPersonalDjContextSnapshot,
  listPersonalDjContexts,
  personalDjContextPayloadSchema,
  revokeCurrentPersonalDjContext,
  savePersonalDjContext
} from '../../store/personal-dj-context.js';
import {
  createPersonalDjContextToken,
  listPersonalDjContextTokens,
  revokePersonalDjContextToken
} from '../../store/personal-dj-context-tokens.js';
import type { PersonalDjContextBridgeRequest } from '../middleware/personalDjContextBridgeAuth.js';

const MAX_PERSONAL_DJ_CONTEXT_BYTES = 16 * 1024;

type AuthedRequest = Request & { userId: string };

const createTokenBodySchema = z.object({
  name: z.string().trim().min(1).max(80).optional()
}).strict();

export function createPostPersonalDjContextHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as PersonalDjContextBridgeRequest;
    const bodySize = Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8');
    if (bodySize > MAX_PERSONAL_DJ_CONTEXT_BYTES) {
      res.status(413).json({ ok: false, error: 'payload too large' });
      return;
    }

    const parsed = personalDjContextPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body', details: parsed.error.issues });
      return;
    }

    const record = getDb().transaction(() => {
      const saved = savePersonalDjContext({ userId, payload: parsed.data });
      appendDjEvent({
        userId,
        type: 'personal_context_uploaded',
        correlationId: saved.id,
        payload: {
          contextId: saved.id,
          generatedAt: saved.payload.generatedAt,
          uploadedAt: saved.uploadedAt,
          source: {
            kind: saved.payload.source.kind
          },
          musicHintCount: saved.payload.musicHints.length
        }
      });
      return saved;
    })();

    const retainedHistoryCount = listPersonalDjContexts(userId, 20)
      .filter((item) => item.id !== record.id)
      .length;
    res.json({
      ok: true,
      contextId: record.id,
      uploadedAt: record.uploadedAt,
      retainedHistoryCount
    });
  };
}

export function createListPersonalDjContextTokensHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    res.json({
      ok: true,
      tokens: listPersonalDjContextTokens(userId).map((token) => ({
        id: token.id,
        name: token.name,
        scope: token.scope,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
        revokedAt: token.revokedAt
      }))
    });
  };
}

export function createCreatePersonalDjContextTokenHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const parsed = createTokenBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'invalid body', details: parsed.error.issues });
      return;
    }

    try {
      const token = createPersonalDjContextToken(userId, parsed.data.name);
      res.json({
        ok: true,
        token: {
          id: token.id,
          name: token.name,
          scope: token.scope,
          createdAt: token.createdAt,
          lastUsedAt: token.lastUsedAt,
          revokedAt: token.revokedAt,
          token: token.token
        }
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'personal_dj_context_token_limit_reached') {
        res.status(409).json({ ok: false, error: 'token limit reached' });
        return;
      }
      throw err;
    }
  };
}

export function createRevokePersonalDjContextTokenHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const tokenId = req.params.id;
    if (!tokenId) {
      res.status(400).json({ ok: false, error: 'missing token id' });
      return;
    }
    const revoked = revokePersonalDjContextToken(userId, tokenId);
    res.json({ ok: true, revoked });
  };
}

export function createGetPersonalDjContextStatusHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const snapshot = getPersonalDjContextSnapshot(userId);
    res.json({
      ok: true,
      current: snapshot.current ? summarizeContextRecord(snapshot.current) : null,
      trendCount: snapshot.trend.length,
      retainedRecordCount: listPersonalDjContexts(userId, 20).length
    });
  };
}

export function createRevokeCurrentPersonalDjContextHandler() {
  return (req: Request, res: Response): void => {
    const { userId } = req as AuthedRequest;
    const revoked = revokeCurrentPersonalDjContext(userId);
    res.json({ ok: true, revoked });
  };
}

function summarizeContextRecord(record: ReturnType<typeof getPersonalDjContextSnapshot>['current']) {
  if (!record) return null;
  return {
    id: record.id,
    generatedAt: record.payload.generatedAt,
    uploadedAt: record.uploadedAt,
    summary: record.payload.summary,
    sourceKind: record.sourceKind,
    sourceBundleId: record.sourceBundleId,
    sliceCount: record.sliceCount,
    musicHintCount: record.payload.musicHints.length,
    revokedAt: record.revokedAt
  };
}
