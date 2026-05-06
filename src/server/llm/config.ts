import { getPref } from '../store/prefs.js';
import type { SecretStore } from '../security.js';
import type { LlmConfig } from './client.js';

export function resolveLlmConfig(secrets: SecretStore): LlmConfig | null {
  const stored = getPref<{ baseUrl: string; model: string }>('__legacy__', 'llm.config');
  if (!stored) return null;
  const apiKey = secrets.get('llm.apiKey');
  if (!apiKey) return null;
  return { baseUrl: stored.baseUrl, model: stored.model, apiKey };
}
