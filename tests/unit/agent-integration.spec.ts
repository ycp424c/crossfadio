/**
 * Integration tests for the agent chain using FakeLlmClient / FakeTtsClient.
 * Tests the full path: Fragments → assembleMessages → LlmClient → parse → AgentOutput.
 */
import { describe, expect, it } from 'vitest';
import { computeSync, computeStream } from '../../src/server/agent/compute';
import { FakeLlmClient } from '../support/fake-llm';
import { FakeTtsClient } from '../support/fake-tts';
import type { Fragments } from '../../src/server/agent/schema';

const baseFragments: Fragments = {
  mode: 'plan',
  system: 'You are a DJ.',
  corpus: {
    taste: 'Indie Pop',
    routines: '09:00 通勤',
    moodRules: '深夜要安静',
    playlists: [{ id: 'p1', name: '晨间', provider: 'ncm', segments: ['morning'], tags: ['indie'], priority: 1 }]
  },
  env: {
    nowIso: '2026-04-24T09:00:00Z',
    localTime: '周四 09:00',
    weather: { tempC: 18, desc: '晴' },
    nowPlaying: null
  },
  memory: { recentPlays: [], recentChat: [] },
  input: { kind: 'planRequest', date: '2026-04-24' },
  trace: { triggeredBy: 'scheduler', lastDecision: null }
};

const validPlan = JSON.stringify({
  mode: 'plan',
  date: '2026-04-24',
  segments: [{
    id: 'morning',
    label: '早晨',
    timeRange: '07:00-09:00',
    mood: '清醒',
    energyPct: 40,
    tracks: [{ query: 'Here Comes The Sun — Beatles', reason: '清新开场' }]
  }],
  narrative: '今日电台从清晨开始'
});

const validChat = JSON.stringify({
  mode: 'chat',
  intent: 'chitchat',
  say: '好的，今天听点清新的',
  actions: []
});

const validSegue = JSON.stringify({
  mode: 'segue',
  say: '下一首来自 Bon Iver，像雪落下',
  duckingHintSec: 8,
  filterSweep: true,
  emotionTag: 'calm'
});

describe('chat mode — minimum chain (computeSync + FakeLlmClient)', () => {
  it('returns ChatOutput for a chitchat message', async () => {
    const fake = new FakeLlmClient().queueResponse(validChat);
    const fragments: Fragments = {
      ...baseFragments,
      mode: 'chat',
      input: { kind: 'chat', text: '今天来点清新的' },
      trace: { triggeredBy: 'user', lastDecision: null }
    };

    const result = await computeSync(fragments, { llmClient: fake });

    expect(result.mode).toBe('chat');
    if (result.mode === 'chat') {
      expect(result.intent).toBe('chitchat');
      expect(result.say).toBeTruthy();
      expect(result.actions).toEqual([]);
    }
  });

  it('records the assembled messages passed to the client', async () => {
    const fake = new FakeLlmClient().queueResponse(validChat);
    const fragments: Fragments = {
      ...baseFragments,
      mode: 'chat',
      input: { kind: 'chat', text: '换首 Rap' },
      trace: { triggeredBy: 'user', lastDecision: null }
    };

    await computeSync(fragments, { llmClient: fake });

    expect(fake.completeCalls).toHaveLength(1);
    const [call] = fake.completeCalls;
    // system message first
    expect(call.messages[0].role).toBe('system');
    // last message contains the user input
    const lastMsg = call.messages[call.messages.length - 1];
    expect(lastMsg.content).toContain('换首 Rap');
  });

  it('retries once on invalid output and succeeds on second call', async () => {
    const fake = new FakeLlmClient()
      .queueResponse('not-json')
      .queueResponse(validChat);
    const fragments: Fragments = {
      ...baseFragments,
      mode: 'chat',
      input: { kind: 'chat', text: 'hi' },
      trace: { triggeredBy: 'user', lastDecision: null }
    };

    const result = await computeSync(fragments, { llmClient: fake });

    expect(fake.completeCalls).toHaveLength(2);
    expect(result.mode).toBe('chat');
    // retry message should include schema error hint
    const retryMsg = fake.completeCalls[1].messages.at(-1)!;
    expect(retryMsg.content).toContain('JSON schema');
  });

  it('returns adjust_queue ChatOutput with actions', async () => {
    const withActions = JSON.stringify({
      mode: 'chat',
      intent: 'adjust_queue',
      say: '好的，换成 Kendrick',
      actions: [{ type: 'swap_next', pick: { query: 'Kendrick Lamar' } }]
    });
    const fake = new FakeLlmClient().queueResponse(withActions);
    const fragments: Fragments = {
      ...baseFragments,
      mode: 'chat',
      input: { kind: 'chat', text: '换首 Rap' },
      trace: { triggeredBy: 'user', lastDecision: null }
    };

    const result = await computeSync(fragments, { llmClient: fake });

    expect(result.mode).toBe('chat');
    if (result.mode === 'chat') {
      expect(result.intent).toBe('adjust_queue');
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].type).toBe('swap_next');
    }
  });
});

