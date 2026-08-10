// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from '../../src/renderer/views/Settings/SettingsView';
import {
  getBlockedAttempts,
  getSettings,
  getPriorityUsers,
  removePriorityUser,
  saveSettings,
  getPersonalDjContextStatus,
  listPersonalDjContextTokens,
  createPersonalDjContextToken,
  revokePersonalDjContextToken,
  revokeCurrentPersonalDjContext,
  getSuspendedUsers,
  suspendUser,
  reactivateUser
} from '@renderer/api';

vi.mock('@renderer/api', () => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  previewTtsVoice: vi.fn(),
  getPriorityUsers: vi.fn(),
  getBlockedAttempts: vi.fn(),
  addPriorityUser: vi.fn(),
  removePriorityUser: vi.fn(),
  unblockUser: vi.fn(),
  analyzeTaste: vi.fn(),
  getPersonalDjContextStatus: vi.fn(),
  listPersonalDjContextTokens: vi.fn(),
  createPersonalDjContextToken: vi.fn(),
  revokePersonalDjContextToken: vi.fn(),
  revokeCurrentPersonalDjContext: vi.fn(),
  getSuspendedUsers: vi.fn(),
  suspendUser: vi.fn(),
  reactivateUser: vi.fn()
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
      resourceTier: 'priority',
      resourceCapabilities: { thinking: true, configurableAutoFillBatchSize: true },
      llm: {
        baseUrl: 'https://llm.example/v1',
        model: 'test-model',
        hasApiKey: true,
        thinkingEnabled: false,
        thinkingSupported: true
      },
      tts: {
        provider: 'aliyun-qwen',
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
    vi.mocked(getPriorityUsers).mockResolvedValue({ ok: true, entries: [] });
    vi.mocked(getBlockedAttempts).mockResolvedValue({ ok: true, blocked: [] });
    vi.mocked(getSuspendedUsers).mockResolvedValue({ ok: true, suspended: [] });
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
      autoFillBatchSize: 5
    });
  });

  it('submits the voice only when the user changes it', async () => {
    await renderSettingsView();

    const voiceSelect = container.querySelector<HTMLSelectElement>('select');
    expect(voiceSelect).not.toBeNull();
    await act(async () => {
      if (!voiceSelect) return;
      voiceSelect.value = 'Ethan';
      voiceSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      buttonByText('保存').click();
    });

    expect(saveSettings).toHaveBeenCalledWith({
      tts: { voice: 'Ethan' }
    });
  });

  it('shows Tencent voice pricing tiers and excludes English-only voices from the Chinese DJ options', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ok: true,
      resourceTier: 'priority',
      resourceCapabilities: { thinking: true, configurableAutoFillBatchSize: true },
      llm: {
        baseUrl: 'https://llm.example/v1',
        model: 'test-model',
        hasApiKey: true,
        thinkingEnabled: false,
        thinkingSupported: true
      },
      tts: {
        provider: 'tencent-cloud',
        baseUrl: '',
        model: 'TextToVoice',
        hasApiKey: true,
        voice: '1001',
        voiceDefault: null
      },
      dailyThemeEnabled: true,
      discoveryMode: 'explore',
      autoFillBatchSize: 2
    });

    await renderSettingsView();

    const optionTexts = Array.from(container.querySelectorAll('option'))
      .map((option) => option.textContent?.trim());
    expect(optionTexts).toContain('智瑜 · 情感女声 · 基础档（按次计费）');
    expect(optionTexts).toContain('智瑜 · 情感女声（精品） · 精品档（后付费 0.3 元/万字符）');
    expect(optionTexts).toContain('月华 · 聊天女声（大模型） · 大模型档（后付费首档 1.2 元/万字符）');
    expect(optionTexts).toContain('智小柔 · 聊天女声（超自然） · 超自然档（后付费首档 6.5 元/万字符）');
    expect(optionTexts.some((text) => text?.includes('101050') || text?.includes('WeJack'))).toBe(false);
  });

  it('enables LLM thinking from the rendered settings view', async () => {
    await renderSettingsView();

    const thinkingSwitch = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="启用深度思考"]');
    expect(thinkingSwitch?.getAttribute('aria-checked')).toBe('false');

    await act(async () => {
      thinkingSwitch?.click();
      await Promise.resolve();
    });

    expect(saveSettings).toHaveBeenCalledWith({ llm: { thinkingEnabled: true } });
    expect(thinkingSwitch?.getAttribute('aria-checked')).toBe('true');
  });

  it('manages Personal DJ Context Bridge Tokens from settings', async () => {
    await renderSettingsView();

    expect(container.textContent).toContain('个人上下文与集成');
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

  it('shows the priority resource tier and keeps priority capabilities enabled', async () => {
    await renderSettingsView();

    expect(container.textContent).toContain('优先资源用户');
    const thinkingSwitch = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="启用深度思考"]');
    expect(thinkingSwitch?.disabled).toBe(false);
    const batchButtons = Array.from(container.querySelectorAll('button[aria-pressed]')) as HTMLButtonElement[];
    expect(batchButtons.some((button) => button.textContent?.trim() === '5首' && !button.disabled)).toBe(true);
  });

  it('disables thinking and larger auto-fill batches for standard users', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ok: true,
      resourceTier: 'standard',
      resourceCapabilities: { thinking: false, configurableAutoFillBatchSize: false },
      llm: {
        baseUrl: 'https://llm.example/v1',
        model: 'test-model',
        hasApiKey: true,
        thinkingEnabled: false,
        thinkingSupported: true
      },
      tts: {
        provider: 'aliyun-qwen',
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

    await renderSettingsView();

    expect(container.textContent).toContain('标准用户');
    expect(container.textContent).toContain('无法启用深度思考');
    const thinkingSwitch = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="启用深度思考"]');
    expect(thinkingSwitch?.disabled).toBe(true);
    const batchButtons = Array.from(container.querySelectorAll('button[aria-pressed]')) as HTMLButtonElement[];
    const two = batchButtons.find((button) => button.textContent?.trim() === '2首');
    const five = batchButtons.find((button) => button.textContent?.trim() === '5首');
    expect(two?.disabled).toBe(false);
    expect(five?.disabled).toBe(true);
  });

  it('confirms demotion with wording that access and data remain but limits become standard', async () => {
    vi.mocked(getPriorityUsers).mockResolvedValue({ ok: true, entries: ['1001'] });

    await renderSettingsView();

    expect(container.textContent).toContain('资源保障名单');
    const removeButton = container.querySelector<HTMLButtonElement>('button[title="移除"]');
    expect(removeButton).not.toBeNull();

    await act(async () => {
      removeButton?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('仍可正常登录');
    expect(container.textContent).toContain('数据保留');
    expect(container.textContent).toContain('标准');

    await act(async () => {
      buttonByText('确认移除').click();
      await Promise.resolve();
    });

    expect(vi.mocked(removePriorityUser)).toHaveBeenCalledWith('1001');
  });

  it('falls back to standard/no-capabilities when the settings response lacks resourceTier/resourceCapabilities', async () => {
    // A rolling upgrade (or an old e2e fixture) may serve a response without
    // the new fields; the view must not crash and must degrade safely.
    vi.mocked(getSettings).mockResolvedValue({
      ok: true,
      llm: {
        baseUrl: 'https://llm.example/v1',
        model: 'test-model',
        hasApiKey: true,
        thinkingEnabled: false,
        thinkingSupported: true
      },
      tts: {
        provider: 'aliyun-qwen',
        baseUrl: 'https://tts.example/v1',
        model: 'qwen3-tts-flash',
        hasApiKey: true,
        voice: 'Cherry',
        voiceDefault: 'Cherry'
      },
      dailyThemeEnabled: true,
      discoveryMode: 'explore',
      autoFillBatchSize: 2
    } as never);

    await renderSettingsView();

    expect(container.textContent).toContain('标准用户');
    expect(container.textContent).toContain('无法启用深度思考');
    const thinkingSwitch = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="启用深度思考"]');
    expect(thinkingSwitch?.disabled).toBe(true);
    const batchButtons = Array.from(container.querySelectorAll('button[aria-pressed]')) as HTMLButtonElement[];
    const five = batchButtons.find((button) => button.textContent?.trim() === '5首');
    expect(five?.disabled).toBe(true);
  });

  it('renders demotion confirmation as a stacked block, not a third squeezed item of the flex row', async () => {
    vi.mocked(getPriorityUsers).mockResolvedValue({ ok: true, entries: ['1001'] });

    await renderSettingsView();

    const removeButton = container.querySelector<HTMLButtonElement>('button[title="移除"]');
    expect(removeButton).not.toBeNull();
    await act(async () => {
      removeButton?.click();
      await Promise.resolve();
    });

    const li = removeButton?.closest('li');
    expect(li).not.toBeNull();
    // The flex row itself only holds the id and the remove button.
    const row = li?.firstElementChild;
    expect(row?.children.length).toBe(2);
    // The confirmation block is a stacked sibling below the row.
    const confirmBlock = li?.lastElementChild;
    expect(confirmBlock).not.toBe(row);
    expect(confirmBlock?.textContent).toContain('确认移除');
  });

  it('manages temporary safety suspension separately from priority demotion', async () => {
    vi.mocked(getSuspendedUsers).mockResolvedValue({
      ok: true,
      suspended: [{ userId: '2002', updatedAt: '2026-08-10T00:00:00.000Z' }]
    });

    await renderSettingsView();

    expect(container.textContent).toContain('账号暂停');
    expect(container.textContent).toContain('不会自动成为优先');
    expect(container.textContent).toContain('2002');

    await act(async () => {
      setInputValue(inputByPlaceholder('输入要暂停的网易云用户 ID'), '2003');
    });
    await act(async () => {
      buttonByText('暂停用户').click();
      await Promise.resolve();
    });
    expect(vi.mocked(suspendUser)).toHaveBeenCalledWith('2003');

    const restoreButton = Array.from(container.querySelectorAll('button[title="恢复"]')) as HTMLButtonElement[];
    await act(async () => {
      restoreButton[0]?.click();
      await Promise.resolve();
    });
    expect(vi.mocked(reactivateUser)).toHaveBeenCalledWith('2002');
  });
});
