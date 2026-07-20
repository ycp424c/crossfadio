import { describe, expect, it } from 'vitest';
import {
  listeningEpisodeCheckpointSchema,
  listeningEpisodeCreateSchema,
  listeningEpisodeFinalizeSchema
} from '../../src/shared/listening';
import { listeningEpisodeCreateSchema as sharedCreateSchema } from '../../src/shared/schema';

describe('listening episode wire schema', () => {
  it('is available from the shared schema entry point', () => {
    expect(sharedCreateSchema).toBe(listeningEpisodeCreateSchema);
  });

  it('accepts a v2 episode creation after playback starts', () => {
    const input = {
      playerInstanceId: 'player-1',
      deckId: 'primary',
      track: {
        id: '347230',
        name: '富士山下',
        artists: ['陈奕迅']
      },
      durationMs: 240_000,
      checkpointSeq: 0
    };

    expect(listeningEpisodeCreateSchema.parse(input)).toEqual(input);
  });

  it('keeps an unknown primary artist as missing evidence', () => {
    const input = {
      playerInstanceId: 'player-1',
      deckId: 'primary',
      track: { id: '347230', name: 'Instrumental', artists: [] },
      durationMs: null,
      checkpointSeq: 0
    };

    expect(listeningEpisodeCreateSchema.parse(input).track.artists).toEqual([]);
  });

  it('requires ordered, non-negative checkpoint measurements', () => {
    const checkpoint = {
      checkpointSeq: 3,
      positionMs: 42_000,
      listenedMs: 31_500,
      durationMs: 240_000
    };

    expect(listeningEpisodeCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(listeningEpisodeCheckpointSchema.safeParse({
      ...checkpoint,
      checkpointSeq: 0
    }).success).toBe(false);
    expect(listeningEpisodeCheckpointSchema.safeParse({
      ...checkpoint,
      listenedMs: -1
    }).success).toBe(false);
  });

  it('accepts only the four terminal playback outcomes', () => {
    const finalization = {
      checkpointSeq: 4,
      positionMs: 49_900,
      listenedMs: 38_000,
      durationMs: 100_000,
      outcome: 'skipped'
    };

    expect(listeningEpisodeFinalizeSchema.parse(finalization).outcome).toBe('skipped');
    expect(listeningEpisodeFinalizeSchema.safeParse({
      ...finalization,
      outcome: 'abandoned'
    }).success).toBe(false);
  });
});
