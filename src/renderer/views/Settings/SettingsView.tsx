import { useCallback, useEffect, useRef, useState } from 'react';
import { Settings2, Check, AlertCircle, Loader2, Trash2, UserPlus, Shield, Sparkles } from 'lucide-react';
import {
  getSettings,
  saveSettings,
  getWhitelist,
  getBlockedAttempts,
  addToWhitelist,
  removeFromWhitelist,
  unblockUser,
  analyzeTaste,
  type LlmSettings,
  type TtsSettings,
  type BlockedAttempt
} from '@renderer/api';

type SaveStatus = { type: 'idle' } | { type: 'saving' } | { type: 'ok' } | { type: 'error'; message: string };
type WhitelistOpStatus = { type: 'idle' } | { type: 'saving' } | { type: 'ok' } | { type: 'error'; message: string };

export function SettingsView(): JSX.Element {
  const [llm, setLlm] = useState<LlmSettings | null>(null);
  const [tts, setTts] = useState<TtsSettings | null>(null);
  const [voice, setVoice] = useState('');
  const [dailyThemeEnabled, setDailyThemeEnabled] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ type: 'idle' });
  const [loading, setLoading] = useState(true);
  const [whitelist, setWhitelist] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<BlockedAttempt[]>([]);
  const [newNcmId, setNewNcmId] = useState('');
  const [whitelistStatus, setWhitelistStatus] = useState<WhitelistOpStatus>({ type: 'idle' });
  const [isAdmin, setIsAdmin] = useState(true);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>();
type TasteStatus = { type: 'idle' } | { type: 'analyzing' } | { type: 'ok'; taste: string } | { type: 'error'; message: string };

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

  useEffect(() => {
    Promise.all([
      getSettings()
        .then((s) => {
          setLlm(s.llm);
          setTts(s.tts);
          setVoice(s.tts.voice);
          setDailyThemeEnabled(s.dailyThemeEnabled);
        }),
      getWhitelist()
        .then((w) => setWhitelist(w.entries))
        .catch(() => setIsAdmin(false)),
      getBlockedAttempts()
        .then((b) => setBlocked(b.blocked))
        .catch(() => {})
    ])
      .catch(() => {/* first launch, no config yet */})
      .finally(() => setLoading(false));

    return () => clearTimeout(statusTimerRef.current);
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
      await saveSettings({ tts: { voice } });
      setSaveStatus({ type: 'ok' });
      setTimeout(() => setSaveStatus({ type: 'idle' }), 2000);
    } catch (err) {
      setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : '保存失败' });
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

  const disabled = voice === tts?.voice;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-zinc-950 text-zinc-100">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 md:px-6 py-4">
        <Settings2 className="h-5 w-5 text-zinc-400" />
        <h1 className="text-lg font-semibold">设置</h1>
      </div>

      <div className="flex-1 space-y-8 px-4 py-4 md:px-6 md:py-6">
        {/* LLM section — read-only */}
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
          </div>
        </section>

        {/* TTS section — voice only */}
        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-400">
            语音合成（TTS）
          </h2>
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <ReadOnlyField label="API Base URL" value={tts?.baseUrl ?? '—'} />
            <ReadOnlyField
              label="状态"
              value={tts?.hasApiKey ? '已配置 API Key' : '未配置 API Key'}
              valueClass={tts?.hasApiKey ? 'text-emerald-400' : 'text-amber-400'}
            />
            <Field label="声音（Voice）">
              <select
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                className={inputClass}
              >
                {['Cherry', 'Ethan', 'Chelsie', 'Serena', 'Dylan'].map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </Field>
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
      <div className="sticky bottom-0 flex items-center justify-between border-t border-zinc-800 bg-zinc-950 px-4 md:px-6 py-4">
        <StatusIndicator status={saveStatus} />
        <button
          onClick={handleSave}
          disabled={disabled || saveStatus.type === 'saving'}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
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
      <span className="flex items-center gap-1.5 text-sm text-red-400">
        <AlertCircle className="h-4 w-4" /> {status.message}
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

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500';
