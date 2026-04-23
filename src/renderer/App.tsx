import { useEffect, useState } from 'react';
import { healthResponseSchema, type HealthResponse } from '@shared/schema';

const runtime = window.crossfadio?.getRuntimeConfig();

export function App(): JSX.Element {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ncmStatus, setNcmStatus] = useState<Record<string, unknown> | null>(null);
  const [ncmSession, setNcmSession] = useState<Record<string, unknown> | null>(null);
  const [qrPayload, setQrPayload] = useState<{ key: string; qrimg: string } | null>(null);
  const [qrCheckResult, setQrCheckResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let mounted = true;

    async function fetchHealth(): Promise<void> {
      try {
        const response = await fetch(`${runtime.baseUrl}/api/health`);
        const json = await response.json();
        const parsed = healthResponseSchema.parse(json);

        if (mounted) {
          setHealth(parsed);
          setError('');
        }

        const ncmResponse = await fetch(`${runtime.baseUrl}/api/ncm/status`);
        if (ncmResponse.ok) {
          const ncmJson = (await ncmResponse.json()) as Record<string, unknown>;
          if (mounted) {
            setNcmStatus(ncmJson);
          }
        }

        const sessionResponse = await fetch(`${runtime.baseUrl}/api/ncm/login/session`);
        if (sessionResponse.ok) {
          const sessionJson = (await sessionResponse.json()) as Record<string, unknown>;
          if (mounted) {
            setNcmSession(sessionJson);
          }
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'unknown error');
        }
      }
    }

    void fetchHealth();

    return () => {
      mounted = false;
    };
  }, []);

  async function createQr(): Promise<void> {
    try {
      const response = await fetch(`${runtime.baseUrl}/api/ncm/login/qr`);
      const json = (await response.json()) as { key: string; qrimg: string };
      setQrPayload({ key: json.key, qrimg: json.qrimg });
      setQrCheckResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create qr');
    }
  }

  async function checkQr(): Promise<void> {
    if (!qrPayload?.key) {
      setError('qr key is missing');
      return;
    }

    try {
      const response = await fetch(
        `${runtime.baseUrl}/api/ncm/login/status?key=${encodeURIComponent(qrPayload.key)}`
      );
      const json = (await response.json()) as Record<string, unknown>;
      setQrCheckResult(json);

      const sessionResponse = await fetch(`${runtime.baseUrl}/api/ncm/login/session`);
      if (sessionResponse.ok) {
        const sessionJson = (await sessionResponse.json()) as Record<string, unknown>;
        setNcmSession(sessionJson);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to check qr');
    }
  }

  async function logoutNcm(): Promise<void> {
    try {
      await fetch(`${runtime.baseUrl}/api/ncm/login/logout`, { method: 'POST' });
      setQrPayload(null);
      setQrCheckResult(null);

      const sessionResponse = await fetch(`${runtime.baseUrl}/api/ncm/login/session`);
      if (sessionResponse.ok) {
        const sessionJson = (await sessionResponse.json()) as Record<string, unknown>;
        setNcmSession(sessionJson);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to logout');
    }
  }

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-8 text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-6 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-6 shadow-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">Crossfadio · M0 工程骨架</h1>

        <section className="space-y-2 text-sm text-zinc-300">
          <p>Base URL: {runtime.baseUrl || '(empty)'}</p>
          <p>WS URL: {runtime.wsUrl || '(empty)'}</p>
          <p>Session Token: {runtime.sessionToken ? 'ready' : 'missing'}</p>
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4">
          <h2 className="mb-2 text-sm font-medium uppercase text-zinc-400">Health</h2>
          {health ? (
            <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-emerald-300">
              {JSON.stringify(health, null, 2)}
            </pre>
          ) : (
            <p className="text-sm text-zinc-400">loading...</p>
          )}
          {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
        </section>

        <section className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4">
          <h2 className="mb-2 text-sm font-medium uppercase text-zinc-400">NCM Runtime</h2>
          {ncmStatus ? (
            <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-cyan-300">
              {JSON.stringify(ncmStatus, null, 2)}
            </pre>
          ) : (
            <p className="text-sm text-zinc-400">loading...</p>
          )}
        </section>

        <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-950/70 p-4">
          <h2 className="text-sm font-medium uppercase text-zinc-400">NCM Login (M1-02)</h2>
          <div className="flex flex-wrap gap-2">
            <button className="rounded bg-zinc-700 px-3 py-1.5 text-xs" onClick={createQr} type="button">
              创建二维码
            </button>
            <button className="rounded bg-zinc-700 px-3 py-1.5 text-xs" onClick={checkQr} type="button">
              查询扫码状态
            </button>
            <button className="rounded bg-zinc-700 px-3 py-1.5 text-xs" onClick={logoutNcm} type="button">
              退出登录
            </button>
          </div>

          {qrPayload?.qrimg ? (
            <img alt="ncm login qr" className="h-40 w-40 rounded border border-zinc-700 bg-white p-1" src={qrPayload.qrimg} />
          ) : null}

          {qrCheckResult ? (
            <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-amber-300">
              {JSON.stringify(qrCheckResult, null, 2)}
            </pre>
          ) : null}

          <pre className="overflow-auto rounded bg-zinc-900 p-3 text-xs text-blue-300">
            {JSON.stringify(ncmSession ?? { loading: true }, null, 2)}
          </pre>
        </section>
      </div>
    </main>
  );
}
