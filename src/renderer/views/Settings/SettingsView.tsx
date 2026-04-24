import { useEffect, useState } from 'react';
import { Settings2, Check, AlertCircle, Loader2 } from 'lucide-react';
import { getSettings, saveSettings, type SaveSettingsPayload } from '@renderer/api';

type Status = { type: 'idle' } | { type: 'saving' } | { type: 'ok' } | { type: 'error'; message: string };

type LlmForm = { baseUrl: string; model: string; apiKey: string };
type TtsProvider = 'openai-compatible' | 'aliyun-qwen';
type TtsForm = {
  provider: TtsProvider;
  baseUrl: string;
  model: string;
  voice: string;
  speed: string;
  format: string;
  apiKey: string;
};

const DEFAULT_LLM: LlmForm = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: '' };
const DEFAULT_TTS: TtsForm = {
  provider: 'aliyun-qwen',
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
  model: 'qwen-tts',
  voice: 'Cherry',
  speed: '1.0',
  format: 'mp3',
  apiKey: ''
};

export function SettingsView(): JSX.Element {
  const [llm, setLlm] = useState<LlmForm>(DEFAULT_LLM);
  const [tts, setTts] = useState<TtsForm>(DEFAULT_TTS);
  const [status, setStatus] = useState<Status>({ type: 'idle' });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSettings()
      .then((s) => {
        if (s.llm) {
          setLlm({ baseUrl: s.llm.baseUrl, model: s.llm.model, apiKey: s.llm.hasApiKey ? '••••••••' : '' });
        }
        if (s.tts) {
          setTts({
            provider: s.tts.provider ?? 'aliyun-qwen',
            baseUrl: s.tts.baseUrl,
            model: s.tts.model,
            voice: s.tts.voice,
            speed: String(s.tts.speed),
            format: s.tts.format,
            apiKey: s.tts.hasApiKey ? '••••••••' : ''
          });
        }
      })
      .catch(() => {/* first launch, no config yet */})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave(): Promise<void> {
    setStatus({ type: 'saving' });
    try {
      const payload: SaveSettingsPayload = {};

      const isApiKeyPlaceholder = (v: string) => v === '••••••••';

      payload.llm = {
        baseUrl: llm.baseUrl.trim(),
        model: llm.model.trim(),
        ...(llm.apiKey && !isApiKeyPlaceholder(llm.apiKey) && { apiKey: llm.apiKey.trim() })
      };

      payload.tts = {
        provider: tts.provider,
        baseUrl: tts.baseUrl.trim(),
        model: tts.model.trim(),
        voice: tts.voice.trim(),
        speed: parseFloat(tts.speed) || 1.0,
        format: tts.format as 'mp3' | 'opus' | 'aac' | 'flac',
        ...(tts.apiKey && !isApiKeyPlaceholder(tts.apiKey) && { apiKey: tts.apiKey.trim() })
      };

      await saveSettings(payload);
      setStatus({ type: 'ok' });
      setTimeout(() => setStatus({ type: 'idle' }), 2000);
    } catch (err) {
      setStatus({ type: 'error', message: err instanceof Error ? err.message : '保存失败' });
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-6 py-4">
        <Settings2 className="h-5 w-5 text-zinc-400" />
        <h1 className="text-lg font-semibold">设置</h1>
      </div>

      <div className="flex-1 space-y-8 px-6 py-6">
        {/* LLM section */}
        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-400">
            语言模型（LLM）
          </h2>
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <Field label="API Base URL">
              <input
                type="url"
                value={llm.baseUrl}
                onChange={(e) => setLlm({ ...llm, baseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
                className={inputClass}
              />
            </Field>
            <Field label="模型">
              <input
                type="text"
                value={llm.model}
                onChange={(e) => setLlm({ ...llm, model: e.target.value })}
                placeholder="gpt-4o"
                className={inputClass}
              />
            </Field>
            <Field label="API Key">
              <input
                type="password"
                value={llm.apiKey}
                onChange={(e) => setLlm({ ...llm, apiKey: e.target.value })}
                placeholder="sk-…（留空保持不变）"
                className={inputClass}
                autoComplete="off"
              />
            </Field>
          </div>
        </section>

        {/* TTS section */}
        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-zinc-400">
            语音合成（TTS）
          </h2>
          <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <Field label="供应商">
              <select
                value={tts.provider}
                onChange={(e) => {
                  const provider = e.target.value as TtsProvider;
                  setTts({
                    ...tts,
                    provider,
                    baseUrl:
                      provider === 'aliyun-qwen'
                        ? 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
                        : 'https://api.openai.com/v1',
                    model: provider === 'aliyun-qwen' ? 'qwen-tts' : 'tts-1',
                    voice: provider === 'aliyun-qwen' ? 'Cherry' : 'alloy'
                  });
                }}
                className={inputClass}
              >
                <option value="aliyun-qwen">阿里云 Qwen TTS</option>
                <option value="openai-compatible">OpenAI 兼容</option>
              </select>
            </Field>
            <Field label="API Base URL">
              <input
                type="url"
                value={tts.baseUrl}
                onChange={(e) => setTts({ ...tts, baseUrl: e.target.value })}
                placeholder="https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
                className={inputClass}
              />
            </Field>
            <Field label="模型">
              <input
                type="text"
                value={tts.model}
                onChange={(e) => setTts({ ...tts, model: e.target.value })}
                placeholder="qwen-tts"
                className={inputClass}
              />
            </Field>
            <Field label="声音（Voice）">
              <select
                value={tts.voice}
                onChange={(e) => setTts({ ...tts, voice: e.target.value })}
                className={inputClass}
              >
                {(tts.provider === 'aliyun-qwen'
                  ? ['Cherry', 'Ethan', 'Chelsie', 'Serena', 'Dylan']
                  : ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']
                ).map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </Field>
            <Field label="语速">
              <input
                type="number"
                value={tts.speed}
                min="0.25"
                max="4.0"
                step="0.05"
                onChange={(e) => setTts({ ...tts, speed: e.target.value })}
                className={inputClass}
              />
            </Field>
            <Field label="格式">
              <select
                value={tts.format}
                onChange={(e) => setTts({ ...tts, format: e.target.value })}
                className={inputClass}
              >
                {['mp3', 'opus', 'aac', 'flac'].map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </Field>
            <Field label="API Key">
              <input
                type="password"
                value={tts.apiKey}
                onChange={(e) => setTts({ ...tts, apiKey: e.target.value })}
                placeholder="sk-…（留空保持不变）"
                className={inputClass}
                autoComplete="off"
              />
            </Field>
          </div>
        </section>
      </div>

      {/* Footer save bar */}
      <div className="sticky bottom-0 flex items-center justify-between border-t border-zinc-800 bg-zinc-950 px-6 py-4">
        <StatusIndicator status={status} />
        <button
          onClick={handleSave}
          disabled={status.type === 'saving'}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {status.type === 'saving' && <Loader2 className="h-4 w-4 animate-spin" />}
          保存
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-3">
      <label className="text-sm text-zinc-400">{label}</label>
      {children}
    </div>
  );
}

function StatusIndicator({ status }: { status: Status }): JSX.Element {
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
