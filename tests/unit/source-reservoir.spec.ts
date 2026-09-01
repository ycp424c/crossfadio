import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-source-reservoir-'));
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

describe('Source Reservoir', () => {
  it('120 分钟内阻止自主重复抓取，但显式请求可绕过', async () => {
    const reservoir = await import('../../src/server/store/source-reservoir.js');
    const identity = reservoir.buildSourceReservoirIdentity({
      sourceKind: 'search',
      sourceRef: ' 深夜   爵士 '
    });
    reservoir.recordSourceReservoirFetch({
      userId: 'user-1',
      runId: 'run-1',
      identity,
      displayName: '深夜爵士',
      candidateSource: 'search',
      provenanceKind: 'exact_recall',
      tracks: [track('1')],
      fetchedAt: new Date('2026-09-01T01:00:00.000Z')
    });

    expect(reservoir.isSourceReservoirFetchAvailable({
      userId: 'user-1', identity, requestKind: 'autonomous',
      now: new Date('2026-09-01T02:59:59.999Z')
    })).toBe(false);
    expect(reservoir.isSourceReservoirFetchAvailable({
      userId: 'user-1', identity, requestKind: 'autonomous',
      now: new Date('2026-09-01T03:00:00.000Z')
    })).toBe(true);
    expect(reservoir.isSourceReservoirFetchAvailable({
      userId: 'user-1', identity, requestKind: 'explicit_request',
      now: new Date('2026-09-01T01:01:00.000Z')
    })).toBe(true);
  });

  it('跨轮返回未消费候选，成功消费后从所有来源成员关系中移除', async () => {
    const reservoir = await import('../../src/server/store/source-reservoir.js');
    const first = reservoir.buildSourceReservoirIdentity({ sourceKind: 'playlist', sourceRef: 'p-1' });
    const second = reservoir.buildSourceReservoirIdentity({ sourceKind: 'search', sourceRef: 'city pop' });
    for (const [identity, tracks] of [
      [first, [track('shared'), track('p-only')]],
      [second, [track('shared'), track('s-only')]]
    ] as const) {
      reservoir.recordSourceReservoirFetch({
        userId: 'user-1', runId: 'run-1', identity,
        displayName: identity.sourceRef,
        candidateSource: identity.sourceKind === 'playlist' ? 'playlist' : 'search',
        provenanceKind: identity.sourceKind === 'playlist' ? 'playlist' : 'exact_recall',
        tracks: [...tracks], fetchedAt: new Date('2026-09-01T01:00:00.000Z')
      });
    }

    const beforeConsumption = reservoir.listSourceReservoir({
      userId: 'user-1', now: new Date('2026-09-01T01:30:00.000Z')
    }).flatMap((source) => source.tracks.map((item) => String(item.id)));
    expect(beforeConsumption).toHaveLength(4);
    expect(beforeConsumption).toEqual(expect.arrayContaining(['shared', 'shared', 'p-only', 's-only']));

    expect(reservoir.consumeSourceReservoirTracks({
      userId: 'user-1', runId: 'run-2', trackIds: ['shared'],
      consumedAt: '2026-09-01T01:31:00.000Z'
    })).toBe(2);
    expect(reservoir.listSourceReservoir({
      userId: 'user-1', now: new Date('2026-09-01T01:32:00.000Z')
    }).flatMap((source) => source.tracks.map((item) => String(item.id))).sort())
      .toEqual(['p-only', 's-only'].sort());
  });

  it('来源最多保留 30 首、用户最多保留 200 首并在两小时后过期', async () => {
    const reservoir = await import('../../src/server/store/source-reservoir.js');
    for (let sourceIndex = 0; sourceIndex < 7; sourceIndex += 1) {
      const identity = reservoir.buildSourceReservoirIdentity({
        sourceKind: 'search', sourceRef: `query-${sourceIndex}`
      });
      reservoir.recordSourceReservoirFetch({
        userId: 'user-1', runId: `run-${sourceIndex}`, identity,
        displayName: identity.sourceRef, candidateSource: 'search',
        provenanceKind: 'exact_recall',
        tracks: Array.from({ length: 35 }, (_, index) => track(`${sourceIndex}-${index}`)),
        fetchedAt: new Date(Date.parse('2026-09-01T01:00:00.000Z') + sourceIndex * 1_000)
      });
    }

    const active = reservoir.listSourceReservoir({
      userId: 'user-1', now: new Date('2026-09-01T01:30:00.000Z')
    });
    expect(active.flatMap((source) => source.tracks)).toHaveLength(200);
    expect(active.every((source) => source.tracks.length <= 30)).toBe(true);
    expect(reservoir.listSourceReservoir({
      userId: 'user-1', now: new Date('2026-09-01T03:01:00.000Z')
    })).toEqual([]);
  });

  it('成功抓取但没有可用候选时仍记录来源冷却', async () => {
    const now = new Date('2026-09-01T01:00:00.000Z');
    const searchSongs = vi.fn(async () => [
      { id: 'wrong-track', name: 'Wrong Song', artists: ['Wrong Artist'], durationMs: 180_000 }
    ]);
    const { CandidatePool } = await import('../../src/server/music-agent/candidates.js');
    const { recallFromEntity } = await import('../../src/server/music-agent/entity-recall.js');
    const input = {
      entity: { type: 'track' as const, title: 'Wanted Song', artist: 'Wanted Artist' },
      ncmClient: {
        getLikedSongIds: vi.fn(async () => []),
        getSongDetails: vi.fn(async () => []),
        searchSongs,
        getPlaylistDetail: vi.fn(async () => null)
      },
      candidatePool: new CandidatePool(),
      context: musicAgentContext(),
      limit: 3,
      searchLimit: 3,
      consumeNcmSearch: vi.fn(() => true),
      consumePlaylistFetch: vi.fn(() => true),
      provenanceKind: 'verified_entity' as const,
      sourceReservoir: {
        userId: 'user-1',
        runId: 'run-1',
        requestKind: 'autonomous' as const,
        now
      }
    };

    const first = await recallFromEntity(input);
    const second = await recallFromEntity({
      ...input,
      sourceReservoir: { ...input.sourceReservoir, runId: 'run-2', now: new Date(now.getTime() + 60_000) }
    });

    expect(first.fetchedSourceCount).toBe(1);
    expect(second.problems).toContain(
      'search source Wanted Song Wanted Artist is still inside the 120-minute reservoir window'
    );
    expect(searchSongs).toHaveBeenCalledTimes(1);
  });
});

function track(id: string) {
  return {
    id,
    name: `Song ${id}`,
    artists: [`Artist ${id}`],
    durationMs: 180_000,
    coverImgUrl: `https://example.com/${id}.jpg`
  };
}

function musicAgentContext() {
  return {
    request: 'auto-fill' as const,
    discoveryMode: 'explore' as const,
    currentUserText: '',
    currentMoment: { localTime: '周二 09:00', daypart: '上午', weather: null },
    activeDirective: '',
    tasteSummary: '',
    recentPreferenceSummary: '',
    recentPlaySignals: '',
    queueStateSummary: '',
    bannedSummary: ''
  };
}
