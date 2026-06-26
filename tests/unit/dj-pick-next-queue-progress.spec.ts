import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAddedTrackCount,
  getRemainingPickSlots,
  hasReachedPickTarget
} from '../../src/server/dj/pickNextQueueProgress';
import { setQueueState } from '../../src/server/store/queue';

describe('DJ pick-next queue progress', () => {
  beforeEach(() => {
    setQueueState('queue-progress-user', [], 0);
  });

  it('counts appended tracks relative to the initial queue length', () => {
    setQueueState('queue-progress-user', [
      { ncmId: '1', name: 'Existing' },
      { ncmId: '2', name: 'Appended One' },
      { ncmId: '3', name: 'Appended Two' }
    ], 0);

    expect(getAddedTrackCount('queue-progress-user', 1)).toBe(2);
    expect(getRemainingPickSlots('queue-progress-user', 1, 3)).toBe(1);
    expect(hasReachedPickTarget('queue-progress-user', 1, 2)).toBe(true);
    expect(hasReachedPickTarget('queue-progress-user', 1, 3)).toBe(false);
  });
});
