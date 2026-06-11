// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../../src/renderer/views/Settings/SettingsView';
import {
  getBlockedAttempts,
  getSettings,
  getWhitelist,
  saveSettings
} from '@renderer/api';

vi.mock('@renderer/api', () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  previewTtsVoice: vi.fn(),
  getWhitelist: vi.fn(),
  getBlockedAttempts: vi.fn(),
  addToWhitelist: vi.fn(),
  removeFromWhitelist: vi.fn(),
  unblockUser: vi.fn(),
  analyzeTaste: vi.fn()
}));

let root: Root | null = null;
let container: HTMLDivElement;

async function renderSettingsView(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(SettingsView));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find((item) => item.textContent?.trim() === text);
  if (!button) throw new Error(`button not found: ${text}`);
  return button as HTMLButtonElement;
}

describe('settings view', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.mocked(getSettings).mockResolvedValue({
      ok: true,
      llm: {
        baseUrl: 'https://llm.example/v1',
        model: 'test-model',
        hasApiKey: true
      },
      tts: {
        baseUrl: 'https://tts.example/v1',
        model: 'qwen3-tts-flash',
        hasApiKey: true,
        voice: 'Cherry',
        voiceDefault: 'Cherry'
      },
      dailyThemeEnabled: true,
      discoveryMode: 'explore',
      autoFillBatchSize: 2
    });
    vi.mocked(getWhitelist).mockResolvedValue({ ok: true, entries: [] });
    vi.mocked(getBlockedAttempts).mockResolvedValue({ ok: true, blocked: [] });
    vi.mocked(saveSettings).mockResolvedValue();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it('saves the selected DJ auto-fill batch size from the rendered settings view', async () => {
    await renderSettingsView();

    const saveButton = buttonByText('保存');
    expect(saveButton.disabled).toBe(true);

    await act(async () => {
      buttonByText('5首').click();
    });
    expect(saveButton.disabled).toBe(false);

    await act(async () => {
      saveButton.click();
    });

    expect(saveSettings).toHaveBeenCalledWith({
      tts: { voice: 'Cherry' },
      autoFillBatchSize: 5
    });
  });
});
