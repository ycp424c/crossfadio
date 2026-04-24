import { LlmClient, type LlmConfig } from '../llm/client.js';
import { assembleMessages } from './fragments.js';
import {
  agentOutputSchema,
  type AgentEvent,
  type AgentOutput,
  type Fragments
} from './schema.js';

export type ComputeOptions = {
  llmConfig: LlmConfig;
  stream?: boolean;
  signal?: AbortSignal;
};

/**
 * Non-streaming: plan mode (and any non-stream call).
 * Returns a validated AgentOutput, retrying once on schema failure.
 */
export async function computeSync(
  fragments: Fragments,
  opts: ComputeOptions
): Promise<AgentOutput> {
  const client = new LlmClient(opts.llmConfig);
  const messages = assembleMessages(fragments);

  const raw = await client.complete(messages, { signal: opts.signal });
  const parsed = tryParseOutput(raw.content, fragments.mode);

  if (parsed.ok) {
    return parsed.value;
  }

  // Retry once with the validation error appended
  const retryMessages = [
    ...messages,
    { role: 'assistant' as const, content: raw.content },
    {
      role: 'user' as const,
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
  const client = new LlmClient(opts.llmConfig);
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

  // Retry (non-streaming for simplicity on second attempt)
  const retryMessages = [
    ...messages,
    { role: 'assistant' as const, content: fullContent },
    {
      role: 'user' as const,
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
  // Strip optional markdown code fences
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

  // Inject mode if missing (LLM sometimes omits it)
  if (json && typeof json === 'object' && !('mode' in (json as object))) {
    (json as Record<string, unknown>).mode = mode;
  }

  const result = agentOutputSchema.safeParse(json);
  if (result.success) {
    return { ok: true, value: result.data };
  }

  return {
    ok: false,
    error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  };
}

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}
