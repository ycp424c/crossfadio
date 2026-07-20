import { describe, expect, it } from 'vitest';
import {
  projectDjMemoryToMusicAgentRuntime,
  projectDjMemoryForChat,
  projectDjMemoryForSegue,
  projectDjMemoryForSelection
} from '../../src/server/dj-memory/projections';
import { djMemorySnapshotSchema } from '../../src/server/dj-memory/schema';

const snapshot = djMemorySnapshotSchema.parse({
  metadata: {
    schemaVersion: 1,
    snapshotId: 'snapshot-1',
    userId: 'user-1',
    assembledAt: '2026-07-17T04:00:00.000Z',
    sources: []
  },
  queue: {
    currentTrack: { id: 'current', name: 'Current', artists: ['A'] },
    upcoming: [{ id: 'next', name: 'Next', artists: ['B'] }]
  },
  listeningEpisodes: [{
    id: 'ep-1', trackId: 'old', trackName: 'Old', primaryArtist: 'C',
    listenedMs: 20_000, durationMs: 100_000, outcome: 'skipped',
    startedAt: '2026-07-17T03:00:00.000Z'
  }],
  preferences: [{
    id: 'pref-1', kind: 'expressed', subjectType: 'style', subjectKey: 'city pop',
    polarity: 'positive', score: 0.9, observedAt: '2026-07-17T02:00:00.000Z'
  }],
  tasteProfile: { id: 'taste-1', version: 2, summary: '偏好 City Pop', generatedAt: '2026-07-16T00:00:00.000Z' },
  activeDirective: { text: '接下来轻快一点', expiresAt: '2026-07-17T05:00:00.000Z' },
  explicitExclusions: [{ id: 'x-1', entityType: 'artist', entityKey: 'blocked', displayName: 'Blocked' }],
  temporaryExclusions: [{ id: 'temp', name: 'Temp', artists: ['T'], expiresAt: '2026-07-18T04:00:00.000Z' }],
  personalContext: {
    id: 'pdc-1', expiresAt: '2026-07-18T03:00:00.000Z', summary: '最近在专注工作',
    currentState: {
      activity: 'coding', energy: 'medium', attention: 'low_distraction', mood: 'focused'
    },
    musicGuidance: { preferredTextures: ['清亮'], avoidTextures: [], novelty: 'balanced' },
    musicHints: [{
      kind: 'style', label: 'low-distraction city pop', strength: 'strong', reason: '适合当前专注状态'
    }],
    segueGuidance: { tone: '轻松', privacyRule: '不要提及工作细节' }
  },
  selectionContext: {
    discoveryMode: 'comfort',
    dailyTheme: { theme: '盛夏微风', keywords: ['city pop', '清亮'] }
  },
  retrievalHistory: [{ query: 'city pop', source: 'ncm_search', selectedCount: 1, attemptedAt: '2026-07-17T03:00:00.000Z' }],
  configuration: [{ id: 'cfg-1', kind: 'persona', key: 'main', value: { tone: 'warm' } }],
  sessionLog: [{ id: 'log-1', kind: 'selection_reason', text: '上一首为了承接夜晚氛围', occurredAt: '2026-07-17T03:30:00.000Z' }],
  currentMoment: { iso: '2026-07-17T04:00:00.000Z', localTime: '12:00', daypart: '中午' },
  weather: { location: 'Shanghai', tempC: 30, desc: '晴' }
});

describe('DJ Memory purpose projections', () => {
  it('uses explicit whitelists instead of exposing the whole snapshot', () => {
    const chat = projectDjMemoryForChat(snapshot);
    const selection = projectDjMemoryForSelection(snapshot);
    const segue = projectDjMemoryForSegue(snapshot);

    expect(chat.purpose).toBe('chat');
    expect(selection.purpose).toBe('selection');
    expect(segue.purpose).toBe('segue');
    expect(selection.facts.some((fact) => fact.key === 'listening_episode')).toBe(true);
    expect(chat.facts.some((fact) => fact.key === 'listening_episode')).toBe(false);
    expect(segue.facts.some((fact) => fact.key === 'retrieval_attempt')).toBe(false);
    expect(JSON.stringify(segue)).not.toContain('最近在专注工作');
    expect(JSON.stringify(segue)).toContain('不要提及工作细节');
  });

  it('honors item and string budgets while preserving schema-valid facts', () => {
    const selection = projectDjMemoryForSelection(snapshot, { maxFacts: 3, maxStringLength: 12 });
    expect(selection.facts).toHaveLength(3);
    for (const fact of selection.facts) {
      if (typeof fact.value === 'string') expect(fact.value.length).toBeLessThanOrEqual(12);
    }
  });

  it('reserves Active Directive, Personal DJ Context, and selection settings under a saturated budget', () => {
    const saturated = djMemorySnapshotSchema.parse({
      ...snapshot,
      queue: {
        currentTrack: snapshot.queue.currentTrack,
        upcoming: Array.from({ length: 50 }, (_, index) => ({
          id: `queued-${index}`,
          name: `Queued ${index}`,
          artists: [`Artist ${index}`]
        }))
      },
      explicitExclusions: Array.from({ length: 100 }, (_, index) => ({
        id: `excluded-${index}`,
        entityType: 'track' as const,
        entityKey: `excluded-${index}`,
        displayName: `Excluded ${index}`
      }))
    });

    const selection = projectDjMemoryForSelection(saturated);
    const keys = new Set(selection.facts.map((fact) => fact.key));

    expect(selection.facts).toHaveLength(96);
    expect(keys.has('active_directive')).toBe(true);
    expect(keys.has('personal_context_summary')).toBe(true);
    expect(keys.has('personal_music_hint')).toBe(true);
    expect(keys.has('discovery_mode')).toBe(true);
    expect(keys.has('daily_theme')).toBe(true);
  });

  it('adapts only the selection projection into MusicAgent runtime context', () => {
    const projection = projectDjMemoryForSelection(snapshot);
    const context = projectDjMemoryToMusicAgentRuntime(projection, {
      request: 'chat-recommend',
      userText: '来点更轻快的',
      actionQueries: ['city pop', 'bright']
    });

    expect(context).toMatchObject({
      request: 'chat-recommend',
      discoveryMode: 'comfort',
      currentUserText: '来点更轻快的',
      actionQueries: ['city pop', 'bright'],
      currentMoment: {
        localTime: '12:00',
        daypart: '中午',
        weather: '30°C 晴',
        dailyTheme: '盛夏微风（city pop、清亮）'
      },
      activeDirective: '接下来轻快一点'
    });
    expect(context.tasteSummary).toContain('偏好 City Pop');
    expect(context.recentPreferenceSummary).toContain('city pop');
    expect(context.recentPlaySignals).toContain('old');
    expect(context.queueStateSummary).toContain('current');
    expect(context.bannedSummary).toContain('blocked');
    expect(context.personalDjContext).toMatchObject({
      summary: '最近在专注工作',
      currentState: { activity: 'coding', attention: 'low_distraction', mood: 'focused' },
      musicGuidance: { preferredTextures: ['清亮'], novelty: 'balanced' },
      musicHints: [{
        kind: 'style', label: 'low-distraction city pop', strength: 'strong', reason: '适合当前专注状态'
      }]
    });
    expect(JSON.stringify(context)).not.toContain('retrieval_attempt');
  });
});
