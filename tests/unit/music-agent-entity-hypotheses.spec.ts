import { describe, expect, it } from 'vitest';
import type { MusicEntityRecord } from '../../src/server/store/music-entities';
import {
  entityFromStoredRecord,
  findVerifiedAlbum,
  isVerifiedTrackEntity,
  parseEntityRecallInput,
  trackMatchesArtist,
  trackMatchesKnownEntityFields
} from '../../src/server/music-agent/entity-hypotheses';

describe('MusicAgent entity hypotheses', () => {
  it('parses explicit entities and sourced web hints without changing problem labels', () => {
    const result = parseEntityRecallInput({
      entities: [{ type: 'song', title: 'Explicit Song', artist: 'Explicit Artist', id: 123 }],
      artists: [{ name: 'Direct Artist' }],
      hints: [
        sourcedHint({ kind: 'track', name: 'Hint Track', artist: 'Hint Artist' }),
        sourcedHint({ kind: 'relationship', name: 'Scene Link', relatedName: 'Related Artist' }),
        sourcedHint({ kind: 'track', name: 'Missing Artist' }),
        sourcedHint({ kind: 'artist', name: 'Low Confidence', confidence: 0.2 }),
        { kind: 'artist', name: 'Invalid Hint' }
      ]
    });

    expect(result.entities).toEqual([
      { type: 'track', title: 'Explicit Song', artist: 'Explicit Artist', id: '123' },
      { type: 'artist', name: 'Direct Artist' },
      { type: 'track', title: 'Hint Track', artist: 'Hint Artist' },
      { type: 'artist', name: 'Related Artist' }
    ]);
    expect(result.problems).toEqual([
      'web track hint skipped: missing artist for Missing Artist',
      'web hint skipped: low confidence for Low Confidence',
      'web hint skipped: invalid sourced hint'
    ]);
  });

  it('coerces query-plan shaped entity recall input into verifiable entities', () => {
    const result = parseEntityRecallInput({
      exactTrackQueries: ['风继续吹(Live) — 张国荣', 'Candy 具島直子'],
      artistAnchors: ['AGA'],
      albumAnchors: ['miss.G — 具島直子'],
      playlistQueries: ['粤语 city pop 女声'],
      styleHints: ['city pop'],
      listeningConstraints: ['female vocal']
    });

    expect(result.entities).toEqual([
      { type: 'track', title: '风继续吹(Live)', query: '风继续吹(Live) — 张国荣', artist: '张国荣' },
      { type: 'track', title: 'Candy 具島直子', query: 'Candy 具島直子' },
      { type: 'artist', name: 'AGA' },
      { type: 'album', title: 'miss.G', query: 'miss.G — 具島直子', artist: '具島直子' },
      { type: 'playlist', name: '粤语 city pop 女声' }
    ]);
    expect(result.problems).toEqual([]);
  });

  it('keeps collaborator-aware artist matching for verified track entities', () => {
    const track = {
      id: 'track-1',
      name: 'Mayonaka no Door - Stay With Me',
      artists: ['Paris Match / 松原みき']
    };
    const primaryArtistTrack = {
      id: 'track-2',
      name: 'Memories',
      artists: ['Maroon 5', 'Wiz Khalifa']
    };

    expect(trackMatchesArtist(track, '松原みき')).toBe(true);
    expect(trackMatchesArtist(track, '竹内まりや')).toBe(false);
    expect(trackMatchesArtist(primaryArtistTrack, 'Maroon 5 / Wiz Khalifa')).toBe(true);
    expect(trackMatchesArtist({ ...primaryArtistTrack, artists: ['Wiz Khalifa'] }, 'Maroon 5 / Wiz Khalifa')).toBe(false);
    expect(isVerifiedTrackEntity({ type: 'track', title: 'Mayonaka no Door', artist: '松原みき' }, track)).toBe(true);
    expect(trackMatchesKnownEntityFields({ type: 'track', artist: '松原みき' }, track)).toBe(true);
  });

  it('maps stored records and verifies album entities by known fields', () => {
    expect(entityFromStoredRecord(storedEntity({
      type: 'track',
      title: 'City Lights',
      artist: 'Night Singer',
      providerId: 'ncm-track-1'
    }))).toEqual({
      type: 'track',
      title: 'City Lights',
      artist: 'Night Singer',
      providerId: 'ncm-track-1'
    });
    expect(entityFromStoredRecord(storedEntity({ type: 'chart_item', title: 'Chart Only' }))).toBeNull();

    const album = { id: 'album-1', name: 'Pacific Breeze', artist: 'Haruomi Hosono' };
    expect(findVerifiedAlbum({ type: 'album', title: 'Pacific', artist: 'Haruomi Hosono' }, [album])).toEqual(album);
    expect(findVerifiedAlbum({ type: 'album', title: 'Pacific', artist: 'Wrong Artist' }, [album])).toBeNull();
  });
});

function sourcedHint(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    sourceUrl: 'https://example.com/source',
    snippet: 'source snippet',
    sourceTitle: 'source title',
    confidence: 0.8,
    freshness: 'durable',
    observedAt: '2026-06-26T00:00:00.000Z',
    ...overrides
  };
}

function storedEntity(overrides: Partial<MusicEntityRecord>): MusicEntityRecord {
  return {
    userId: 'user-1',
    id: 'entity-1',
    type: 'artist',
    provider: 'catalog',
    providerId: null,
    title: null,
    artist: null,
    album: null,
    description: '',
    styleHints: [],
    constraints: [],
    sourceSignals: [],
    lastVerifiedAt: null,
    selectedCount: 0,
    skippedCount: 0,
    lastUsedAt: null,
    createdAt: '2026-06-26T00:00:00.000Z',
    updatedAt: '2026-06-26T00:00:00.000Z',
    ...overrides
  };
}
