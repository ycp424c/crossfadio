// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectionJourneyCard } from '../../src/renderer/components/player/SelectionJourneyCard';
import type { SelectionJourneySnapshot } from '../../src/shared/selection';

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = null;
});

describe('SelectionJourneyCard', () => {
  it('shows a compact live sentence while collapsed', () => {
    root = createRoot(container);
    act(() => root?.render(createElement(SelectionJourneyCard, {
      journey: snapshot(),
      expanded: false,
      onToggle: vi.fn()
    })));

    expect(container.textContent).toContain('正在从可用曲目里寻找');
    expect(container.textContent).not.toContain('寻找候选');
  });

  it('shows bounded public stages, picks, candidates and async DJ notes when expanded', () => {
    root = createRoot(container);
    act(() => root?.render(createElement(SelectionJourneyCard, {
      journey: snapshot(),
      expanded: true,
      onToggle: vi.fn()
    })));

    expect(container.textContent).toContain('寻找候选');
    expect(container.textContent).toContain('Plastic Love');
    expect(container.textContent).toContain('风格契合');
    expect(container.textContent).toContain('DJ 手记正在润色');
    expect(container.textContent).not.toContain('secret');
  });

  it('offers user-readable navigation across the recent 24-hour history', () => {
    const onNewer = vi.fn();
    const onOlder = vi.fn();
    root = createRoot(container);
    act(() => root?.render(createElement(SelectionJourneyCard, {
      journey: snapshot(),
      expanded: true,
      historyPosition: 1,
      historyTotal: 3,
      onNewer,
      onOlder,
      onToggle: vi.fn()
    })));

    expect(container.textContent).toContain('最近 24 小时');
    expect(container.textContent).toContain('第 2 / 3 轮');
    const buttons = [...container.querySelectorAll('button')];
    act(() => buttons.find((button) => button.textContent === '较新一轮')?.click());
    act(() => buttons.find((button) => button.textContent === '更早一轮')?.click());
    expect(onNewer).toHaveBeenCalledOnce();
    expect(onOlder).toHaveBeenCalledOnce();
  });
});

function snapshot(): SelectionJourneySnapshot {
  return {
    schemaVersion: 1,
    runId: 'run-card',
    journeyVersion: 1,
    revision: 1,
    status: 'running',
    summary: '正在从可用曲目里寻找这轮最合适的选择。',
    startedAt: '2026-07-17T04:00:00.000Z',
    updatedAt: '2026-07-17T04:00:01.000Z',
    stages: [{
      stage: 'recall',
      status: 'active',
      title: '寻找候选',
      detail: '从可用来源里寻找合适的候选曲目。',
      reasonCodes: ['candidate_recalled']
    }],
    candidates: [{
      id: 'song-a', name: 'Plastic Love', artist: '竹内まりや', state: 'considering'
    }],
    selections: [{
      trackId: 'song-a', trackName: 'Plastic Love', artist: '竹内まりや',
      reason: '风格契合，同时兼顾了这一轮的整体搭配。'
    }],
    narration: { status: 'pending' }
  };
}
