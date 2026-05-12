import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractQueueDirectiveFromText } from '../../src/server/http/chat-sse-worker';
import { buildDiscoveryModePromptParts, buildTrackDedupeKey, getCandidateSourceMix, parseDjCandidatePicks, serializeDjPickNextErrorForLog, searchCandidates } from '../../src/server/http/routes/djNext';
import { LlmError } from '../../src/server/llm/client';
import type { NcmClient } from '../../src/server/ncm/client';
import type { NcmSong } from '../../src/shared/schema';

// ── Helpers ────────────────────────────────────────────────────────────────

const root = process.cwd();

function makeSong(id: number, name: string, artist: string): NcmSong {
  return { id, name, artists: [artist] };
}

function mockNcmClient(songMap: Record<string, NcmSong[]>): Pick<NcmClient, 'searchSongs'> {
  return {
    searchSongs: vi.fn(async (keywords: string) => songMap[keywords] ?? [])
  };
}

// ── serializeDjPickNextErrorForLog ─────────────────────────────────────────

describe('DJ pick-next diagnostics', () => {
  it('keeps LLM HTTP details in structured log payloads', () => {
    const error = new LlmError(
      'LLM request failed: 400 Bad Request; response body: {"error":{"message":"bad schema"}}',
      {
        status: 400,
        statusText: 'Bad Request',
        responseBody: '{"error":{"message":"bad schema"}}'
      }
    );

    expect(serializeDjPickNextErrorForLog(error)).toEqual({
      name: 'LlmError',
      message: 'LLM request failed: 400 Bad Request; response body: {"error":{"message":"bad schema"}}',
      status: 400,
      statusText: 'Bad Request',
      responseBody: '{"error":{"message":"bad schema"}}'
    });
  });

  it('includes exclusion lists in DJ debug events for browser diagnostics', () => {
    const source = fs.readFileSync(path.join(root, 'src/server/http/routes/djNext.ts'), 'utf-8');

    expect(source).toContain('excludedIds: Array.from(excludeState.ids)');
    expect(source).toContain('excludedDedupeKeys: Array.from(excludeState.dedupeKeys)');
  });
});

describe('DJ discovery mode prompt parts', () => {
  const tasteHints = ['该用户的音乐品味偏好：粤语流行、City Pop、陈奕迅'];

  it('uses personal taste as an expansion seed in explore mode', () => {
    const parts = buildDiscoveryModePromptParts('explore', tasteHints);

    expect(parts.tasteContext).toContain('品味外延');
    expect(parts.styleInstruction).toContain('今日主题、时间、天气');
    expect(parts.pickInstruction).toContain('有可解释连接');
    expect(parts.pickInstruction).not.toContain('优先选择符合用户品味偏好的歌曲');
  });

  it('keeps personal taste as a strong anchor in comfort mode', () => {
    const parts = buildDiscoveryModePromptParts('comfort', tasteHints);

    expect(parts.tasteContext).toContain('个人品味锚点');
    expect(parts.styleInstruction).toContain('优先推荐符合该用户品味偏好的风格和艺人');
    expect(parts.pickInstruction).toContain('优先选择符合用户品味偏好的歌曲');
  });
});

describe('DJ candidate source mix', () => {
  it('uses fewer liked-song candidates in explore mode than comfort mode', () => {
    const explore = getCandidateSourceMix('explore');
    const comfort = getCandidateSourceMix('comfort');

    expect(explore.likedSampleSize).toBeLessThan(comfort.likedSampleSize);
    expect(explore.likedSampleSize).toBeLessThanOrEqual(Math.floor(explore.searchResultSize / 4));
    expect(explore.preferSearchCandidates).toBe(true);
    expect(comfort.preferSearchCandidates).toBe(false);
  });
});

describe('chat queue directives', () => {
  it('documents queue.activeDirective as a set_pref action in the chat intent prompt', () => {
    const source = fs.readFileSync(path.join(root, 'src/server/agent/modes.ts'), 'utf-8');

    expect(source).toContain('queue.activeDirective');
    expect(source).toContain('"ttlHours": 6');
    expect(source).toContain('{ "type": "set_pref", "key": "queue.activeDirective", "value": null }');
  });

  it('extracts a short-lived female-vocal directive from casual chat text', () => {
    const directive = extractQueueDirectiveFromText(
      '这个下午多来点女歌手吧，才休息一天就上班有点累了',
      new Date('2026-05-11T06:00:00.000Z')
    );

    expect(directive?.text).toContain('女声');
    expect(directive?.text).toContain('女歌手');
    expect(directive?.expiresAt).toBe('2026-05-11T12:00:00.000Z');
  });

  it('treats explicit negative wording as clearing the female-vocal directive', () => {
    const directive = extractQueueDirectiveFromText('先不要女声了', new Date('2026-05-11T06:00:00.000Z'));

    expect(directive).toEqual({ text: '', expiresAt: '2026-05-11T06:00:00.000Z' });
  });
});

// ── searchCandidates ───────────────────────────────────────────────────────

