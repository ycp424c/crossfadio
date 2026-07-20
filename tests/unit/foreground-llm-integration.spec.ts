import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('foreground LLM preemption integration', () => {
  it.each([
    'src/server/dj/pickNextRun.ts',
    'src/server/http/routes/segue.ts',
    'src/server/http/chat-sse-worker.ts'
  ])('%s declares foreground LLM work around its primary model call', (file) => {
    const source = fs.readFileSync(file, 'utf8');
    expect(source).toContain('beginForegroundLlmWork');
    expect(source).toMatch(/try\s*\{/);
    expect(source).toMatch(/finally\s*\{/);
  });
});
