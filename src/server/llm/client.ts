import { z } from 'zod';

export const llmConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1)
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

export type LlmCompleteOptions = {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export class LlmClient {
  constructor(private readonly config: LlmConfig) {}

  async complete(messages: LlmMessage[], opts: LlmCompleteOptions = {}): Promise<LlmResponse> {
    const body = buildRequestBody(this.config.model, messages, {
      temperature: opts.temperature,
      maxTokens: opts.maxTokens
    });

    const resp = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(this.config.apiKey),
      body: JSON.stringify(body),
      signal: opts.signal
    });

    if (!resp.ok) {
      throw new LlmError(`LLM request failed: ${resp.status} ${resp.statusText}`);
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
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
      stream: true
    });

    const resp = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(this.config.apiKey),
      body: JSON.stringify(body),
      signal: opts.signal
    });

    if (!resp.ok) {
      throw new LlmError(`LLM stream request failed: ${resp.status} ${resp.statusText}`);
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
  opts: { temperature?: number; maxTokens?: number; stream?: boolean }
) {
  return {
    model,
    messages,
    ...(opts.stream !== undefined && { stream: opts.stream }),
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    ...(opts.maxTokens !== undefined && { max_tokens: opts.maxTokens })
  };
}

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}
