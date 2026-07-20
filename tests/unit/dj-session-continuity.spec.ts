import { describe, expect, it } from 'vitest';
import { buildDjSessionContinuity } from '../../src/server/dj-memory/session-continuity';

describe('DJ Session continuity', () => {
  const now = new Date('2026-07-17T04:00:00.000Z');
  const events = [
    {
      id: 'old', type: 'track_selected', createdAt: '2026-07-16T03:59:59.000Z',
      payload: { selectionRationale: '过期原因' }
    },
    {
      id: 'request', type: 'listener_request_received', createdAt: '2026-07-17T03:00:00.000Z',
      payload: { requestSummary: '想听轻快女声' }
    },
    {
      id: 'selected', type: 'track_selected', createdAt: '2026-07-17T03:10:00.000Z',
      payload: { selectionRationale: '承接轻快氛围' }
    },
    {
      id: 'segue', type: 'segue_generated', createdAt: '2026-07-17T03:20:00.000Z',
      payload: { segueSummary: '从晨光聊到海边' }
    },
    {
      id: 'directive', type: 'directive_updated', createdAt: '2026-07-17T03:30:00.000Z',
      payload: { directive: '继续轻快', source: 'chat' }
    }
  ];

  it('keeps purpose-specific 24h continuity and never turns an event into authoritative state', () => {
    expect(buildDjSessionContinuity(events, 'selection', now).map((item) => item.kind)).toEqual([
      'selection_reason', 'request_summary'
    ]);
    expect(buildDjSessionContinuity(events, 'segue', now).map((item) => item.kind)).toEqual([
      'segue_summary', 'selection_reason'
    ]);
    expect(buildDjSessionContinuity(events, 'chat', now).map((item) => item.kind)).toEqual([
      'directive_history', 'request_summary'
    ]);
    expect(JSON.stringify(buildDjSessionContinuity(events, 'selection', now))).not.toContain('过期原因');
  });

  it('caps continuity at twenty newest items', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      id: `event-${index}`,
      type: 'listener_request_received',
      createdAt: `2026-07-17T03:${String(index).padStart(2, '0')}:00.000Z`,
      payload: { requestSummary: `请求 ${index}` }
    }));
    const result = buildDjSessionContinuity(many, 'selection', now);
    expect(result).toHaveLength(20);
    expect(result[0].text).toBe('请求 29');
  });
});
