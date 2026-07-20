import { describe, expect, it } from 'vitest';
import {
  djMemorySnapshotMetadataSchema,
  djMemoryProjectionSchema
} from '../../src/shared/dj-memory';

describe('DJ Memory shared schema', () => {
  it('preserves source authority and freshness in a point-in-time snapshot', () => {
    const snapshot = {
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      userId: 'user-1',
      assembledAt: '2026-07-17T10:00:00.000Z',
      sources: [{
        id: 'pdc:ctx-1',
        kind: 'personal_dj_context',
        authority: 'advisory',
        freshness: 'fresh',
        observedAt: '2026-07-17T09:00:00.000Z',
        loadedAt: '2026-07-17T10:00:00.000Z',
        expiresAt: '2026-07-18T09:00:00.000Z',
        recordCount: 1
      }]
    };

    expect(djMemorySnapshotMetadataSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('uses distinct bounded projections for chat, selection, and segue', () => {
    const base = {
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      assembledAt: '2026-07-17T10:00:00.000Z',
      sources: [],
      facts: []
    };

    expect(djMemoryProjectionSchema.parse({ ...base, purpose: 'chat' }).purpose).toBe('chat');
    expect(djMemoryProjectionSchema.parse({ ...base, purpose: 'selection' }).purpose).toBe('selection');
    expect(djMemoryProjectionSchema.parse({ ...base, purpose: 'segue' }).purpose).toBe('segue');
  });
});
