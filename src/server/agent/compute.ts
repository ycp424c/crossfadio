import { LlmClient, type LlmConfig, type LlmMessage, type LlmResponse } from '../llm/client.js';
import { assembleMessages } from './fragments.js';
import {
  agentOutputSchema,
  type AgentEvent,
  type AgentOutput,
  type Fragments
} from './schema.js';

/** Minimal interface a client must satisfy for compute(). Allows injection of fakes in tests. */
export interface LlmClientLike {
  complete(messages: LlmMessage[], opts?: { signal?: AbortSignal }): Promise<LlmResponse>;
  stream(messages: LlmMessage[], opts?: { signal?: AbortSignal }): AsyncIterable<string>;
}

export type ComputeOptions = {
  llmConfig?: LlmConfig;
  /** Override the LLM client — used by tests to inject FakeLlmClient. */
  llmClient?: LlmClientLike;
  signal?: AbortSignal;
};

function resolveClient(opts: ComputeOptions): LlmClientLike {
  if (opts.llmClient) return opts.llmClient;
  if (opts.llmConfig) return new LlmClient(opts.llmConfig);
  throw new AgentError('ComputeOptions must provide either llmConfig or llmClient');
}

/**
 * Non-streaming: plan mode (and any non-stream call).
 * Returns a validated AgentOutput, retrying once on schema failure.
 */
export async function computeSync(
  fragments: Fragments,
  opts: ComputeOptions
): Promise<AgentOutput> {
  const client = resolveClient(opts);
  const messages = assembleMessages(fragments);

  const raw = await client.complete(messages, { signal: opts.signal });
  const parsed = tryParseOutput(raw.content, fragments.mode);

  if (parsed.ok) {
    return parsed.value;
  }

  const retryMessages: LlmMessage[] = [
    ...messages,
    { role: 'assistant', content: raw.content },
    {
      role: 'user',
      content: `上次输出未通过 JSON schema 校验：${parsed.error}\n请重新生成，严格按照要求的 JSON 格式输出。`
    }
  ];

  const retryRaw = await client.complete(retryMessages, { signal: opts.signal });
  const retryParsed = tryParseOutput(retryRaw.content, fragments.mode);

  if (retryParsed.ok) {
    return retryParsed.value;
  }

  throw new AgentError(
    `Agent output failed schema validation after retry: ${retryParsed.error}`
  );
}

/**
 * Streaming: segue / chat mode.
 * Yields delta.say tokens, then a final done event with the validated output.
 * On consecutive schema failures (2 attempts), throws AgentError.
 */
export async function* computeStream(
  fragments: Fragments,
  opts: ComputeOptions
): AsyncIterable<AgentEvent> {
  const client = resolveClient(opts);
  const messages = assembleMessages(fragments);

  let fullContent = '';
  for await (const delta of client.stream(messages, { signal: opts.signal })) {
    fullContent += delta;
    yield { type: 'delta', say: delta };
  }

  const parsed = tryParseOutput(fullContent, fragments.mode);
  if (parsed.ok) {
    yield { type: 'done', output: parsed.value };
    return;
  }

  const retryMessages: LlmMessage[] = [
    ...messages,
    { role: 'assistant', content: fullContent },
    {
      role: 'user',
      content: `上次输出未通过 JSON schema 校验：${parsed.error}\n请重新生成，严格按照要求的 JSON 格式输出。`
    }
  ];

  const retryRaw = await client.complete(retryMessages, { signal: opts.signal });
  const retryParsed = tryParseOutput(retryRaw.content, fragments.mode);

  if (retryParsed.ok) {
    yield { type: 'done', output: retryParsed.value };
    return;
  }

  throw new AgentError(
    `Agent stream output failed schema validation after retry: ${retryParsed.error}`
  );
}

type ParseResult =
  | { ok: true; value: AgentOutput }
  | { ok: false; error: string };

function tryParseOutput(raw: string, mode: Fragments['mode']): ParseResult {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    return { ok: false, error: `不是合法 JSON: ${cleaned.slice(0, 100)}` };
  }

  if (json && typeof json === 'object' && !('mode' in (json as object))) {
    (json as Record<string, unknown>).mode = mode;
  }

  json = normalizeOutput(json, mode);

  const result = agentOutputSchema.safeParse(json);
  if (result.success) {
    return { ok: true, value: result.data };
  }

  return {
    ok: false,
    error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  };
}

function normalizeOutput(json: unknown, mode: Fragments['mode']): unknown {
  if (!json || typeof json !== 'object') {
    return json;
  }

  if (mode !== 'chat') {
    return json;
  }

  const output = { ...(json as Record<string, unknown>) };
  const actions = output.actions;
  if (Array.isArray(actions)) {
    output.actions = actions.map((action) => normalizeChatAction(action));
  }

  return output;
}

function normalizeChatAction(action: unknown): unknown {
  if (!action || typeof action !== 'object') {
    return action;
  }

  const candidate = action as Record<string, unknown>;
  if (candidate.type !== 'play') {
    return action;
  }

  const query = extractTrackQuery(candidate);
  if (!query) {
    return action;
  }

  return {
    type: 'swap_next',
    pick: {
      query
    }
  };
}

function extractTrackQuery(action: Record<string, unknown>): string | null {
  const track = typeof action.track === 'string' ? action.track.trim() : '';
  if (track) {
    return track;
  }

  const query = typeof action.query === 'string' ? action.query.trim() : '';
  if (query) {
    return query;
  }

  const title = typeof action.title === 'string' ? action.title.trim() : '';
  const artist = typeof action.artist === 'string' ? action.artist.trim() : '';
  const combined = [title, artist].filter(Boolean).join(' ');
  return combined || null;
}

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}
