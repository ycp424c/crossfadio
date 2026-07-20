import { describe, expect, it } from 'vitest';
import { safeOperationalError } from '../../src/server/errors/safe-operational-error.js';

describe('safe operational errors', () => {
  it('maps provider failures without retaining messages, bodies or causes', () => {
    const error = Object.assign(new Error('PRIVATE prompt echoed by provider'), {
      status: 429,
      responseBody: 'PRIVATE response body',
      cause: new Error('PRIVATE cause'),
      request_id: 'request:123'
    });

    expect(safeOperationalError(error, 'fallback_failed')).toEqual({
      code: 'provider_rate_limited',
      status: 429,
      requestId: 'request:123'
    });
    expect(JSON.stringify(safeOperationalError(error, 'fallback_failed'))).not.toContain('PRIVATE');
  });

  it('rejects unsafe provider-controlled codes and request ids', () => {
    expect(safeOperationalError({
      code: 'PRIVATE CODE',
      requestId: 'private prompt with spaces'
    }, 'stable_fallback')).toEqual({ code: 'stable_fallback' });
  });
});
