import { useEffect, useState } from 'react';
import { Settings2, Check, AlertCircle, Loader2 } from 'lucide-react';
import { getSettings, saveSettings, type LlmSettings, type TtsSettings } from '@renderer/api';

type SaveStatus = { type: 'idle' } | { type: 'saving' } | { type: 'ok' } | { type: 'error'; message: string };

export function SettingsView(): JSX.Element {
  const [llm, setLlm] = useState<LlmSettings | null>(null);
  const [tts, setTts] = useState<TtsSettings | null>(null);
  const [voice, setVoice] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ type: 'idle' });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSettings()
      .then((s) => {
        setLlm(s.llm);
        setTts(s.tts);
        setVoice(s.tts.voice);
      })
      .catch(() => {/* first launch, no config yet */})
      .finally(() => setLoading(false));
  }, []);

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

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500';
