import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recoverySnapshot = vi.hoisted(() => ({
  queue: [{ ncmId: 'track-1', name: 'Recovered track' }],
  currentIndex: 0,
  revision: 7
}));

const journeySnapshot = vi.hoisted(() => ({
  schemaVersion: 1 as const,
  runId: 'run-recovered',
  journeyVersion: 1,
  revision: 2,
  status: 'completed' as const,
  summary: '这一轮已经选好。',
  startedAt: '2026-07-20T04:00:00.000Z',
  updatedAt: '2026-07-20T04:00:02.000Z',
  completedAt: '2026-07-20T04:00:02.000Z',
  stages: [],
  candidates: [],
  selections: [],
  narration: { status: 'pending' as const }
}));

vi.mock('../../src/server/store/queue.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/server/store/queue.js')>(),
  getQueueStateSnapshot: vi.fn(() => recoverySnapshot)
}));

vi.mock('../../src/server/store/selection-journeys.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/server/store/selection-journeys.js')>(),
  listRecentSelectionJourneys: vi.fn(() => [{ snapshot: journeySnapshot }])
}));

import { createSseEventsHandler, _resetEventClientsForTests } from '../../src/server/http/routes/sse-events';
import { loadAllowlist } from '../../src/server/allowlist';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(() => {
  vi.useFakeTimers();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-sse-caps-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  fs.writeFileSync(path.join(dataDir, 'allowlist.json'), '["priority-user"]');
  loadAllowlist();
});

afterEach(() => {
  _resetEventClientsForTests();
  vi.useRealTimers();
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

function makeResponse() {
  const state: {
    writes: string[];
    close?: () => void;
  } = { writes: [] };
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    writeHead: vi.fn(() => response),
    write: vi.fn((chunk: string) => {
      state.writes.push(chunk);
      return true;
    }),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'close') state.close = listener;
    }),
    set: vi.fn((name: string, value: string) => {
      response.headers[name] = value;
      return response;
    }),
    status: vi.fn((code: number) => {
      response.statusCode = code;
      return response;
    }),
    json: vi.fn((body: unknown) => {
      response.body = body;
      return response;
    })
  };
  return { response, state };
}

describe('persistent SSE recovery handshake', () => {
  it('sends the authoritative queue and recent Journey history on every connection', () => {
    const { response, state } = makeResponse();

    createSseEventsHandler()({ userId: 'user-1' } as never, response as never);

    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toContain('event: connected');
    expect(JSON.parse(state.writes[0].match(/data: (.*)\n\n/)?.[1] ?? '{}')).toEqual({
      userId: 'user-1',
      ...recoverySnapshot,
      journeys: [journeySnapshot]
    });
    state.close?.();
  });
});

describe('persistent SSE connection caps', () => {
  it('rejects a second persistent connection for a standard user with JSON 429 before SSE init', () => {
    const first = makeResponse();
    createSseEventsHandler()({ userId: 'standard-user' } as never, first.response as never);
    expect(first.response.writeHead).toHaveBeenCalledTimes(1);

    const second = makeResponse();
    createSseEventsHandler()({ userId: 'standard-user' } as never, second.response as never);

    expect(second.response.writeHead).not.toHaveBeenCalled();
    expect(second.response.statusCode).toBe(429);
    expect(second.response.headers['Retry-After']).toBeDefined();
    expect(second.response.body).toMatchObject({
      ok: false,
      error: 'resource_limited',
      reason: 'event_connection_limit_exceeded',
      operation: 'event_sse'
    });
  });

  it('releases a connection exactly once when the stream closes', () => {
    const first = makeResponse();
    createSseEventsHandler()({ userId: 'standard-user' } as never, first.response as never);
    expect(first.response.writeHead).toHaveBeenCalledTimes(1);

    // The closed stream frees the single standard slot.
    first.state.close?.();
    const second = makeResponse();
    createSseEventsHandler()({ userId: 'standard-user' } as never, second.response as never);
    expect(second.response.writeHead).toHaveBeenCalledTimes(1);
    expect(second.response.statusCode).toBe(200);

    // Closing again is a no-op: the count must not go negative or double-release.
    first.state.close?.();
  });

  it('allows a priority user to hold three connections and rejects the fourth', () => {
    const connections = [makeResponse(), makeResponse(), makeResponse()];
    for (const { response } of connections) {
      createSseEventsHandler()({ userId: 'priority-user' } as never, response as never);
      expect(response.writeHead).toHaveBeenCalledTimes(1);
    }

    const fourth = makeResponse();
    createSseEventsHandler()({ userId: 'priority-user' } as never, fourth.response as never);
    expect(fourth.response.writeHead).not.toHaveBeenCalled();
    expect(fourth.response.statusCode).toBe(429);
  });

  it('does not count rejected connections against the limit', () => {
    const first = makeResponse();
    createSseEventsHandler()({ userId: 'standard-user' } as never, first.response as never);
    const rejected = makeResponse();
    createSseEventsHandler()({ userId: 'standard-user' } as never, rejected.response as never);
    expect(rejected.response.statusCode).toBe(429);

    // The rejected request must not have registered a client: closing the first
    // connection restores the standard slot.
    first.state.close?.();
    const third = makeResponse();
    createSseEventsHandler()({ userId: 'standard-user' } as never, third.response as never);
    expect(third.response.writeHead).toHaveBeenCalledTimes(1);
  });
});
