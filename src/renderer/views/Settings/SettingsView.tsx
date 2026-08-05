import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Settings2, Check, AlertCircle, Loader2, Trash2, UserPlus, Shield, Sparkles, Volume2 } from 'lucide-react';
import {
  getSettings,
  saveSettings,
  previewTtsVoice,
  getWhitelist,
  getBlockedAttempts,
  addToWhitelist,
  removeFromWhitelist,
  unblockUser,
  analyzeTaste,
  getPersonalDjContextStatus,
  listPersonalDjContextTokens,
  createPersonalDjContextToken,
  revokePersonalDjContextToken,
  revokeCurrentPersonalDjContext,
  type LlmSettings,
  type TtsSettings,
  type BlockedAttempt,
  type PersonalDjContextStatusResponse,
  type PersonalDjContextToken
} from '@renderer/api';
import { QWEN3_TTS_VOICES, TENCENT_TTS_VOICES } from '@shared/tts';
import { AUTO_FILL_BATCH_SIZE_OPTIONS, DEFAULT_AUTO_FILL_BATCH_SIZE, type AutoFillBatchSize } from '@shared/dj';

type SaveStatus = { type: 'idle' } | { type: 'saving' } | { type: 'ok' } | { type: 'error'; message: string };
type WhitelistOpStatus = { type: 'idle' } | { type: 'saving' } | { type: 'ok' } | { type: 'error'; message: string };
type PreviewStatus = { type: 'idle' } | { type: 'loading' } | { type: 'playing' } | { type: 'error'; message: string };
type PersonalContextOpStatus = { type: 'idle' } | { type: 'loading' } | { type: 'ok'; message: string } | { type: 'error'; message: string };
type TasteStatus = { type: 'idle' } | { type: 'analyzing' } | { type: 'ok'; taste: string } | { type: 'error'; message: string };

