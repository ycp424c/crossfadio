import { z } from 'zod';

export const embeddingConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
  // 部分模型（如腾讯云 TokenHub kinfra-text-embedding-*）不接受 dimensions 参数，
  // 由 CROSSFADIO_EMBEDDING_SEND_DIMENSIONS=0 关闭发送；实际维度以响应向量长度为准。
  sendDimensions: z.boolean().default(true)
});

export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>;

export type EmbeddingUsage = {
  prompt_tokens?: number;
  total_tokens?: number;
};

export type EmbeddingResponse = {
  vectors: Float32Array[];
  model: string;
  dimensions: number;
  usage?: EmbeddingUsage;
};

export type EmbeddingHealth = {
  ok: boolean;
  model: string;
  dimensions?: number;
  error?: string;
};

const ERROR_BODY_MAX_CHARS = 2_000;

export class EmbeddingClient {
  private readonly config: EmbeddingConfig;

  constructor(config: EmbeddingConfig) {
    this.config = embeddingConfigSchema.parse(config);
  }

  async embed(input: string | string[], opts: { signal?: AbortSignal } = {}): Promise<EmbeddingResponse> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      input
    };
    if (this.config.sendDimensions) {
      body.dimensions = this.config.dimensions;
    }

    const resp = await fetch(`${this.config.baseUrl}/embeddings`, {
      method: 'POST',
      headers: buildHeaders(this.config.apiKey),
      body: JSON.stringify(body),
      signal: opts.signal
    });

    if (!resp.ok) {
      await throwEmbeddingHttpError(resp);
    }

    const data = (await resp.json()) as {
      data?: Array<{ embedding?: number[] }>;
      model?: string;
      usage?: EmbeddingUsage;
    };
    const vectors = (data.data ?? [])
      .map((item) => item.embedding)
      .filter((embedding): embedding is number[] => Array.isArray(embedding))
      .map((embedding) => Float32Array.from(embedding));

    if (vectors.length === 0) {
      throw new EmbeddingError('Embedding request failed: response has no vectors');
    }

    return {
      vectors,
      model: data.model ?? this.config.model,
      dimensions: vectors[0]?.length ?? 0,
      usage: data.usage
    };
  }

  async health(opts: { signal?: AbortSignal } = {}): Promise<EmbeddingHealth> {
    try {
      const response = await this.embed('crossfadio embedding health check', opts);
      return {
        ok: true,
        model: response.model,
        dimensions: response.dimensions
      };
    } catch (error) {
      return {
        ok: false,
        model: this.config.model,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
}

export class EmbeddingError extends Error {
  readonly status?: number;
  readonly statusText?: string;
  readonly responseBody?: string;

  constructor(message: string, options: { status?: number; statusText?: string; responseBody?: string } = {}) {
    super(message);
    this.name = 'EmbeddingError';
    this.status = options.status;
    this.statusText = options.statusText;
    this.responseBody = options.responseBody;
  }
}

async function throwEmbeddingHttpError(response: Response): Promise<never> {
  const responseBody = await readErrorBody(response);
  const status = response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
  throw new EmbeddingError(
    responseBody
      ? `Embedding request failed: ${status}; response body: ${responseBody}`
      : `Embedding request failed: ${status}`,
    {
      status: response.status,
      statusText: response.statusText,
      responseBody
    }
  );
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (trimmed.length <= ERROR_BODY_MAX_CHARS) return trimmed;
    return `${trimmed.slice(0, ERROR_BODY_MAX_CHARS)}...`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `failed to read response body: ${message}`;
  }
}
