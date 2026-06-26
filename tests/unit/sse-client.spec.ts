import { describe, expect, it, vi } from 'vitest';
import { streamSegue } from '../../src/renderer/sse/client';

describe('renderer SSE client', () => {
  it('retries transient 502 responses before reading the segue stream', async () => {
    const calls: number[] = [];
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => 'jwt-token')
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls.push(Date.now());
      if (calls.length === 1) {
        return new Response('bad gateway', { status: 502 });
      }
      return new Response('event: segue.tts-ready\ndata: {"audioUrl":"/ok.mp3"}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }));

    const events = [];
    for await (const event of streamSegue({
      clientRequestId: 'req-1',
      from: { id: '1' },
      to: { id: '2' }
    })) {
      events.push(event);
    }

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events).toEqual([{ type: 'segue.tts-ready', data: { audioUrl: '/ok.mp3' } }]);
  });
});
