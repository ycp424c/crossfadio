import { describe, expect, it } from 'vitest';
import { selectDiverseBatch } from '../../src/server/music-agent/selection-policy/batch.js';
import type { MusicCandidate } from '../../src/server/music-agent/schema.js';

describe('selection policy batch', () => {
  it('diversifies by primary artist without treating collaborators as the primary artist', () => {
    const selected = selectDiverseBatch([
      candidate('lead-a', 'Lead Artist / Guest Artist', 'search'),
      candidate('guest-lead', 'Guest Artist / Other Artist', 'playlist'),
      candidate('lead-repeat', 'Lead Artist / Different Guest', 'trend')
    ], 2);

    expect(selected.map((item) => item.id)).toEqual(['lead-a', 'guest-lead']);
  });

  it('relaxes the primary-artist limit only when it is needed to fill the batch', () => {
    const decisions: string[] = [];
    const selected = selectDiverseBatch([
      candidate('lead-a', 'Lead Artist', 'search'),
      candidate('guest-lead', 'Guest Artist', 'playlist'),
      candidate('lead-repeat', 'Lead Artist', 'trend')
    ], 3, {
      recordDecision: (item, decision) => {
        decisions.push(`${item.id}:${decision.action}:${decision.reasonCodes[0]}`);
      }
    });

    expect(selected.map((item) => item.id)).toEqual(['lead-a', 'guest-lead', 'lead-repeat']);
    expect(decisions).toContain('lead-repeat:defer:batch_primary_artist_repeat');
    expect(decisions).toContain('lead-repeat:select:batch_selected');
  });

  it('uses source diversity as a deferral and fills from the same source only when needed', () => {
    const selected = selectDiverseBatch([
      candidate('search-1', 'Artist One', 'search'),
      candidate('search-2', 'Artist Two', 'search'),
      candidate('liked-1', 'Artist Three', 'liked')
    ], 3, { maxPerSource: 1 });

    expect(selected.map((item) => item.id)).toEqual(['search-1', 'liked-1', 'search-2']);
  });

  it('does not repeat a blocked title motif during fallback filling', () => {
    const selected = selectDiverseBatch([
      candidate('afternoon-1', 'Artist One', 'search', '午後の窓辺'),
      candidate('afternoon-2', 'Artist Two', 'liked', 'Afternoon Light'),
      candidate('night', 'Artist Three', 'search', 'Night Light')
    ], 3);

    expect(selected.map((item) => item.id)).toEqual(['afternoon-1', 'night']);
  });
});

function candidate(
  id: string,
  artist: string,
  source: MusicCandidate['sources'][number],
  name = `Song ${id}`
): MusicCandidate {
  return {
    id,
    name,
    artist,
    sources: [source],
    evidence: [],
    scores: {
      intentMatch: 0.5,
      tasteMatch: 0.5,
      timeFit: 0.5,
      contextFit: 0.5,
      novelty: 0.5,
      sourceConfidence: 0.5
    }
  };
}
