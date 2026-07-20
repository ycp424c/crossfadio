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

describe('persistent SSE recovery handshake', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    _resetEventClientsForTests();
    vi.useRealTimers();
  });

  it('sends the authoritative queue and recent Journey history on every connection', () => {
    const writes: string[] = [];
    let close: (() => void) | undefined;
    const response = {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => {
        writes.push(chunk);
        return true;
      }),
      on: vi.fn((event: string, listener: () => void) => {
        if (event === 'close') close = listener;
      })
    };

    createSseEventsHandler()({ userId: 'user-1' } as never, response as never);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('event: connected');
    expect(JSON.parse(writes[0].match(/data: (.*)\n\n/)?.[1] ?? '{}')).toEqual({
      userId: 'user-1',
      ...recoverySnapshot,
      journeys: [journeySnapshot]
    });
    close?.();
  });
});
