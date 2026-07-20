import { describe, expect, it, vi } from 'vitest';
import {
  createPlayerListeningEpisode,
  getOrCreatePlayerInstanceId,
  listeningUserIdFromToken
} from '../../src/renderer/playerListeningEpisode.js';

describe('player Listening Episode session', () => {
  it('keeps a stable player id per session storage', () => {
    const firstTab = createMemoryStorage();
    const secondTab = createMemoryStorage();
    let sequence = 0;
    const randomId = () => `player-${++sequence}`;

    expect(getOrCreatePlayerInstanceId(firstTab, randomId)).toBe('player-1');
    expect(getOrCreatePlayerInstanceId(firstTab, randomId)).toBe('player-1');
    expect(getOrCreatePlayerInstanceId(secondTab, randomId)).toBe('player-2');
  });

  it('derives the stable account scope from the signed token subject', () => {
    const payload = btoa(JSON.stringify({ sub: 'ncm-user-42' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    expect(listeningUserIdFromToken(`header.${payload}.signature`)).toBe('ncm-user-42');
    expect(listeningUserIdFromToken('invalid')).toBeNull();
  });

  it('creates an episode only after native playing', async () => {
    const transport = {
      create: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined)
    };
    const session = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-a',
      createClientEpisodeId: () => 'episode-a',
      now: () => 1_000,
      transport
    });

    session.prepare({
      track: { id: '909', name: 'My Cookie Can', artists: ['卫兰'] },
      deckId: 'main'
    });
    await session.settle();
    expect(transport.create).not.toHaveBeenCalled();

    session.playing({ positionMs: 0, durationMs: 200_000 });
    await session.settle();

    expect(transport.create).toHaveBeenCalledTimes(1);
    expect(transport.create).toHaveBeenCalledWith('episode-a', {
      playerInstanceId: 'player-a',
      deckId: 'main',
      track: { id: '909', name: 'My Cookie Can', artists: ['卫兰'] },
      durationMs: 200_000,
      checkpointSeq: 0
    });
  });

  it('accumulates monotonic playing time independently from media position', async () => {
    let now = 1_000;
    const transport = {
      create: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined)
    };
    const session = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-a',
      createClientEpisodeId: () => 'episode-a',
      now: () => now,
      transport
    });
    session.prepare({
      track: { id: '909', name: 'My Cookie Can', artists: ['卫兰'] },
      deckId: 'main'
    });
    session.playing({ positionMs: 0, durationMs: 200_000 });
    now += 3_000;
    session.pause({ positionMs: 50_000, durationMs: 200_000 });
    now += 20_000;
    session.playing({ positionMs: 50_000, durationMs: 200_000 });
    now += 2_000;
    session.finalize('skipped', { positionMs: 60_000, durationMs: 200_000 });
    await session.settle();

    expect(transport.checkpoint).toHaveBeenCalledWith('episode-a', {
      checkpointSeq: 1,
      listenedMs: 3_000,
      positionMs: 50_000,
      durationMs: 200_000
    });
    expect(transport.finalize).toHaveBeenCalledWith('episode-a', {
      checkpointSeq: 2,
      listenedMs: 5_000,
      positionMs: 60_000,
      durationMs: 200_000,
      outcome: 'skipped'
    }, { keepalive: true });
  });

  it('sends integer millisecond checkpoints when the browser clock is fractional', async () => {
    let now = 1_000.125;
    const transport = {
      create: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined)
    };
    const session = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-a',
      createClientEpisodeId: () => 'episode-a',
      now: () => now,
      transport
    });
    session.prepare({
      track: { id: '909', name: 'My Cookie Can', artists: ['卫兰'] },
      deckId: 'main'
    });
    session.playing({ positionMs: 0, durationMs: 200_000 });
    now = 2_000.875;
    session.pause({ positionMs: 1_000, durationMs: 200_000 });
    now = 3_001.625;
    session.playing({ positionMs: 1_000, durationMs: 200_000 });
    now = 4_002.5;
    session.finalize('skipped', { positionMs: 2_000, durationMs: 200_000 });
    await session.settle();

    expect(transport.checkpoint).toHaveBeenCalledWith('episode-a', expect.objectContaining({
      listenedMs: 1_001
    }));
    expect(transport.finalize).toHaveBeenCalledWith('episode-a', expect.objectContaining({
      listenedMs: 2_002
    }), { keepalive: true });
  });

  it('checkpoints active playback every fifteen seconds', async () => {
    let now = 1_000;
    const transport = {
      create: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined)
    };
    const session = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-a',
      createClientEpisodeId: () => 'episode-a',
      now: () => now,
      transport
    });
    session.prepare({
      track: { id: '909', name: 'My Cookie Can', artists: ['卫兰'] },
      deckId: 'main'
    });
    session.playing({ positionMs: 0, durationMs: 200_000 });
    now += 14_999;
    session.progress({ positionMs: 14_999, durationMs: 200_000 });
    await session.settle();
    expect(transport.checkpoint).not.toHaveBeenCalled();

    now += 1;
    session.progress({ positionMs: 15_000, durationMs: 200_000 });
    await session.settle();
    expect(transport.checkpoint).toHaveBeenCalledWith('episode-a', {
      checkpointSeq: 1,
      listenedMs: 15_000,
      positionMs: 15_000,
      durationMs: 200_000
    });
  });

  it('forces a keepalive checkpoint when the page is hidden', async () => {
    let now = 1_000;
    const transport = {
      create: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined)
    };
    const session = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-a',
      createClientEpisodeId: () => 'episode-a',
      now: () => now,
      transport
    });
    session.prepare({
      track: { id: '909', name: 'My Cookie Can', artists: ['卫兰'] },
      deckId: 'main'
    });
    session.playing({ positionMs: 0, durationMs: 200_000 });
    now += 4_000;
    session.checkpoint(
      { positionMs: 8_000, durationMs: 200_000 },
      { keepalive: true }
    );
    await session.settle();

    expect(transport.checkpoint).toHaveBeenCalledWith(
      'episode-a',
      {
        checkpointSeq: 1,
        listenedMs: 4_000,
        positionMs: 8_000,
        durationMs: 200_000
      },
      { keepalive: true }
    );
  });

  it('sends the pagehide keepalive independently of an older hung create', async () => {
    const transport = {
      create: vi.fn(() => new Promise<void>(() => undefined)),
      checkpoint: vi.fn(async () => undefined),
      checkpointKeepalive: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined)
    };
    const session = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-pagehide',
      createClientEpisodeId: () => 'episode-pagehide',
      now: () => 5_000,
      transport
    });
    session.prepare({
      track: { id: 'pagehide-track', name: 'Pagehide Song', artists: ['Pagehide Artist'] },
      deckId: 'main'
    });
    session.playing({ positionMs: 0, durationMs: 100_000 });
    await Promise.resolve();

    session.checkpoint(
      { positionMs: 5_000, durationMs: 100_000 },
      { keepalive: true }
    );
    expect(transport.create).toHaveBeenCalledTimes(1);
    expect(transport.checkpointKeepalive).toHaveBeenCalledWith(
      'episode-pagehide',
      {
        create: expect.objectContaining({ playerInstanceId: 'player-pagehide' }),
        checkpoint: expect.objectContaining({ checkpointSeq: 1, positionMs: 5_000 })
      },
      { keepalive: true }
    );
    expect(transport.checkpoint).not.toHaveBeenCalled();
  });

  it('lets a new episode create and checkpoint while the previous episode create is hung', async () => {
    const storage = createMemoryStorage();
    let now = 1_000;
    let sequence = 0;
    const transport = {
      create: vi.fn((clientEpisodeId: string) => clientEpisodeId === 'episode-a'
        ? new Promise<void>(() => undefined)
        : Promise.resolve()),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined)
    };
    const session = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-independent-episodes',
      createClientEpisodeId: () => `episode-${++sequence === 1 ? 'a' : 'b'}`,
      now: () => now,
      transport,
      finalizationStorage: storage
    });

    session.prepare({
      track: { id: 'track-a', name: 'Song A', artists: ['Artist A'] },
      deckId: 'main'
    });
    session.playing({ positionMs: 0, durationMs: 100_000 });
    await Promise.resolve();
    session.finalize('skipped', { positionMs: 1_000, durationMs: 100_000 });
    expect(storage.values.size).toBe(1);

    session.prepare({
      track: { id: 'track-b', name: 'Song B', artists: ['Artist B'] },
      deckId: 'main'
    });
    session.playing({ positionMs: 0, durationMs: 100_000 });
    await flushMicrotasks();
    now += 15_000;
    session.progress({ positionMs: 15_000, durationMs: 100_000 });
    await flushMicrotasks();

    expect(transport.create.mock.calls.map(([clientEpisodeId]) => clientEpisodeId))
      .toContain('episode-b');
    expect(transport.checkpoint).toHaveBeenCalledWith('episode-b', {
      checkpointSeq: 1,
      listenedMs: 15_000,
      positionMs: 15_000,
      durationMs: 100_000
    });
  });

  it('retries idempotent creation before finalizing after a transient PUT failure', async () => {
    let now = 1_000;
    const transport = {
      create: vi.fn()
        .mockRejectedValueOnce(new Error('temporary network failure'))
        .mockResolvedValue(undefined),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined)
    };
    const session = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-retry',
      createClientEpisodeId: () => 'episode-retry',
      now: () => now,
      transport
    });
    session.prepare({
      track: { id: 'retry-track', name: 'Retry Song', artists: ['Retry Artist'] },
      deckId: 'main'
    });
    session.playing({ positionMs: 0, durationMs: 100_000 });
    now += 20_000;
    session.finalize('skipped', { positionMs: 20_000, durationMs: 100_000 });
    await session.settle();

    expect(transport.create).toHaveBeenCalledTimes(2);
    expect(transport.finalize).toHaveBeenCalledWith('episode-retry', {
      checkpointSeq: 1,
      listenedMs: 20_000,
      positionMs: 20_000,
      durationMs: 100_000,
      outcome: 'skipped'
    }, { keepalive: true });
  });

  it('retries the same terminal PATCH after a transient failure without recreating or overwriting it', async () => {
    let now = 1_000;
    const transport = {
      create: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn()
        .mockRejectedValueOnce(new Error('temporary PATCH failure'))
        .mockResolvedValue(undefined)
    };
    const session = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-finalize-retry',
      createClientEpisodeId: () => 'episode-finalize-retry',
      now: () => now,
      transport
    });
    session.prepare({
      track: { id: 'retry-track', name: 'Retry Song', artists: ['Retry Artist'] },
      deckId: 'main'
    });
    session.playing({ positionMs: 0, durationMs: 100_000 });
    now += 20_000;
    session.finalize('skipped', { positionMs: 20_000, durationMs: 100_000 });
    session.finalize('failed', { positionMs: 25_000, durationMs: 100_000 });
    await session.settle();

    const expectedFinalization = {
      checkpointSeq: 1,
      listenedMs: 20_000,
      positionMs: 20_000,
      durationMs: 100_000,
      outcome: 'skipped'
    };
    expect(transport.create).toHaveBeenCalledTimes(1);
    expect(transport.finalize).toHaveBeenCalledTimes(2);
    expect(transport.finalize.mock.calls).toEqual([
      ['episode-finalize-retry', expectedFinalization, { keepalive: true }],
      ['episode-finalize-retry', expectedFinalization, { keepalive: true }]
    ]);
  });

  it('replays a terminal state from the durable outbox after reload and repeated failure', async () => {
    const storage = createMemoryStorage();
    let now = 1_000;
    const failingTransport = {
      create: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => { throw new Error('offline'); })
    };
    const firstSession = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-durable',
      createClientEpisodeId: () => 'episode-durable',
      now: () => now,
      transport: failingTransport,
      finalizationStorage: storage
    });
    firstSession.prepare({
      track: { id: 'durable-track', name: 'Durable Song', artists: ['Durable Artist'] },
      deckId: 'main'
    });
    firstSession.playing({ positionMs: 0, durationMs: 100_000 });
    now += 20_000;
    firstSession.finalize('skipped', { positionMs: 20_000, durationMs: 100_000 });
    await firstSession.settle();

    expect(failingTransport.finalize).toHaveBeenCalledTimes(2);
    expect(storage.values.size).toBe(1);

    const recoveredTransport = {
      create: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined)
    };
    const recoveredSession = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-durable',
      createClientEpisodeId: () => 'unused',
      now: () => now,
      transport: recoveredTransport,
      finalizationStorage: storage
    });
    await recoveredSession.settle();

    expect(recoveredTransport.create).toHaveBeenCalledWith('episode-durable', expect.objectContaining({
      playerInstanceId: 'player-durable',
      track: { id: 'durable-track', name: 'Durable Song', artists: ['Durable Artist'] }
    }));
    expect(recoveredTransport.finalize).toHaveBeenCalledWith(
      'episode-durable',
      expect.objectContaining({ outcome: 'skipped', positionMs: 20_000, listenedMs: 20_000 }),
      { keepalive: true }
    );
    expect(storage.values.size).toBe(0);
  });

  it('replays the same user terminal outbox from a different tab player id', async () => {
    const storage = createMemoryStorage();
    const firstSession = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'old-tab',
      createClientEpisodeId: () => 'episode-old-tab',
      now: () => 1_000,
      transport: {
        create: vi.fn(async () => undefined),
        checkpoint: vi.fn(async () => undefined),
        finalize: vi.fn(async () => { throw new Error('offline'); })
      },
      finalizationStorage: storage
    });
    firstSession.prepare({
      track: { id: 'cross-tab-track', name: 'Cross-tab Song', artists: ['Cross-tab Artist'] },
      deckId: 'main'
    });
    firstSession.playing({ positionMs: 0, durationMs: 100_000 });
    firstSession.finalize('interrupted', { positionMs: 5_000, durationMs: 100_000 });
    await firstSession.settle();

    const recoveredTransport = {
      create: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined)
    };
    const recoveredSession = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'new-tab',
      createClientEpisodeId: () => 'unused',
      now: () => 2_000,
      transport: recoveredTransport,
      finalizationStorage: storage
    });
    await recoveredSession.settle();

    expect(recoveredTransport.create).toHaveBeenCalledWith(
      'episode-old-tab',
      expect.objectContaining({ playerInstanceId: 'old-tab' })
    );
    expect(recoveredTransport.finalize).toHaveBeenCalledWith(
      'episode-old-tab',
      expect.objectContaining({ outcome: 'interrupted' }),
      { keepalive: true }
    );
    expect(storage.values.size).toBe(0);
  });

  it('persists the terminal outbox entry before a hung create request can block delivery', async () => {
    const storage = createMemoryStorage();
    let now = 1_000;
    const transport = {
      create: vi.fn(() => new Promise<void>(() => undefined)),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined)
    };
    const session = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-hung',
      createClientEpisodeId: () => 'episode-hung',
      now: () => now,
      transport,
      finalizationStorage: storage
    });
    session.prepare({
      track: { id: 'hung-track', name: 'Hung Song', artists: ['Hung Artist'] },
      deckId: 'main'
    });
    session.playing({ positionMs: 0, durationMs: 100_000 });
    await Promise.resolve();

    now += 5_000;
    session.finalize('skipped', { positionMs: 5_000, durationMs: 100_000 });

    expect(storage.values.size).toBe(1);
    expect([...storage.values.values()][0]).toContain('episode-hung');
  });

  it('retries a durable finalization independently of an older hung delivery', async () => {
    const storage = createMemoryStorage();
    const failingTransport = {
      create: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => { throw new Error('offline'); })
    };
    const firstSession = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-retry-hung',
      createClientEpisodeId: () => 'episode-retry-hung',
      now: () => 1_000,
      transport: failingTransport,
      finalizationStorage: storage
    });
    firstSession.prepare({
      track: { id: 'retry-track', name: 'Retry Song', artists: ['Retry Artist'] },
      deckId: 'main'
    });
    firstSession.playing({ positionMs: 0, durationMs: 100_000 });
    firstSession.finalize('skipped', { positionMs: 5_000, durationMs: 100_000 });
    await firstSession.settle();

    const hungTransport = {
      create: vi.fn(() => new Promise<void>(() => undefined)),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined)
    };
    const recoveredSession = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-retry-hung',
      createClientEpisodeId: () => 'unused',
      now: () => 1_000,
      transport: hungTransport,
      finalizationStorage: storage
    });
    await Promise.resolve();
    recoveredSession.retryPendingFinalizations();
    await Promise.resolve();

    expect(hungTransport.create).toHaveBeenCalledTimes(2);
  });

  it('never replays another account\'s terminal outbox entries', async () => {
    const storage = createMemoryStorage();
    const failingTransport = {
      create: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => { throw new Error('offline'); })
    };
    const firstSession = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'shared-tab',
      createClientEpisodeId: () => 'episode-user-a',
      now: () => 1_000,
      transport: failingTransport,
      finalizationStorage: storage
    });
    firstSession.prepare({
      track: { id: 'private-track', name: 'Private Song', artists: ['Private Artist'] },
      deckId: 'main'
    });
    firstSession.playing({ positionMs: 0, durationMs: 100_000 });
    firstSession.finalize('skipped', { positionMs: 5_000, durationMs: 100_000 });
    await firstSession.settle();

    const otherTransport = {
      create: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined)
    };
    const otherSession = createPlayerListeningEpisode({
      userId: 'user-b',
      playerInstanceId: 'shared-tab',
      createClientEpisodeId: () => 'unused',
      now: () => 1_000,
      transport: otherTransport,
      finalizationStorage: storage
    });
    await otherSession.settle();

    expect(otherTransport.create).not.toHaveBeenCalled();
    expect(otherTransport.finalize).not.toHaveBeenCalled();
  });

  it('starts a new episode when native playback recovers after a terminal media failure', async () => {
    let sequence = 0;
    let now = 1_000;
    const transport = {
      create: vi.fn(async () => undefined),
      checkpoint: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined)
    };
    const session = createPlayerListeningEpisode({
      userId: 'user-a',
      playerInstanceId: 'player-recovered',
      createClientEpisodeId: () => `episode-${++sequence}`,
      now: () => now,
      transport
    });
    session.prepare({
      track: { id: 'recover-track', name: 'Recover Song', artists: ['Recover Artist'] },
      deckId: 'main'
    });
    session.playing({ positionMs: 0, durationMs: 100_000 });
    now += 5_000;
    session.finalize('failed', { positionMs: 5_000, durationMs: 100_000 });
    await session.settle();

    now += 1_000;
    session.playing({ positionMs: 5_000, durationMs: 100_000 });
    now += 10_000;
    session.finalize('completed', { positionMs: 100_000, durationMs: 100_000 });
    await session.settle();

    expect(transport.create.mock.calls.map(([clientEpisodeId]) => clientEpisodeId))
      .toEqual(['episode-1', 'episode-2']);
    expect(transport.finalize).toHaveBeenNthCalledWith(
      2,
      'episode-2',
      expect.objectContaining({ outcome: 'completed', listenedMs: 10_000 }),
      { keepalive: true }
    );
  });
});

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    }
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
