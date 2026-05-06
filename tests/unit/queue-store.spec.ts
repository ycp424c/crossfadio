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
});
