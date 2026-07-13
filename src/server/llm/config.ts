import { getConfig } from '../config.js';
import { getPref } from '../store/prefs.js';
import type { LlmConfig } from './client.js';

export function resolveLlmConfig(userId?: string): LlmConfig {
  const config = getConfig();
  return {
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    thinking: {
      type: userId && getPref<boolean>(userId, 'llm.thinkingEnabled') === true
        ? 'enabled'
        : 'disabled'
    }
  };
}
