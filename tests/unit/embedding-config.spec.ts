import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const originalEnv = {
  jwt: process.env.CROSSFADIO_JWT_SECRET,
  llmBaseUrl: process.env.CROSSFADIO_LLM_BASE_URL,
  llmApiKey: process.env.CROSSFADIO_LLM_API_KEY,
  llmModel: process.env.CROSSFADIO_LLM_MODEL,
  ttsBaseUrl: process.env.CROSSFADIO_TTS_BASE_URL,
  ttsApiKey: process.env.CROSSFADIO_TTS_API_KEY,
  embeddingBaseUrl: process.env.CROSSFADIO_EMBEDDING_BASE_URL,
  embeddingApiKey: process.env.CROSSFADIO_EMBEDDING_API_KEY,
  embeddingModel: process.env.CROSSFADIO_EMBEDDING_MODEL,
  embeddingDimensions: process.env.CROSSFADIO_EMBEDDING_DIMENSIONS
};

beforeEach(async () => {
  const { resetConfigForTest } = await import('../../src/server/config.js');
  resetConfigForTest();
  process.env.CROSSFADIO_JWT_SECRET = 'jwt-test';
  process.env.CROSSFADIO_LLM_BASE_URL = 'https://llm.example/v1';
  process.env.CROSSFADIO_LLM_API_KEY = 'llm-key';
  process.env.CROSSFADIO_LLM_MODEL = 'llm-model';
  process.env.CROSSFADIO_TTS_BASE_URL = 'https://tts.example/v1';
  process.env.CROSSFADIO_TTS_API_KEY = 'tts-key';
  delete process.env.CROSSFADIO_EMBEDDING_BASE_URL;
  delete process.env.CROSSFADIO_EMBEDDING_API_KEY;
  delete process.env.CROSSFADIO_EMBEDDING_MODEL;
  delete process.env.CROSSFADIO_EMBEDDING_DIMENSIONS;
});

afterEach(async () => {
  restoreEnv('CROSSFADIO_JWT_SECRET', originalEnv.jwt);
  restoreEnv('CROSSFADIO_LLM_BASE_URL', originalEnv.llmBaseUrl);
  restoreEnv('CROSSFADIO_LLM_API_KEY', originalEnv.llmApiKey);
  restoreEnv('CROSSFADIO_LLM_MODEL', originalEnv.llmModel);
  restoreEnv('CROSSFADIO_TTS_BASE_URL', originalEnv.ttsBaseUrl);
  restoreEnv('CROSSFADIO_TTS_API_KEY', originalEnv.ttsApiKey);
  restoreEnv('CROSSFADIO_EMBEDDING_BASE_URL', originalEnv.embeddingBaseUrl);
  restoreEnv('CROSSFADIO_EMBEDDING_API_KEY', originalEnv.embeddingApiKey);
  restoreEnv('CROSSFADIO_EMBEDDING_MODEL', originalEnv.embeddingModel);
  restoreEnv('CROSSFADIO_EMBEDDING_DIMENSIONS', originalEnv.embeddingDimensions);
  const { resetConfigForTest } = await import('../../src/server/config.js');
  resetConfigForTest();
});

describe('embedding config', () => {
  it('keeps embedding disabled when the explicit embedding key is absent', async () => {
    const { loadConfig } = await import('../../src/server/config.js');

    expect(loadConfig().embedding).toBeNull();
  });

  it('uses independent embedding env vars with DashScope-compatible defaults', async () => {
    process.env.CROSSFADIO_EMBEDDING_API_KEY = 'bailian-key';

    const { loadConfig } = await import('../../src/server/config.js');

    expect(loadConfig().embedding).toEqual({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKey: 'bailian-key',
      model: 'text-embedding-v4',
      dimensions: 1024
    });
  });

  it('allows embedding base URL, model, and dimensions to be overridden', async () => {
    process.env.CROSSFADIO_EMBEDDING_API_KEY = 'embedding-key';
    process.env.CROSSFADIO_EMBEDDING_BASE_URL = 'https://embedding.example/v1';
    process.env.CROSSFADIO_EMBEDDING_MODEL = 'custom-embedding';
    process.env.CROSSFADIO_EMBEDDING_DIMENSIONS = '768';

    const { loadConfig } = await import('../../src/server/config.js');

    expect(loadConfig().embedding).toEqual({
      baseUrl: 'https://embedding.example/v1',
      apiKey: 'embedding-key',
      model: 'custom-embedding',
      dimensions: 768
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
