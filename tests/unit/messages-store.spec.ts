import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalDataDir = process.env.CROSSFADIO_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-msg-'));
  process.env.CROSSFADIO_DATA_DIR = dataDir;
  const { initDb } = await import('../../src/server/store/db');
  initDb();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CROSSFADIO_DATA_DIR;
  else process.env.CROSSFADIO_DATA_DIR = originalDataDir;
});

describe('messages store', () => {
  it('saveMessage returns a positive id', async () => {
    const { saveMessage } = await import('../../src/server/store/messages');
    const id = saveMessage('user', 'hello');
    expect(id).toBeGreaterThan(0);
  });

  it('getRecentMessages returns messages in chronological order', async () => {
    const { saveMessage, getRecentMessages } = await import('../../src/server/store/messages');
    saveMessage('user', 'first');
    saveMessage('assistant', 'second');
    const msgs = getRecentMessages(20);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('first');
    expect(msgs[1].content).toBe('second');
  });

  it('getRecentMessages respects the limit', async () => {
    const { saveMessage, getRecentMessages } = await import('../../src/server/store/messages');
    for (let i = 0; i < 5; i++) saveMessage('user', `msg ${i}`);
    const msgs = getRecentMessages(3);
    expect(msgs).toHaveLength(3);
  });

  it('getRecentMessages with withinMinutes returns recent messages', async () => {
    const { saveMessage, getRecentMessages } = await import('../../src/server/store/messages');
    saveMessage('user', 'recent message');
    const msgs = getRecentMessages(20, 60);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs[msgs.length - 1].content).toBe('recent message');
  });

  it('getUnextractedMessages returns messages with extracted_at = null', async () => {
    const { saveMessage, getUnextractedMessages } = await import('../../src/server/store/messages');
    saveMessage('user', 'hello');
    saveMessage('assistant', 'hi');
    const unextracted = getUnextractedMessages();
    expect(unextracted.length).toBe(2);
    expect(unextracted.every((m) => m.extracted_at === null)).toBe(true);
  });

  it('markMessagesExtracted sets extracted_at on the given ids', async () => {
    const { saveMessage, getUnextractedMessages, markMessagesExtracted } = await import(
      '../../src/server/store/messages'
    );
    const id1 = saveMessage('user', 'first');
    saveMessage('assistant', 'second');
    markMessagesExtracted([id1]);
    const unextracted = getUnextractedMessages();
    expect(unextracted).toHaveLength(1);
    expect(unextracted[0].content).toBe('second');
  });
});
