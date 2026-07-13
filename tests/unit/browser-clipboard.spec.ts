// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from '../../src/renderer/browserClipboard';

describe('copyTextToClipboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the async Clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });

    const settingsUrl = 'chrome://flags/#unsafely-treat-insecure-origin-as-secure';
    await expect(copyTextToClipboard(settingsUrl)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(settingsUrl);
  });

  it('falls back to a selected textarea when the async API rejects', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('insecure origin')) }
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand
    });

    await expect(copyTextToClipboard('http://10.0.0.8:4318')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });
});
