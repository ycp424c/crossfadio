import { useEffect, useState } from 'react';
import { healthResponseSchema, type HealthResponse } from '@shared/schema';

const runtime = window.crossfadio?.getRuntimeConfig();

export function App(): JSX.Element {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ncmStatus, setNcmStatus] = useState<Record<string, unknown> | null>(null);
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
      </div>
    </main>
  );
}
