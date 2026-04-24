import { beforeEach, describe, expect, it } from 'vitest';

// Reset module state between tests
beforeEach(async () => {
  const q = await import('../../src/server/store/queue');
  q.setQueue([]);
});

describe('queue store', () => {
  it('setQueue replaces existing queue and resets index', async () => {
    const q = await import('../../src/server/store/queue');
    q.setQueue([{ ncmId: 'a' }, { ncmId: 'b' }]);
    expect(q.getQueue()).toHaveLength(2);
    expect(q.getCurrentIndex()).toBe(0);
  });

  it('swapNext inserts track at position after current', async () => {
    const q = await import('../../src/server/store/queue');
    q.setQueue([{ ncmId: 'a' }, { ncmId: 'c' }]);
    q.swapNext({ ncmId: 'b' });
    const queue = q.getQueue();
    expect(queue[1].ncmId).toBe('b');
    expect(queue[2].ncmId).toBe('c');
  });

  it('addToQueue with end position appends to end', async () => {
    const q = await import('../../src/server/store/queue');
    q.setQueue([{ ncmId: 'a' }]);
    q.addToQueue({ ncmId: 'z' }, 'end');
    expect(q.getQueue().at(-1)?.ncmId).toBe('z');
  });

  it('addToQueue with after_current inserts after current', async () => {
    const q = await import('../../src/server/store/queue');
    q.setQueue([{ ncmId: 'a' }, { ncmId: 'c' }]);
    q.addToQueue({ ncmId: 'b' }, 'after_current');
    expect(q.getQueue()[1].ncmId).toBe('b');
  });

  it('banNcmId removes matching tracks', async () => {
    const q = await import('../../src/server/store/queue');
    q.setQueue([{ ncmId: 'x' }, { ncmId: 'y' }, { ncmId: 'x' }]);
    q.banNcmId('x');
    expect(q.getQueue().every((t) => t.ncmId !== 'x')).toBe(true);
  });
});