describe('searchCandidates', () => {
  it('returns empty array when given no queries', async () => {
    const ncm = mockNcmClient({});
    const result = await searchCandidates([], ncm as unknown as NcmClient, new Set(), 20);
    expect(result).toEqual([]);
    expect(ncm.searchSongs).not.toHaveBeenCalled();
  });

  it('maps NcmSong id+name+artists into Track shape', async () => {
    const ncm = mockNcmClient({
      '周杰伦': [makeSong(123, '夜曲', '周杰伦')]
    });
    const result = await searchCandidates(['周杰伦'], ncm as unknown as NcmClient, new Set(), 20);
    expect(result).toEqual([{ id: '123', name: '夜曲', artist: '周杰伦' }]);
  });

  it('excludes tracks whose id is in excludeIds', async () => {
    const ncm = mockNcmClient({
      '民谣': [makeSong(1, '成都', '赵雷'), makeSong(2, '理想三旬', '陈鸿宇')]
    });
    const result = await searchCandidates(['民谣'], ncm as unknown as NcmClient, new Set(['1']), 20);
    expect(result.map((t) => t.id)).toEqual(['2']);
  });

  it('deduplicates tracks that appear in multiple query results', async () => {
    const ncm = mockNcmClient({
      'query1': [makeSong(10, 'A', 'X'), makeSong(11, 'B', 'Y')],
      'query2': [makeSong(11, 'B', 'Y'), makeSong(12, 'C', 'Z')]
    });
    const result = await searchCandidates(['query1', 'query2'], ncm as unknown as NcmClient, new Set(), 20);
    const ids = result.map((t) => t.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('excludes same song by normalized title and primary artist even when NCM ids differ', async () => {
    const ncm = mockNcmClient({
      'Bob Marley': [
        makeSong(25702070, 'Three Little Birds', 'Bob Marley'),
        makeSong(100, 'Could You Be Loved', 'Bob Marley')
      ]
    });
    const excludedKey = buildTrackDedupeKey({
      name: 'Three Little Birds',
      artist: 'Bob Marley / The Wailers'
    });

    const result = await searchCandidates(
      ['Bob Marley'],
      ncm as unknown as NcmClient,
      new Set(['2066898431']),
      20,
      undefined,
      new Set([excludedKey])
    );

    expect(result.map((track) => track.id)).toEqual(['100']);
  });

  it('respects the limit and stops collecting once reached', async () => {
    const songs = Array.from({ length: 30 }, (_, i) => makeSong(i + 1, `Song${i}`, 'X'));
    const ncm = mockNcmClient({ 'pop': songs });
    const result = await searchCandidates(['pop'], ncm as unknown as NcmClient, new Set(), 5);
    expect(result).toHaveLength(5);
  });

  it('spreads the per-query limit across multiple queries', async () => {
    // With limit=20 and 2 queries → perQuery = ceil(25/2) = 13
    // Both queries return results → should combine up to 20
    const songs1 = Array.from({ length: 13 }, (_, i) => makeSong(i + 1, `A${i}`, 'X'));
    const songs2 = Array.from({ length: 13 }, (_, i) => makeSong(i + 100, `B${i}`, 'Y'));
    const ncm = mockNcmClient({ 'q1': songs1, 'q2': songs2 });
    const result = await searchCandidates(['q1', 'q2'], ncm as unknown as NcmClient, new Set(), 20);
    expect(result).toHaveLength(20);
    // results should include tracks from both queries
    const fromQ1 = result.filter((t) => parseInt(t.id) < 100);
    const fromQ2 = result.filter((t) => parseInt(t.id) >= 100);
    expect(fromQ1.length).toBeGreaterThan(0);
    expect(fromQ2.length).toBeGreaterThan(0);
  });

  it('returns empty array when NCM search throws (error is swallowed)', async () => {
    const ncm: Pick<NcmClient, 'searchSongs'> = {
      searchSongs: vi.fn().mockRejectedValue(new Error('NCM unavailable'))
    };
    const result = await searchCandidates(['test'], ncm as unknown as NcmClient, new Set(), 20);
    expect(result).toEqual([]);
  });

  it('joins multiple artists with " / "', async () => {
    const ncm = mockNcmClient({
      'collab': [{ id: 42, name: 'Track', artists: ['Artist A', 'Artist B'] }]
    });
    const result = await searchCandidates(['collab'], ncm as unknown as NcmClient, new Set(), 20);
    expect(result[0].artist).toBe('Artist A / Artist B');
  });
});

// ── parseDjCandidatePicks ──────────────────────────────────────────────────

describe('parseDjCandidatePicks', () => {
  const candidates = [
    { id: '101', name: '候选一', artist: '歌手一' },
    { id: '202', name: '候选二', artist: '歌手二' },
    { id: '303', name: '候选三', artist: '歌手三' }
  ];

  it('keeps only IDs that exist in the candidate pool', () => {
    const parsed = parseDjCandidatePicks(
      JSON.stringify({
        say: '选两首',
        pickIds: ['202', '999', '303']
      }),
      candidates
    );

    expect(parsed.say).toBe('选两首');
    expect(parsed.tracks.map((track) => track.id)).toEqual(['202', '303']);
  });

  it('maps 1-based candidate indexes to whitelisted candidate tracks', () => {
    const parsed = parseDjCandidatePicks(
      JSON.stringify({
        say: '按编号选',
        picks: [2, 4, 1]
      }),
      candidates
    );

    expect(parsed.tracks.map((track) => track.id)).toEqual(['202', '101']);
  });
});
