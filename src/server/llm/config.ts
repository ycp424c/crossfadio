import { getConfig } from '../config.js';
import type { LlmConfig } from './client.js';

export function resolveLlmConfig(): LlmConfig {
  const config = getConfig();
  return {
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    apiKey: config.llm.apiKey
  };
}
