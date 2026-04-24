import { describe, expect, it } from 'vitest';
import { localBackendProxyPatterns } from '../../vite.config';

describe('Vite dev server proxy', () => {
  it('does not proxy renderer modules whose paths start with api', () => {
    const apiProxyPattern = new RegExp(localBackendProxyPatterns.api);

    expect(apiProxyPattern.test('/api/health')).toBe(true);
    expect(apiProxyPattern.test('/api.ts')).toBe(false);
  });

  it('only proxies the websocket endpoint, not renderer ws modules', () => {
    const wsProxyPattern = new RegExp(localBackendProxyPatterns.ws);

    expect(wsProxyPattern.test('/ws')).toBe(true);
    expect(wsProxyPattern.test('/ws/client.ts')).toBe(false);
  });
});
