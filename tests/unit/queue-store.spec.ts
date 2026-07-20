import { beforeEach, describe, expect, it } from 'vitest';

// Reset module state between tests
beforeEach(async () => {
  const q = await import('../../src/server/store/queue');
  q.setQueue('test-user', []);
});

describe('queue store', () => {
  it('setQueue replaces existing queue and resets index', async () => {
    const q = await import('../../src/server/store/queue');
    q.setQueue('test-user', [{ ncmId: 'a' }, { ncmId: 'b' }]);
    expect(q.getQueue('test-user')).toHaveLength(2);
    expect(q.getCurrentIndex('test-user')).toBe(0);
  });

  it('setQueueState replaces queue and clamps current index', async () => {
    const q = await import('../../src/server/store/queue');
    q.setQueueState('test-user', [{ ncmId: 'a' }, { ncmId: 'b' }], 5);
    expect(q.getQueue('test-user')).toHaveLength(2);
    expect(q.getCurrentIndex('test-user')).toBe(1);
  });

  it('advances current state without changing the content revision', async () => {
    const q = await import('../../src/server/store/queue');
    const queue = [{ ncmId: 'a' }, { ncmId: 'b' }];
    q.setQueueState('test-user', queue, 0);
    const contentRevision = q.getQueueRevision('test-user');
    const stateRevision = q.getQueueStateRevision('test-user');

    const update = q.compareAndSetQueueState('test-user', stateRevision, queue, 1);

    expect(update.applied).toBe(true);
    expect(q.getCurrentIndex('test-user')).toBe(1);
    expect(q.getQueueRevision('test-user')).toBe(contentRevision);
    expect(q.getQueueStateRevision('test-user')).toBe(stateRevision + 1);
  });

  it('keeps the state revision stable for an idempotent compare-and-set snapshot', async () => {
    const q = await import('../../src/server/store/queue');
    const queue = [{ ncmId: 'a' }, { ncmId: 'b' }];
    q.setQueueState('test-user', queue, 0);
    const stateRevision = q.getQueueStateRevision('test-user');

    const update = q.compareAndSetQueueState('test-user', stateRevision, queue, 0);

    expect(update).toMatchObject({ applied: true, snapshot: { revision: stateRevision } });
    expect(q.getQueueStateRevision('test-user')).toBe(stateRevision);
  });

  it('swapNext inserts track at position after current', async () => {
    const q = await import('../../src/server/store/queue');
    q.setQueue('test-user', [{ ncmId: 'a' }, { ncmId: 'c' }]);
    q.swapNext('test-user', { ncmId: 'b' });
    const queue = q.getQueue('test-user');
    expect(queue[1].ncmId).toBe('b');
    expect(queue[2].ncmId).toBe('c');
  });

  it('addToQueue with end position appends to end', async () => {
    const q = await import('../../src/server/store/queue');
    q.setQueue('test-user', [{ ncmId: 'a' }]);
    q.addToQueue('test-user', { ncmId: 'z' }, 'end');
    expect(q.getQueue('test-user').at(-1)?.ncmId).toBe('z');
  });

  it('addToQueue with after_current inserts after current', async () => {
    const q = await import('../../src/server/store/queue');
    q.setQueue('test-user', [{ ncmId: 'a' }, { ncmId: 'c' }]);
    q.addToQueue('test-user', { ncmId: 'b' }, 'after_current');
    expect(q.getQueue('test-user')[1].ncmId).toBe('b');
  });

  it('banNcmId removes matching tracks', async () => {
    const q = await import('../../src/server/store/queue');
    q.setQueue('test-user', [{ ncmId: 'x' }, { ncmId: 'y' }, { ncmId: 'x' }]);
    q.banNcmId('test-user', 'x');
    expect(q.getQueue('test-user').every((t) => t.ncmId !== 'x')).toBe(true);
  });

  it('rejects oversized or overlong queue state at the store boundary', async () => {
    const q = await import('../../src/server/store/queue');

    expect(() => q.setQueue(
      'test-user',
      Array.from({ length: 101 }, (_, index) => ({ ncmId: `track-${index}` }))
    )).toThrow('queue exceeds limit');
    expect(() => q.setQueue('test-user', [{ ncmId: 'x'.repeat(129) }]))
      .toThrow('queue track id exceeds limit');
  });
});
