import { describe, expect, it } from 'vitest';
import { projectPromptJson } from '../../src/server/music-agent/prompt-projection.js';

describe('music-agent prompt projection', () => {
  it('always returns complete parseable JSON within every positive budget', () => {
    const value = {
      quote: '"\\\n'.repeat(2_000),
      unicode: '安静🎵🌌'.repeat(2_000),
      items: Array.from({ length: 300 }, (_, index) => ({ index, text: '很长'.repeat(100) }))
    };

    for (const budget of [1, 2, 3, 4, 8, 16, 64, 255, 1_024, 8_192]) {
      const result = projectPromptJson(value, budget);
      expect(() => JSON.parse(result), `budget=${budget}`).not.toThrow();
      expect(result.length, `budget=${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  it('prunes array items before optional fields, then crops strings without slicing serialized JSON', () => {
    const value = {
      id: 'required-id',
      optionalNote: 'keep-this-note',
      candidates: [
        { id: '1', text: 'x'.repeat(80) },
        { id: '2', text: 'y'.repeat(80) }
      ]
    };
    const oneCandidateBudget = JSON.stringify({
      ...value,
      candidates: [value.candidates[0]]
    }).length;
    const arrayPruned = JSON.parse(projectPromptJson(value, oneCandidateBudget, {
      requiredKeys: ['id']
    })) as typeof value;
    expect(arrayPruned.candidates).toHaveLength(1);
    expect(arrayPruned.optionalNote).toBe('keep-this-note');

    const fieldPruned = JSON.parse(projectPromptJson(value, 40, {
      requiredKeys: ['id']
    })) as Record<string, unknown>;
    expect(fieldPruned.id).toBe('required-id');
    expect(fieldPruned).not.toHaveProperty('optionalNote');
  });

  it('bounds deeply nested, cyclic, escaped, and large random-shaped inputs', () => {
    const cyclic: Record<string, unknown> = { label: 'root' };
    cyclic.self = cyclic;
    let deep: unknown = 'leaf';
    for (let index = 0; index < 300; index += 1) deep = { index, deep };

    const pseudoRandom = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      text: `${index % 2 === 0 ? '"\\' : '🎧'}-${'内容'.repeat((index * 17) % 90)}`,
      nested: index % 3 === 0 ? deep : cyclic
    }));

    for (let budget = 1; budget <= 513; budget += 17) {
      const result = projectPromptJson({ pseudoRandom, cyclic, deep }, budget);
      expect(result.length).toBeLessThanOrEqual(budget);
      expect(() => JSON.parse(result)).not.toThrow();
    }
  });

  it('rejects a zero or negative budget because no JSON document can fit', () => {
    expect(() => projectPromptJson({}, 0)).toThrow(/positive/);
    expect(() => projectPromptJson({}, -1)).toThrow(/positive/);
  });
});
