import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-listening-store-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  const { initDb } = await import('../../src/server/store/db.js');
  initDb();
});

afterEach(async () => {
  const { _resetDbForTest } = await import('../../src/server/store/db.js');
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('Listening Episode store maintenance', () => {
  it('interrupts an open episode only after twenty-four hours without a checkpoint', async () => {
    const {
      cleanupStaleListeningEpisodes,
      createListeningEpisode,
      getListeningEpisode
    } = await import('../../src/server/store/listening-episodes.js');
    const startedAt = new Date('2026-07-17T00:00:00.000Z');
    createListeningEpisode('user-a', 'episode-a', {
      playerInstanceId: 'player-a',
      deckId: 'main',
      track: { id: '909', name: 'My Cookie Can', artists: ['卫兰'] },
      durationMs: 200_000,
      checkpointSeq: 0
    }, { now: startedAt });

    expect(cleanupStaleListeningEpisodes(new Date('2026-07-17T23:59:59.000Z'))).toBe(0);
    expect(getListeningEpisode('user-a', 'episode-a')?.outcome).toBeNull();

    expect(cleanupStaleListeningEpisodes(new Date('2026-07-18T00:00:01.000Z'))).toBe(1);
    expect(getListeningEpisode('user-a', 'episode-a')).toEqual(expect.objectContaining({
      outcome: 'interrupted',
      endedAt: '2026-07-18T00:00:01.000Z'
    }));
  });

  it('rejects an implausible listened-time jump without changing the episode', async () => {
    const {
      checkpointListeningEpisode,
      createListeningEpisode,
      getListeningEpisode
    } = await import('../../src/server/store/listening-episodes.js');
    const startedAt = new Date('2026-07-17T00:00:00.000Z');
    createListeningEpisode('user-a', 'episode-guard', {
      playerInstanceId: 'player-a',
      deckId: 'main',
      track: { id: '909', name: 'My Cookie Can', artists: ['卫兰'] },
      durationMs: 200_000,
      checkpointSeq: 0
    }, { now: startedAt });

    const rejected = checkpointListeningEpisode('user-a', 'episode-guard', {
      checkpointSeq: 1,
      positionMs: 120_000,
      listenedMs: 45_000,
      durationMs: 200_000
    }, { now: new Date('2026-07-17T00:00:10.000Z') });

    expect(rejected.status).toBe('conflict');
    expect(getListeningEpisode('user-a', 'episode-guard')).toEqual(expect.objectContaining({
      checkpointSeq: 0,
      listenedMs: 0,
      positionMs: 0
    }));
  });

  it('loads a bounded time window without future-started or future-ended episodes', async () => {
    const {
      createListeningEpisode,
      listListeningEpisodesInWindow
    } = await import('../../src/server/store/listening-episodes.js');
    const { getDb } = await import('../../src/server/store/db.js');
    const createAt = (id: string, now: string) => createListeningEpisode('user-window', id, {
      playerInstanceId: 'player-a',
      deckId: 'main',
      track: { id, name: `Song ${id}`, artists: ['Artist'] },
      durationMs: 200_000,
      checkpointSeq: 0
    }, { now: new Date(now) });

    createAt('accepted', '2026-07-17T10:00:00.000Z');
    createAt('future-start', '2026-07-17T13:00:00.000Z');
    createAt('future-end', '2026-07-17T11:00:00.000Z');
    getDb().prepare(`
      UPDATE listening_episodes
      SET outcome = 'skipped', ended_at = ?
      WHERE user_id = ? AND client_episode_id = ?
    `).run('2026-07-17T13:01:00.000Z', 'user-window', 'future-end');

    const episodes = listListeningEpisodesInWindow('user-window', {
      since: new Date('2026-07-16T12:00:00.000Z'),
      until: new Date('2026-07-17T12:00:00.000Z'),
      limit: 10
    });

    expect(episodes.map((episode) => episode.clientEpisodeId)).toEqual(['accepted']);
  });

  it('enforces a per-user UTC-day quota while keeping retries idempotent', async () => {
    const { createListeningEpisode } = await import(
      '../../src/server/store/listening-episodes.js'
    );
    const now = new Date('2026-07-17T12:00:00.000Z');
    const input = {
      playerInstanceId: 'player-quota',
      deckId: 'main',
      track: { id: 'quota-track', name: 'Quota Song', artists: ['Artist'] },
      durationMs: 200_000,
      checkpointSeq: 0 as const
    };

    for (let index = 0; index < 500; index += 1) {
      expect(createListeningEpisode('quota-user', `episode-${index}`, input, { now }).status)
        .toBe('accepted');
    }

    expect(createListeningEpisode('quota-user', 'episode-overflow', input, { now })).toEqual({
      status: 'quota_exceeded',
      created: false,
      conflict: false,
      episode: null,
      quotaResetsAt: '2026-07-18T00:00:00.000Z'
    });
    expect(createListeningEpisode('quota-user', 'episode-0', input, { now })).toEqual(
      expect.objectContaining({ status: 'accepted', created: false, conflict: false })
    );
    expect(createListeningEpisode('other-user', 'episode-overflow', input, { now }).status)
      .toBe('accepted');
    expect(createListeningEpisode(
      'quota-user',
      'episode-next-day',
      input,
      { now: new Date('2026-07-18T00:00:00.000Z') }
    ).status).toBe('accepted');
  });
});
