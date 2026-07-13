import { z } from 'zod';

export const llmThinkingControlSchema = z.object({
  type: z.enum(['enabled', 'disabled'])
});

export type LlmThinkingControl = z.infer<typeof llmThinkingControlSchema>;

export const llmConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  thinking: llmThinkingControlSchema.optional()
});

export type LlmConfig = z.infer<typeof llmConfigSchema>;

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlmUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type LlmResponse = {
  content: string;
  model: string;
  usage?: LlmUsage;
};

export type LlmResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: {
        name: string;
        strict?: boolean;
        schema: Record<string, unknown>;
      };
    };

export type LlmCompleteOptions = {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: LlmResponseFormat;
  thinking?: LlmThinkingControl;
  signal?: AbortSignal;
};

const ERROR_BODY_MAX_CHARS = 2_000;
const RATE_LIMIT_STATUS = 429;
const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_BASE_DELAY_MS = 750;
const RATE_LIMIT_MAX_DELAY_MS = 5_000;
const TOKENHUB_HY3_THINKING_MAX_TOKENS = 128_000;

export class LlmClient {
  constructor(private readonly config: LlmConfig) {}

  async complete(messages: LlmMessage[], opts: LlmCompleteOptions = {}): Promise<LlmResponse> {
    const body = buildRequestBody(this.config.model, messages, {
      baseUrl: this.config.baseUrl,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      responseFormat: opts.responseFormat,
      thinking: opts.thinking ?? this.config.thinking
    });

    const resp = await fetchChatCompletions(this.config, body, opts.signal);

    if (!resp.ok) {
      await throwLlmHttpError('LLM request failed', resp);
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      model?: string;
      usage?: LlmUsage;
    };

    const content = data.choices?.[0]?.message?.content ?? '';
    return { content, model: data.model ?? this.config.model, usage: data.usage };
  }

  async *stream(messages: LlmMessage[], opts: LlmCompleteOptions = {}): AsyncIterable<string> {
    const body = buildRequestBody(this.config.model, messages, {
      baseUrl: this.config.baseUrl,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      responseFormat: opts.responseFormat,
      thinking: opts.thinking ?? this.config.thinking,
      stream: true
    });

    const resp = await fetchChatCompletions(this.config, body, opts.signal);

    if (!resp.ok) {
      await throwLlmHttpError('LLM stream request failed', resp);
    }

    if (!resp.body) {
      throw new LlmError('LLM stream response has no body');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // skip malformed SSE chunk
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
}

function buildRequestBody(
  model: string,
  messages: LlmMessage[],
  opts: {
    baseUrl: string;
    temperature?: number;
    maxTokens?: number;
    responseFormat?: LlmResponseFormat;
    thinking?: LlmThinkingControl;
    stream?: boolean;
  }
) {
  const maxTokens = resolveMaxTokensForThinking(model, opts.baseUrl, opts.thinking, opts.maxTokens);
  return {
    model,
    messages,
    ...(opts.stream !== undefined && { stream: opts.stream }),
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    ...(maxTokens !== undefined && { max_tokens: maxTokens }),
    ...(opts.responseFormat !== undefined && { response_format: opts.responseFormat }),
    ...(opts.thinking !== undefined && supportsThinkingControl(model, opts.baseUrl) && { thinking: opts.thinking })
  };
}

function resolveMaxTokensForThinking(
  model: string,
  baseUrl: string,
  thinking: LlmThinkingControl | undefined,
  requestedMaxTokens: number | undefined
): number | undefined {
  const normalizedModel = model.toLowerCase();
  const normalizedBaseUrl = baseUrl.toLowerCase();
  const isTokenHubHy3 = normalizedBaseUrl.includes('tokenhub.tencentmaas.com')
    && (normalizedModel === 'hy3' || normalizedModel === 'hy3-preview');
  if (thinking?.type !== 'enabled' || !isTokenHubHy3) return requestedMaxTokens;
  return TOKENHUB_HY3_THINKING_MAX_TOKENS;
}

export function supportsThinkingControl(model: string, baseUrl: string): boolean {
  const normalizedModel = model.toLowerCase();
  const normalizedBaseUrl = baseUrl.toLowerCase();
  if (normalizedModel.startsWith('deepseek-v4') || normalizedBaseUrl.includes('api.deepseek.com')) {
    return true;
  }
  if (!normalizedBaseUrl.includes('tokenhub.tencentmaas.com')) return false;
  return TOKENHUB_THINKING_CONTROL_MODELS.has(normalizedModel);
}

// Models documented by TokenHub as accepting both enabled and disabled.
// Models whose thinking mode cannot be disabled are intentionally excluded.
const TOKENHUB_THINKING_CONTROL_MODELS = new Set([
  'hy3',
  'hy3-preview',
  'deepseek-v3.2',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'glm-5',
  'glm-5-turbo',
  'glm-5v-turbo',
  'glm-5.1',
  'kimi-k2.5',
  'kimi-k2.6'
]);

async function fetchChatCompletions(
  config: LlmConfig,
  body: ReturnType<typeof buildRequestBody>,
  signal?: AbortSignal
): Promise<Response> {
  for (let retry = 0; ; retry += 1) {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(config.apiKey),
      body: JSON.stringify(body),
      signal
    });

    if (response.status !== RATE_LIMIT_STATUS || retry >= RATE_LIMIT_MAX_RETRIES) {
      return response;
    }

    const delayMs = getRateLimitRetryDelayMs(response, retry);
    await discardResponseBody(response);
    await waitForRetryDelay(delayMs, signal);
  }
}

function getRateLimitRetryDelayMs(response: Response, retry: number): number {
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
  const delayMs = retryAfterMs ?? RATE_LIMIT_BASE_DELAY_MS * (2 ** retry);
  return Math.min(delayMs, RATE_LIMIT_MAX_DELAY_MS);
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return undefined;
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore retry-body cleanup failures; the next attempt is more useful than surfacing them.
  }
}

function waitForRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }

    if (signal.aborted) {
      reject(getAbortReason(signal));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = (): void => {
      clearTimeout(timeout);
      cleanup();
      reject(getAbortReason(signal));
    };

    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function getAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export class LlmError extends Error {
  readonly status?: number;
  readonly statusText?: string;
  readonly responseBody?: string;

  constructor(message: string, options: { status?: number; statusText?: string; responseBody?: string } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = options.status;
    this.statusText = options.statusText;
    this.responseBody = options.responseBody;
  }
}

async function throwLlmHttpError(prefix: string, response: Response): Promise<never> {
  const responseBody = await readErrorBody(response);
  throw new LlmError(formatLlmHttpError(prefix, response, responseBody), {
    status: response.status,
    statusText: response.statusText,
    responseBody
  });
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (trimmed.length <= ERROR_BODY_MAX_CHARS) {
      return trimmed;
    }
    return `${trimmed.slice(0, ERROR_BODY_MAX_CHARS)}...`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `failed to read response body: ${message}`;
  }
}

function formatLlmHttpError(prefix: string, response: Response, responseBody: string): string {
  const status = response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
  return responseBody ? `${prefix}: ${status}; response body: ${responseBody}` : `${prefix}: ${status}`;
}
