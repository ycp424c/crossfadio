// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../../src/renderer/views/Settings/SettingsView';
import {
  getBlockedAttempts,
  getSettings,
  getWhitelist,
  saveSettings,
  getPersonalDjContextStatus,
  listPersonalDjContextTokens,
  createPersonalDjContextToken,
  revokePersonalDjContextToken,
  revokeCurrentPersonalDjContext
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
  analyzeTaste: vi.fn(),
  getPersonalDjContextStatus: vi.fn(),
  listPersonalDjContextTokens: vi.fn(),
  createPersonalDjContextToken: vi.fn(),
  revokePersonalDjContextToken: vi.fn(),
  revokeCurrentPersonalDjContext: vi.fn()
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

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = Array.from(container.querySelectorAll('input'))
    .find((item) => item.getAttribute('placeholder') === placeholder);
  if (!input) throw new Error(`input not found: ${placeholder}`);
  return input as HTMLInputElement;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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
    vi.mocked(getPersonalDjContextStatus).mockResolvedValue({
      ok: true,
      current: {
        id: 'ctx-1',
        generatedAt: '2026-07-08T10:00:00.000Z',
        uploadedAt: '2026-07-08T10:10:00.000Z',
        summary: '适合稳定、低干扰的音乐。',
        sourceKind: 'lifemesh_bundle',
        sourceBundleId: 'bundle-1',
        sliceCount: 3,
        musicHintCount: 1,
        revokedAt: null
      },
      latest: {
        id: 'ctx-1',
        generatedAt: '2026-07-08T10:00:00.000Z',
        uploadedAt: '2026-07-08T10:10:00.000Z',
        summary: '适合稳定、低干扰的音乐。',
        sourceKind: 'lifemesh_bundle',
        sourceBundleId: 'bundle-1',
        sliceCount: 3,
        musicHintCount: 1,
        revokedAt: null
      },
      currentActive: true,
      trendCount: 1,
      retainedRecordCount: 2
    });
    vi.mocked(listPersonalDjContextTokens).mockResolvedValue({
      ok: true,
      tokens: [
        {
          id: 'token-1',
          name: 'Existing Bridge',
          scope: 'personal-dj-context:write',
          createdAt: '2026-07-08T09:00:00.000Z',
          lastUsedAt: null,
          revokedAt: null
        }
      ]
    });
    vi.mocked(createPersonalDjContextToken).mockResolvedValue({
      ok: true,
      token: {
        id: 'token-2',
        name: 'LifeMesh Bridge',
        scope: 'personal-dj-context:write',
        createdAt: '2026-07-08T11:00:00.000Z',
        lastUsedAt: null,
        revokedAt: null,
        token: 'cfdj_ctx_plaintext'
      }
    });
    vi.mocked(revokePersonalDjContextToken).mockResolvedValue({ ok: true, revoked: true });
    vi.mocked(revokeCurrentPersonalDjContext).mockResolvedValue({ ok: true, revoked: true });
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

  it('manages Personal DJ Context Bridge Tokens from settings', async () => {
    await renderSettingsView();

    expect(container.textContent).toContain('Personal Context / Integrations');
    expect(container.textContent).toContain('适合稳定、低干扰的音乐。');
    expect(container.textContent).toContain('Existing Bridge');
    expect(container.textContent).not.toContain('cfdj_ctx_plaintext');

    await act(async () => {
      setInputValue(inputByPlaceholder('Bridge Token 名称'), 'Studio laptop');
    });
    await act(async () => {
      buttonByText('创建 Bridge Token').click();
      await Promise.resolve();
    });

    expect(createPersonalDjContextToken).toHaveBeenCalledWith('Studio laptop');
    expect(container.textContent).toContain('cfdj_ctx_plaintext');

    await act(async () => {
      buttonByText('撤销当前上下文').click();
      await Promise.resolve();
    });
    expect(revokeCurrentPersonalDjContext).toHaveBeenCalled();

    const revokeButtons = Array.from(container.querySelectorAll('button[title="撤销 Bridge Token"]')) as HTMLButtonElement[];
    await act(async () => {
      revokeButtons[0].click();
      await Promise.resolve();
    });
    expect(revokePersonalDjContextToken).toHaveBeenCalledWith('token-1');
  });
});