describe('plan mode — minimum chain (computeSync + FakeLlmClient)', () => {
  it('returns PlanOutput for a plan request', async () => {
    const fake = new FakeLlmClient().queueResponse(validPlan);

    const result = await computeSync(baseFragments, { llmClient: fake });

    expect(result.mode).toBe('plan');
    if (result.mode === 'plan') {
      expect(result.date).toBe('2026-04-24');
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].tracks).toHaveLength(1);
    }
  });

  it('corpus content reaches the LLM messages', async () => {
    const fake = new FakeLlmClient().queueResponse(validPlan);
    await computeSync(baseFragments, { llmClient: fake });

    const corpusMsg = fake.completeCalls[0].messages[1];
    expect(corpusMsg.content).toContain('Indie Pop');
    expect(corpusMsg.content).toContain('晨间');
    expect(corpusMsg.content).toContain('18°C');
  });
});

describe('segue mode — streaming chain (computeStream + FakeLlmClient)', () => {
  it('yields delta events then done event with SegueOutput', async () => {
    const deltas = validSegue.split('').slice(0, 5).concat([validSegue.slice(5)]);
    const fake = new FakeLlmClient().queueStreamDeltas(deltas);
    const fragments: Fragments = {
      ...baseFragments,
      mode: 'segue',
      input: { kind: 'segueTrigger', from: { id: '1', name: '歌A' }, to: { id: '2', name: '歌B' } },
      trace: { triggeredBy: 'segue-hook', lastDecision: null }
    };

    const events: import('../../src/server/agent/schema').AgentEvent[] = [];
    for await (const evt of computeStream(fragments, { llmClient: fake })) {
      events.push(evt);
    }

    const deltaEvents = events.filter(e => e.type === 'delta');
    const doneEvents = events.filter(e => e.type === 'done');
    expect(deltaEvents.length).toBeGreaterThan(0);
    expect(doneEvents).toHaveLength(1);
    if (doneEvents[0].type === 'done') {
      expect(doneEvents[0].output.mode).toBe('segue');
    }
  });

  it('falls back to complete() retry on stream parse failure', async () => {
    const fake = new FakeLlmClient()
      .queueStreamDeltas(['invalid-json-from-stream'])
      .queueResponse(validSegue);
    const fragments: Fragments = {
      ...baseFragments,
      mode: 'segue',
      input: { kind: 'segueTrigger', from: { id: '1' }, to: { id: '2' } },
      trace: { triggeredBy: 'segue-hook', lastDecision: null }
    };

    const events: import('../../src/server/agent/schema').AgentEvent[] = [];
    for await (const evt of computeStream(fragments, { llmClient: fake })) {
      events.push(evt);
    }

    expect(fake.streamCalls).toHaveLength(1);
    expect(fake.completeCalls).toHaveLength(1);
    const done = events.find(e => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') expect(done.output.mode).toBe('segue');
  });
});

describe('FakeTtsClient', () => {
  it('records synthesize calls and returns configured filePath', async () => {
    const fake = new FakeTtsClient('/tmp/test.mp3');
    const result = await fake.synthesize('Hello DJ');
    expect(result.filePath).toBe('/tmp/test.mp3');
    expect(result.cached).toBe(false);
    expect(fake.synthesizeCalls).toHaveLength(1);
    expect(fake.synthesizeCalls[0].text).toBe('Hello DJ');
  });

  it('throws when failNextCall is set', async () => {
    const fake = new FakeTtsClient().failNextCall('TTS unavailable');
    await expect(fake.synthesize('text')).rejects.toThrow('TTS unavailable');
    // subsequent call succeeds
    await expect(fake.synthesize('text')).resolves.toBeDefined();
  });
});