export function SettingsView(): JSX.Element {
  const [llm, setLlm] = useState<LlmSettings | null>(null);
  const [tts, setTts] = useState<TtsSettings | null>(null);
  const [voice, setVoice] = useState('');
  const [autoFillBatchSize, setAutoFillBatchSize] = useState<AutoFillBatchSize>(DEFAULT_AUTO_FILL_BATCH_SIZE);
  const [savedAutoFillBatchSize, setSavedAutoFillBatchSize] = useState<AutoFillBatchSize>(DEFAULT_AUTO_FILL_BATCH_SIZE);
  const [dailyThemeEnabled, setDailyThemeEnabled] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ type: 'idle' });
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>({ type: 'idle' });
  const [loading, setLoading] = useState(true);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<BlockedAttempt[]>([]);
  const [newNcmId, setNewNcmId] = useState('');
  const [whitelistStatus, setWhitelistStatus] = useState<WhitelistOpStatus>({ type: 'idle' });
  const [isAdmin, setIsAdmin] = useState(true);
  const [personalContextStatus, setPersonalContextStatus] = useState<PersonalDjContextStatusResponse | null>(null);
  const [personalContextTokens, setPersonalContextTokens] = useState<PersonalDjContextToken[]>([]);
  const [newPersonalTokenName, setNewPersonalTokenName] = useState('LifeMesh Bridge');
  const [createdPersonalToken, setCreatedPersonalToken] = useState<string | null>(null);
  const [personalContextOpStatus, setPersonalContextOpStatus] = useState<PersonalContextOpStatus>({ type: 'idle' });
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const [tasteStatus, setTasteStatus] = useState<TasteStatus>({ type: 'idle' });

  async function handleAnalyzeTaste(): Promise<void> {
    setTasteStatus({ type: 'analyzing' });
    try {
      const result = await analyzeTaste();
      if (!result.ok) {
        setTasteStatus({ type: 'error', message: result.message ?? result.taste ?? '分析失败' });
        return;
      }
      if (!result.taste) {
        setTasteStatus({ type: 'ok', taste: result.message ?? '分析完成，但未生成品味数据' });
        return;
      }
      setTasteStatus({ type: 'ok', taste: result.taste });
    } catch (err) {
      setTasteStatus({ type: 'error', message: err instanceof Error ? err.message : '分析失败' });
    }
  }

  async function refreshPersonalContext(): Promise<void> {
    const [status, tokens] = await Promise.all([
      getPersonalDjContextStatus(),
      listPersonalDjContextTokens()
    ]);
    setPersonalContextStatus(status);
    setPersonalContextTokens(tokens.tokens);
  }

  useEffect(() => {
    Promise.all([
      getSettings()
        .then((s) => {
          setLlm(s.llm);
          setTts(s.tts);
          setVoice(s.tts.voice);
          setAutoFillBatchSize(s.autoFillBatchSize);
          setSavedAutoFillBatchSize(s.autoFillBatchSize);
          setDailyThemeEnabled(s.dailyThemeEnabled);
        }),
      getWhitelist()
        .then((w) => setWhitelist(w.entries))
        .catch(() => setIsAdmin(false)),
      getBlockedAttempts()
        .then((b) => setBlocked(b.blocked))
        .catch(() => {}),
      refreshPersonalContext()
        .catch((err) => {
          setPersonalContextOpStatus({ type: 'error', message: err instanceof Error ? err.message : '个人上下文状态加载失败' });
        })
    ])
      .catch(() => {/* first launch, no config yet */})
      .finally(() => setLoading(false));

    return () => {
      clearTimeout(statusTimerRef.current);
      previewAudioRef.current?.pause();
      previewAudioRef.current = null;
    };
  }, []);
  const refreshWhitelist = useCallback(async () => {
    const [w, b] = await Promise.all([getWhitelist(), getBlockedAttempts()]);
    setWhitelist(w.entries);
    setBlocked(b.blocked);
  }, []);

  function parseProfile(profileJson: string | null): string | null {
    if (!profileJson) return null;
    try {
      const profile = JSON.parse(profileJson) as Record<string, unknown>;
      return typeof profile?.nickname === 'string' ? profile.nickname : null;
    } catch {
      return null;
    }
  }

  async function handleSave(): Promise<void> {
    setSaveStatus({ type: 'saving' });
    try {
      await saveSettings({ tts: { voice }, autoFillBatchSize });
      setTts((current) => current ? { ...current, voice } : current);
      setSavedAutoFillBatchSize(autoFillBatchSize);
      setSaveStatus({ type: 'ok' });
      setTimeout(() => setSaveStatus({ type: 'idle' }), 2000);
    } catch (err) {
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : '保存失败' });
    }
  }

  async function handlePreviewVoice(): Promise<void> {
    if (!voice) return;
    setPreviewStatus({ type: 'loading' });
    try {
      previewAudioRef.current?.pause();
      const preview = await previewTtsVoice(voice);
      const audio = new Audio(preview.audioUrl);
      previewAudioRef.current = audio;
      audio.addEventListener('ended', () => {
        if (previewAudioRef.current === audio) setPreviewStatus({ type: 'idle' });
      }, { once: true });
      audio.addEventListener('error', () => {
        if (previewAudioRef.current === audio) setPreviewStatus({ type: 'error', message: '试听播放失败' });
      }, { once: true });
      await audio.play();
      setPreviewStatus({ type: 'playing' });
    } catch (err) {
      setPreviewStatus({ type: 'error', message: err instanceof Error ? err.message : '试听生成失败' });
    }
  }

  async function handleDailyThemeToggle(): Promise<void> {
    const next = !dailyThemeEnabled;
    setDailyThemeEnabled(next);
    try {
      await saveSettings({ dailyThemeEnabled: next });
    } catch {
      setDailyThemeEnabled(!next); // revert on failure
    }
  }

  async function handleThinkingToggle(): Promise<void> {
    if (!llm?.thinkingSupported) return;
    const next = !llm.thinkingEnabled;
    setLlm({ ...llm, thinkingEnabled: next });
    setSaveStatus({ type: 'saving' });
    try {
      await saveSettings({ llm: { thinkingEnabled: next } });
      setSaveStatus({ type: 'ok' });
      clearTimeout(statusTimerRef.current);
      statusTimerRef.current = setTimeout(() => setSaveStatus({ type: 'idle' }), 2000);
    } catch (err) {
      setLlm((current) => current ? { ...current, thinkingEnabled: !next } : current);
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : '深度思考设置保存失败' });
    }
  }

  async function handleCreatePersonalContextToken(): Promise<void> {
    setPersonalContextOpStatus({ type: 'loading' });
    try {
      const result = await createPersonalDjContextToken(newPersonalTokenName);
      setCreatedPersonalToken(result.token.token);
      await refreshPersonalContext();
      setPersonalContextOpStatus({ type: 'ok', message: 'Bridge Token 已创建，明文只显示这一次' });
    } catch (err) {
      const message = err instanceof Error ? err.message : '创建 Bridge Token 失败';
      setPersonalContextOpStatus({
        type: 'error',
        message: message.includes('token limit') ? '已达到 10 个 active Bridge Token 上限，请先撤销旧 Token' : message
      });
    }
  }

  async function handleRevokePersonalContextToken(id: string): Promise<void> {
    setPersonalContextOpStatus({ type: 'loading' });
    try {
      await revokePersonalDjContextToken(id);
      if (createdPersonalToken) setCreatedPersonalToken(null);
      await refreshPersonalContext();
      setPersonalContextOpStatus({ type: 'ok', message: 'Bridge Token 已撤销' });
    } catch (err) {
      setPersonalContextOpStatus({ type: 'error', message: err instanceof Error ? err.message : '撤销 Bridge Token 失败' });
    }
  }

  async function handleRevokeCurrentPersonalContext(): Promise<void> {
    setPersonalContextOpStatus({ type: 'loading' });
    try {
      await revokeCurrentPersonalDjContext();
      await refreshPersonalContext();
      setPersonalContextOpStatus({ type: 'ok', message: '当前 Personal DJ Context 已撤销' });
    } catch (err) {
      setPersonalContextOpStatus({ type: 'error', message: err instanceof Error ? err.message : '撤销当前上下文失败' });
    }
  }

  const disabled = voice === tts?.voice && autoFillBatchSize === savedAutoFillBatchSize;
  const activePersonalTokenCount = personalContextTokens.filter((token) => !token.revokedAt).length;
  const personalTokenLimitReached = activePersonalTokenCount >= 10;
  // 音色列表按当前 TTS provider 隔离：腾讯云展示 VoiceType 音色，其余沿用旧音色名列表。
  const providerVoices: ReadonlyArray<{ id: string; label: string }> =
    tts?.provider === 'tencent-cloud'
      ? TENCENT_TTS_VOICES
      : (QWEN3_TTS_VOICES as readonly string[]).map((name) => ({ id: name, label: name }));
  const voiceOptions = voice && !providerVoices.some((v) => v.id === voice)
    ? [{ id: voice, label: voice }, ...providerVoices]
    : providerVoices;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-4 md:px-6 py-4">
        <Settings2 className="h-5 w-5 text-zinc-400" />
        <h1 className="text-lg font-semibold">设置</h1>
      </div>

      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-4 py-4 pb-8 md:px-6 md:py-6 md:pb-8">
        {/* LLM section */}
        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-400">
            语言模型（LLM）
          </h2>
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <ReadOnlyField label="API Base URL" value={llm?.baseUrl ?? '—'} />
            <ReadOnlyField label="模型" value={llm?.model ?? '—'} />
            <ReadOnlyField
              label="状态"
              value={llm?.hasApiKey ? '已配置 API Key' : '未配置 API Key'}
              valueClass={llm?.hasApiKey ? 'text-emerald-400' : 'text-amber-400'}
            />
            <div className="flex items-center justify-between gap-4 border-t border-zinc-800 pt-3">
              <div>
                <p className="text-sm text-zinc-200">启用深度思考</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  开启后模型会投入更多推理，通常响应更慢并消耗更多 Token。
                </p>
                {llm && !llm.thinkingSupported && (
                  <p className="mt-1 text-xs text-amber-400">当前模型或服务不支持切换思考模式。</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleThinkingToggle()}
                disabled={!llm?.thinkingSupported || saveStatus.type === 'saving'}
                className={`relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
                  llm?.thinkingEnabled ? 'bg-indigo-600' : 'bg-zinc-700'
                }`}
                role="switch"
                aria-label="启用深度思考"
                aria-checked={llm?.thinkingEnabled ?? false}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    llm?.thinkingEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>
        </section>

        {/* TTS section — voice only */}
        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-400">
            语音合成（TTS）
          </h2>
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <ReadOnlyField label="API Base URL" value={tts?.baseUrl ?? '—'} />
            <ReadOnlyField label="模型" value={tts?.model ?? '—'} />
            <ReadOnlyField
              label="状态"
              value={tts?.hasApiKey ? '已配置 API Key' : '未配置 API Key'}
              valueClass={tts?.hasApiKey ? 'text-emerald-400' : 'text-amber-400'}
            />
            <Field label="声音（Voice）">
              <div className="flex flex-col gap-2 sm:flex-row">
                <select
                  value={voice}
                  onChange={(e) => {
                    setVoice(e.target.value);
                    setPreviewStatus({ type: 'idle' });
                  }}
                  className={inputClass}
                >
                  {voiceOptions.map((v) => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handlePreviewVoice}
                  disabled={!voice || previewStatus.type === 'loading'}
                  className="inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-100 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {previewStatus.type === 'loading' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                  {previewStatus.type === 'loading'
                    ? '生成中'
                    : previewStatus.type === 'playing'
                      ? '播放中'
                      : '试听音色'}
                </button>
              </div>
              {previewStatus.type === 'error' && (
                <p className="mt-2 text-xs text-red-400">{previewStatus.message}</p>
              )}
            </Field>
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-400">
            DJ 自动补歌
          </h2>
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div>
              <p className="text-sm text-zinc-200">每次补歌数量</p>
              <p className="mt-0.5 text-xs text-zinc-500">
                自动 DJ 每次最多追加的歌曲数。较大的数量会增加候选分析和等待时间。
              </p>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {AUTO_FILL_BATCH_SIZE_OPTIONS.map((size) => {
                const active = autoFillBatchSize === size;
                return (
                  <button
                    key={size}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setAutoFillBatchSize(size)}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                      active
                        ? 'border-cyan-500 bg-cyan-500/15 text-cyan-200'
                        : 'border-zinc-700 bg-zinc-950 text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800'
                    }`}
                  >
                    {size}首
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Daily Theme */}
        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-400">
            每日主题
          </h2>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-zinc-200">启用每日主题</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  关闭后，DJ 选曲和转场将不再参考每日主题
                </p>
              </div>
              <button
                onClick={handleDailyThemeToggle}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  dailyThemeEnabled ? 'bg-indigo-600' : 'bg-zinc-700'
                }`}
                role="switch"
                aria-checked={dailyThemeEnabled}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    dailyThemeEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>
        </section>

        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-400">
            Personal Context / Integrations
          </h2>
          <PersonalContextStatusIndicator status={personalContextOpStatus} />
          <div className="space-y-5 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <ReadOnlyField
                label="上下文状态"
                value={personalContextStatus?.currentActive ? 'Active' : personalContextStatus?.latest?.revokedAt ? 'Revoked' : '未上传'}
                valueClass={personalContextStatus?.currentActive ? 'text-emerald-400' : personalContextStatus?.latest ? 'text-amber-400' : 'text-zinc-500'}
              />
              <ReadOnlyField
                label="最近上传"
                value={formatDateTime(personalContextStatus?.latest?.uploadedAt)}
              />
              <ReadOnlyField
                label="来源"
                value={personalContextStatus?.latest?.sourceKind ?? '—'}
              />
              <ReadOnlyField
                label="保留记录"
                value={`${personalContextStatus?.retainedRecordCount ?? 0} 条，趋势 ${personalContextStatus?.trendCount ?? 0} 条`}
              />
            </div>
            {personalContextStatus?.latest?.summary && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                <p className="mb-1 text-xs font-medium uppercase tracking-wider text-zinc-500">当前摘要</p>
                <p className="text-sm leading-relaxed text-zinc-300">{personalContextStatus.latest.summary}</p>
              </div>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={newPersonalTokenName}
                onChange={(event) => setNewPersonalTokenName(event.target.value)}
                placeholder="Bridge Token 名称"
                className={inputClass}
              />
              <button
                type="button"
                onClick={handleCreatePersonalContextToken}
                disabled={personalTokenLimitReached || personalContextOpStatus.type === 'loading'}
                className="inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {personalContextOpStatus.type === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                创建 Bridge Token
              </button>
              <button
                type="button"
                onClick={handleRevokeCurrentPersonalContext}
                disabled={!personalContextStatus?.currentActive || personalContextOpStatus.type === 'loading'}
                className="inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-100 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                撤销当前上下文
              </button>
            </div>
            {personalTokenLimitReached && (
              <p className="text-xs text-amber-400">已达到 10 个 active Bridge Token 上限，请先撤销旧 Token。</p>
            )}
            {createdPersonalToken && (
              <div className="rounded-lg border border-amber-800 bg-amber-950/40 p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-amber-300">Bridge Token 明文只显示这一次</p>
                <code className="block break-all rounded bg-zinc-950 px-3 py-2 text-xs text-amber-100">{createdPersonalToken}</code>
              </div>
            )}
            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                Bridge Tokens
                {personalContextTokens.length > 0 && (
                  <span className="ml-1.5 text-zinc-600">({personalContextTokens.length})</span>
                )}
              </h3>
              {personalContextTokens.length === 0 ? (
                <p className="text-sm text-zinc-600">暂无 Bridge Token</p>
              ) : (
                <ul className="space-y-1">
                  {personalContextTokens.map((token) => (
                    <li key={token.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-zinc-800/50">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-zinc-200">{token.name}</span>
                          <span className={`rounded px-1.5 py-0.5 text-[11px] ${token.revokedAt ? 'bg-zinc-800 text-zinc-500' : 'bg-emerald-500/10 text-emerald-400'}`}>
                            {token.revokedAt ? 'revoked' : 'active'}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-xs text-zinc-500">
                          created {formatDateTime(token.createdAt)} · last used {formatDateTime(token.lastUsedAt)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleRevokePersonalContextToken(token.id)}
                        disabled={Boolean(token.revokedAt) || personalContextOpStatus.type === 'loading'}
                        className="rounded p-1 text-zinc-600 transition hover:bg-zinc-700 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
                        title="撤销 Bridge Token"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        {/* Taste Analysis */}
        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-400">
            音乐品味分析
          </h2>
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-sm text-zinc-400">
              基于你的网易云红心歌单，由 AI 分析音乐偏好并更新个人品味档案。
            </p>
            <button
              onClick={handleAnalyzeTaste}
              disabled={tasteStatus.type === 'analyzing'}
              className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {tasteStatus.type === 'analyzing' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {tasteStatus.type === 'analyzing' ? '分析中…' : '分析我的音乐品味'}
            </button>
            {tasteStatus.type === 'ok' && (
              <div className="rounded-lg border border-emerald-800 bg-emerald-900/30 p-3">
                <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                  <Check className="h-3.5 w-3.5" />
                  分析完成
                </div>
                <pre className="whitespace-pre-wrap text-xs text-emerald-200/80 leading-relaxed">{tasteStatus.taste}</pre>
              </div>
            )}
            {tasteStatus.type === 'error' && (
              <div className="flex items-center gap-2 rounded-lg border border-red-800 bg-red-900/30 px-3 py-2 text-sm text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {tasteStatus.message}
              </div>
            )}
          </div>
        </section>

        {/* Whitelist management */}
        {isAdmin ? (
        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-400">
            白名单管理
          </h2>
          <WhitelistStatusIndicator status={whitelistStatus} />
          <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            {/* Manual add */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newNcmId}
                onChange={(e) => setNewNcmId(e.target.value)}
                placeholder="输入网易云用户 ID"
                className={inputClass}
              />
              <button
                onClick={async () => {
                  if (!newNcmId.trim()) return;
                  setWhitelistStatus({ type: 'saving' });
                  try {
                    await addToWhitelist(newNcmId.trim());
                    setWhitelistStatus({ type: 'ok' });
                    setNewNcmId('');
                    await refreshWhitelist();
                  } catch (err) {
                    setWhitelistStatus({ type: 'error', message: err instanceof Error ? err.message : '添加失败' });
                  }
                  clearTimeout(statusTimerRef.current);
                  statusTimerRef.current = setTimeout(() => setWhitelistStatus({ type: 'idle' }), 3000);
                }}
                disabled={!newNcmId.trim() || whitelistStatus.type === 'saving'}
                className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50 shrink-0"
              >
                <UserPlus className="h-4 w-4" />
                添加
              </button>
            </div>

            {/* Current whitelist */}
            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                当前白名单
                {whitelist.length > 0 && (
                  <span className="ml-1.5 text-zinc-600">({whitelist.length})</span>
                )}
              </h3>
              {whitelist.length === 0 ? (
                <p className="text-sm text-zinc-600">暂无用户</p>
              ) : (
                <ul className="space-y-0.5">
                  {whitelist.map((id) => (
                    <li
                      key={id}
                      className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-zinc-800/50"
                    >
                      <span className="text-sm text-zinc-300 font-mono">{id}</span>
                      <button
                        onClick={async () => {
                          setWhitelistStatus({ type: 'saving' });
                          try {
                            await removeFromWhitelist(id);
                            setWhitelistStatus({ type: 'ok' });
                            await refreshWhitelist();
                          } catch (err) {
                            setWhitelistStatus({ type: 'error', message: err instanceof Error ? err.message : '移除失败' });
                          }
                          clearTimeout(statusTimerRef.current);
                          statusTimerRef.current = setTimeout(() => setWhitelistStatus({ type: 'idle' }), 3000);
                        }}
                        disabled={whitelistStatus.type === 'saving'}
                        className="rounded p-1 text-zinc-600 transition hover:bg-zinc-700 hover:text-red-400"
                        title="移除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Blocked attempts */}
            <div>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                被阻止的登录
                {blocked.length > 0 && (
                  <span className="ml-1.5 text-zinc-600">({blocked.length})</span>
                )}
              </h3>
              {blocked.length === 0 ? (
                <p className="text-sm text-zinc-600">暂无被阻止的用户</p>
              ) : (
                <ul className="space-y-1">
                  {blocked.map((b) => {
                    const nickname = parseProfile(b.profile_json);
                    return (
                      <li
                        key={b.id}
                        className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-zinc-800/50"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="text-sm text-zinc-300 font-mono">{b.ncm_id}</span>
                          <div className="flex items-center gap-2 text-xs text-zinc-500">
                            {nickname && <span>{nickname}</span>}
                            <span>{new Date(b.attempted_at).toLocaleString()}</span>
                          </div>
                        </div>
                        <button
                          onClick={async () => {
                            setWhitelistStatus({ type: 'saving' });
                            try {
                              await unblockUser(b.id);
                              setWhitelistStatus({ type: 'ok' });
                              await refreshWhitelist();
                            } catch (err) {
                              setWhitelistStatus({ type: 'error', message: err instanceof Error ? err.message : '放行失败' });
                            }
                            clearTimeout(statusTimerRef.current);
                            statusTimerRef.current = setTimeout(() => setWhitelistStatus({ type: 'idle' }), 3000);
                          }}
                          disabled={whitelistStatus.type === 'saving'}
                          className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-emerald-500 transition hover:bg-emerald-500/10 shrink-0"
                          title="加入白名单"
                        >
                          <Shield className="h-3.5 w-3.5" />
                          放行
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </section>
        ) : (
        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-400">
            白名单管理
          </h2>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-sm text-zinc-500">需要管理员权限才能管理白名单。当前账号不是管理员。</p>
          </div>
        </section>
        )}
      </div>

      {/* Footer save bar */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950 px-4 md:px-6 py-4">
        <div className="min-w-0 flex-1">
          <StatusIndicator status={saveStatus} />
        </div>
        <button
          onClick={handleSave}
          disabled={disabled || saveStatus.type === 'saving'}
          className="flex shrink-0 items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {saveStatus.type === 'saving' && <Loader2 className="h-4 w-4 animate-spin" />}
          保存
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[100px_1fr] md:grid-cols-[120px_1fr] items-center gap-3">
      <label className="text-sm text-zinc-400">{label}</label>
      {children}
    </div>
  );
}

function ReadOnlyField({
  label,
  value,
  valueClass
}: {
  label: string;
  value: string;
  valueClass?: string;
}): JSX.Element {
  return (
    <div className="grid grid-cols-[100px_1fr] md:grid-cols-[120px_1fr] items-center gap-3">
      <label className="text-sm text-zinc-400">{label}</label>
      <span className={`text-sm ${valueClass ?? 'text-zinc-100'}`}>{value}</span>
    </div>
  );
}

function StatusIndicator({ status }: { status: SaveStatus }): JSX.Element {
  if (status.type === 'ok') {
    return (
      <span className="flex items-center gap-1.5 text-sm text-emerald-400">
        <Check className="h-4 w-4" /> 已保存
      </span>
    );
  }
  if (status.type === 'error') {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-sm text-red-400">
        <AlertCircle className="h-4 w-4 shrink-0" /> <span className="truncate">{status.message}</span>
      </span>
    );
  }
  return <span />;
}

function WhitelistStatusIndicator({ status }: { status: WhitelistOpStatus }): JSX.Element {
  if (status.type === 'saving') {
    return (
      <span className="flex items-center gap-1.5 text-sm text-zinc-400">
        <Loader2 className="h-4 w-4 animate-spin" /> 处理中...
      </span>
    );
  }
  if (status.type === 'ok') {
    return (
      <span className="flex items-center gap-1.5 text-sm text-emerald-400">
        <Check className="h-4 w-4" /> 操作成功
      </span>
    );
  }
  if (status.type === 'error') {
    return (
      <span className="flex items-center gap-1.5 text-sm text-red-400">
        <AlertCircle className="h-4 w-4" /> {status.message}
      </span>
    );
  }
  return <span />;
}

function PersonalContextStatusIndicator({ status }: { status: PersonalContextOpStatus }): JSX.Element {
  if (status.type === 'loading') {
    return (
      <span className="mb-2 flex items-center gap-1.5 text-sm text-zinc-400">
        <Loader2 className="h-4 w-4 animate-spin" /> 处理中...
      </span>
    );
  }
  if (status.type === 'ok') {
    return (
      <span className="mb-2 flex items-center gap-1.5 text-sm text-emerald-400">
        <Check className="h-4 w-4" /> {status.message}
      </span>
    );
  }
  if (status.type === 'error') {
    return (
      <span className="mb-2 flex items-center gap-1.5 text-sm text-red-400">
        <AlertCircle className="h-4 w-4" /> {status.message}
      </span>
    );
  }
  return <span />;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500';
