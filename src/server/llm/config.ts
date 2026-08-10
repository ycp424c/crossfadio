import { getConfig } from '../config.js';
import { getPref } from '../store/prefs.js';
import { resolveUserTier } from '../resource-policy.js';
import type { LlmConfig } from './client.js';

export function resolveLlmConfig(userId?: string): LlmConfig {
  const config = getConfig();
  // Standard users cannot enable LLM thinking even with a stored true
  // preference — thinking is a priority-tier capability.
  const thinkingOptIn = userId !== undefined
    && resolveUserTier(userId) === 'priority'
    && getPref<boolean>(userId, 'llm.thinkingEnabled') === true;
  return {
    baseUrl: config.llm.baseUrl,
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    thinking: {
      type: thinkingOptIn ? 'enabled' : 'disabled'
    }
  };
}
