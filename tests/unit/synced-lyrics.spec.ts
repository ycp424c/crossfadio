// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncedLyrics } from '../../src/renderer/components/player/SyncedLyrics';

let root: Root | null = null;
let outerScroller: HTMLDivElement;
let host: HTMLDivElement;
const originalHTMLElementScrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: 320,
    bottom: top + height,
    width: 320,
    height,
    toJSON: () => ({})
  } as DOMRect;
}

describe('SyncedLyrics', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    outerScroller = document.createElement('div');
    Object.defineProperty(outerScroller, 'scrollTop', { configurable: true, writable: true, value: 77 });
    host = document.createElement('div');
    outerScroller.appendChild(host);
    document.body.appendChild(outerScroller);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    outerScroller.remove();
    vi.restoreAllMocks();
    if (originalHTMLElementScrollToDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalHTMLElementScrollToDescriptor);
    } else {
      delete (HTMLElement.prototype as Partial<Pick<HTMLElement, 'scrollTo'>>).scrollTo;
    }
  });

  it('auto-scrolls only the lyrics container when the active line changes', async () => {
    const lyric = '[00:00.000]第一句\n[00:05.000]第二句\n[00:10.000]第三句';
    const scrolledElements: Element[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: function () {}
    });
    const scrollToSpy = vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function () {
      scrolledElements.push(this);
    });
    const windowScrollSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

    await act(async () => {
      root?.render(createElement(SyncedLyrics, { lyric, positionSec: 0 }));
    });

    const activeLine = Array.from(host.querySelectorAll('div')).find((element) => element.textContent === '第二句');
    if (!activeLine) throw new Error('expected lyric line to render');
    const lyricsContainer = activeLine.closest('[class*="overflow-y-auto"]');
    if (!(lyricsContainer instanceof HTMLElement)) throw new Error('expected lyrics container to render');

    Object.defineProperty(lyricsContainer, 'clientHeight', { configurable: true, value: 100 });
    Object.defineProperty(lyricsContainer, 'scrollHeight', { configurable: true, value: 360 });
    Object.defineProperty(lyricsContainer, 'scrollTop', { configurable: true, writable: true, value: 20 });
    lyricsContainer.getBoundingClientRect = () => rect(100, 100);
    activeLine.getBoundingClientRect = () => rect(250, 24);
    scrollToSpy.mockClear();
    scrolledElements.length = 0;

    await act(async () => {
      root?.render(createElement(SyncedLyrics, { lyric, positionSec: 6 }));
    });

    expect(scrolledElements).toEqual([lyricsContainer]);
    expect(scrollToSpy).toHaveBeenCalledWith({ behavior: 'smooth', top: 132 });
    expect(outerScroller.scrollTop).toBe(77);
    expect(windowScrollSpy).not.toHaveBeenCalled();
  });
});
