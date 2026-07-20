import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeActions } from '../../src/server/agent/actions';
import { clearResolverCache } from '../../src/server/ncm/resolver';
import { _resetDbForTest, getDb, initDb } from '../../src/server/store/db';
import {
  createExplicitExclusion,
  findMatchingExplicitExclusion,
  listActiveExplicitExclusions
} from '../../src/server/store/explicit-exclusions';
import { getQueue, setQueue } from '../../src/server/store/queue';
import {
  beginExplicitExclusionResolutionAttempt,
  completeExplicitExclusionResolution,
  getExplicitExclusionResolutionByExclusionId
} from '../../src/server/store/explicit-exclusion-resolutions';

let dataDir: string;
const logger = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-agent-actions-v2-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  _resetDbForTest();
  initDb();
  clearResolverCache();
  setQueue('user-1', []);
});

afterEach(() => {
  _resetDbForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.CROSSFADIO_DATA_DIR;
});

describe('agent actions v2', () => {
  it('lets an explicit track request bypass legacy play pressure', async () => {
    getDb().prepare(`
      INSERT INTO plays (user_id, song_id, song_name, artist_name, started_at, ended_at, end_reason)
      VALUES ('user-1', 'track-1', 'Plastic Love', '竹内まりや', datetime('now'), datetime('now'), 'completed')
    `).run();
    const ncmClient = clientFor(track());

    await executeActions([{
      type: 'add_to_queue', pick: { query: 'Plastic Love — 竹内まりや' }, position: 'end'
    }], { userId: 'user-1', ncmClient, sourceRef: { messageId: 7 }, logger });

    expect(getQueue('user-1').map((item) => item.ncmId)).toEqual(['track-1']);
  });

  it('never lets an explicit request bypass playback eligibility', async () => {
    const ncmClient = clientFor(track({ qualitySignals: { copyright: 0 } }));

    await executeActions([{
      type: 'add_to_queue', pick: { query: 'Plastic Love — 竹内まりや' }, position: 'end'
    }], { userId: 'user-1', ncmClient, sourceRef: { messageId: 8 }, logger });

    expect(getQueue('user-1')).toEqual([]);
  });

  it('keeps explicit artist exclusions hard for direct chat actions', async () => {
    createExplicitExclusion({
      userId: 'user-1',
      entityType: 'artist',
      entityKey: '竹内まりや',
      displayName: '竹内まりや',
      sourceKind: 'listener_instruction',
      sourceRef: { messageId: 3 }
    });

    await executeActions([{
      type: 'swap_next', pick: { query: 'Plastic Love — 竹内まりや' }
    }], { userId: 'user-1', ncmClient: clientFor(track()), sourceRef: { messageId: 9 }, logger });

    expect(getQueue('user-1')).toEqual([]);
  });

  it('persists ban actions in the structured explicit-exclusion store', async () => {
    await executeActions([
      { type: 'ban_artist', artist: '某乐队' },
      { type: 'ban_track', title: 'Plastic Love', artist: '竹内まりや' }
    ], { userId: 'user-1', ncmClient: clientFor(track()), sourceRef: { messageId: 10 }, logger });

    expect(listActiveExplicitExclusions('user-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'artist', entityKey: '某乐队' }),
      expect.objectContaining({ entityType: 'track', entityKey: 'ncm:track-1', providerId: 'track-1' })
    ]));
  });

  it('keeps an ambiguous ban action pending instead of binding the first provider result', async () => {
    const first = track({ id: 'version-1' });
    const second = track({ id: 'version-2' });
    const ncmClient = {
      searchSongs: vi.fn().mockResolvedValue([first, second]),
      getSongDetails: vi.fn().mockResolvedValue([first, second])
    } as any;

    await executeActions([
      { type: 'ban_track', title: 'Plastic Love', artist: '竹内まりや' }
    ], { userId: 'user-1', ncmClient, sourceRef: { messageId: 11 }, logger });

    const exclusion = listActiveExplicitExclusions('user-1')[0]!;
    expect(exclusion).toMatchObject({ provider: null, providerId: null });
    const pendingJob = getExplicitExclusionResolutionByExclusionId(exclusion.id)!;
    expect(pendingJob).toMatchObject({
      status: 'pending', queryTitle: 'Plastic Love', queryArtist: '竹内まりや'
    });
    expect(findMatchingExplicitExclusion('user-1', first)).toBeNull();
    expect(findMatchingExplicitExclusion('user-1', second)).toBeNull();

    const attempt = beginExplicitExclusionResolutionAttempt({
      id: pendingJob.id,
      now: new Date(Date.parse(pendingJob.createdAt) + 1)
    })!;
    completeExplicitExclusionResolution({
      id: attempt.id,
      leaseToken: attempt.leaseToken!,
      track: { ncmId: 'version-1', name: 'Plastic Love', artists: ['竹内まりや'] },
      now: new Date(Date.parse(pendingJob.createdAt) + 2)
    });
    expect(findMatchingExplicitExclusion('user-1', first)).toMatchObject({
      provider: 'ncm', providerId: 'version-1'
    });
    expect(findMatchingExplicitExclusion('user-1', second)).toBeNull();
  });
});

function track(overrides: Record<string, unknown> = {}) {
  return {
    id: 'track-1',
    name: 'Plastic Love',
    artists: ['竹内まりや'],
    durationMs: 300_000,
    ...overrides
  };
}

function clientFor(detail: ReturnType<typeof track>) {
  return {
    searchSongs: vi.fn().mockResolvedValue([detail]),
    getSongDetails: vi.fn().mockResolvedValue([detail])
  } as any;
}
