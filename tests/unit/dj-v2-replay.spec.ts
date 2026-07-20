import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  exportDjV2Replay,
  exportDjV2ReplayFile,
  type DjV2ReplayPolicyCaseInput,
  type DjV2ReplaySelectionRunInput,
} from '../../scripts/export-dj-v2-replay.js';
import {
  assertReplayReleaseGates,
  replayDjV2,
  replayListeningFeedback
} from '../../scripts/replay-dj-v2.js';

describe('DJ v2 replay export', () => {
  it('一致哈希标识并整体平移时间，不泄露 salt', () => {
    const exported = exportDjV2Replay(
      {
        episodes: [
          {
            episodeId: 'episode-1',
            userId: 'user-1',
            trackId: 'track-1',
            primaryArtistId: 'artist-1',
            startedAt: 1_700_000_000_000,
            endedAt: 1_700_000_060_000,
            durationMs: 180_000,
            positionMs: 60_000,
            listenedMs: 58_000,
            outcome: 'skipped',
            protocolVersion: 2,
          },
        ],
        selectionRuns: [
          {
            runId: 'run-1',
            userId: 'user-1',
            startedAt: 1_700_000_000_000,
            completedAt: 1_700_000_002_000,
            selectedTrackIds: ['track-1'],
            candidateCount: 1,
            eligibleCount: 1,
            appendedCount: 1,
            latencyMs: 2_000,
            hardViolationCount: 0,
            promptJsonStatus: 'valid',
            journeyPublished: true,
            narrationStatus: 'succeeded',
            outcome: 'succeeded',
            reasonCodes: ['taste_match'],
          },
        ],
        retrievalAttempts: [],
        policyCases: [replayPolicyCase()],
      },
      {
        salt: 'one-time-test-salt-with-enough-entropy',
        timeShiftMs: 86_400_000,
        nowMs: 1_700_000_100_000,
      },
    );

    expect(exported.schemaVersion).toBe(2);
    expect(exported.episodes[0]?.userId).toBe(exported.selectionRuns[0]?.userId);
    expect(exported.episodes[0]?.trackId).toBe(exported.selectionRuns[0]?.selectedTrackIds[0]);
    expect(exported.episodes[0]?.userId).toMatch(/^h_[a-f0-9]{32}$/);
    expect(exported.episodes[0]?.startedAt).toBe(1_700_086_400_000);
    expect(JSON.stringify(exported)).not.toContain('one-time-test-salt');
    expect(JSON.stringify(exported)).not.toContain('user-1');
    expect(JSON.stringify(exported)).not.toContain('track-1');
  });

  it('拒绝白名单外的任意字段', () => {
    expect(() =>
      exportDjV2Replay(
        {
          episodes: [
            {
              episodeId: 'episode-1',
              userId: 'user-1',
              trackId: 'track-1',
              startedAt: 1_700_000_000_000,
              positionMs: 0,
              listenedMs: 0,
              outcome: 'interrupted',
              protocolVersion: 2,
              displayName: 'harmless-looking extra field',
            },
          ],
          selectionRuns: [],
          retrievalAttempts: [],
        } as never,
        {
          salt: 'one-time-test-salt-with-enough-entropy',
          timeShiftMs: 0,
          nowMs: 1_700_000_100_000,
        },
      ),
    ).toThrow(/episodes\[0\]\.displayName.*not allowed/i);
  });

  it('在哈希前拒绝允许字段中的禁止字符串内容', () => {
    expect(() =>
      exportDjV2Replay(
        {
          episodes: [
            {
              episodeId: 'episode-1',
              userId: 'user-1',
              trackId: 'https://music.example.test/raw-track',
              startedAt: 1_700_000_000_000,
              positionMs: 0,
              listenedMs: 0,
              outcome: 'interrupted',
              protocolVersion: 2,
            },
          ],
          selectionRuns: [],
          retrievalAttempts: [],
        },
        {
          salt: 'one-time-test-salt-with-enough-entropy',
          timeShiftMs: 0,
          nowMs: 1_700_000_100_000,
        },
      ),
    ).toThrow(/episodes\[0\]\.trackId.*forbidden content/i);
  });

  it('立即拒绝表示原始日志正文的 key', () => {
    expect(() =>
      exportDjV2Replay(
        {
          episodes: [],
          selectionRuns: [],
          retrievalAttempts: [],
          logBody: 'not allowed to reach the whitelist stage',
        } as never,
        {
          salt: 'one-time-test-salt-with-enough-entropy',
          timeShiftMs: 86_400_000,
          nowMs: 1_700_000_100_000,
        },
      ),
    ).toThrow(/root\.logBody.*forbidden/i);
  });

  it('拒绝超过 1,000 条 Listening Episodes 的样本', () => {
    const episodes = Array.from({ length: 1_001 }, (_, index) => ({
      episodeId: `episode-${index}`,
      userId: 'user-1',
      trackId: `track-${index}`,
      startedAt: 1_700_000_000_000,
      positionMs: 0,
      listenedMs: 0,
      outcome: 'interrupted' as const,
      protocolVersion: 2,
    }));

    expect(() =>
      exportDjV2Replay(
        { episodes, selectionRuns: [], retrievalAttempts: [] },
        {
          salt: 'one-time-test-salt-with-enough-entropy',
          timeShiftMs: 0,
          nowMs: 1_700_000_100_000,
        },
      ),
    ).toThrow(/episodes.*maximum.*1000/i);
  });

  it('拒绝超过 500 条 Selection Runs 的样本', () => {
    const selectionRuns = Array.from({ length: 501 }, (_, index) => ({
      runId: `run-${index}`,
      userId: 'user-1',
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_010,
      selectedTrackIds: [],
      candidateCount: 0,
      eligibleCount: 0,
      appendedCount: 0,
      latencyMs: 10,
      hardViolationCount: 0,
      promptJsonStatus: 'valid',
      journeyPublished: true,
      narrationStatus: 'not_applicable',
      outcome: 'empty' as const,
      reasonCodes: ['no_candidate'],
    }));

    expect(() =>
      exportDjV2Replay(
        { episodes: [], selectionRuns, retrievalAttempts: [] },
        {
          salt: 'one-time-test-salt-with-enough-entropy',
          timeShiftMs: 0,
          nowMs: 1_700_000_100_000,
        },
      ),
    ).toThrow(/selectionRuns.*maximum.*500/i);
  });

  it('将 Retrieval Attempt 的检索词转换成一致 fingerprint', () => {
    const exported = exportDjV2Replay(
      {
        episodes: [],
        selectionRuns: [],
        retrievalAttempts: [
          {
            attemptId: 'attempt-1',
            runId: 'run-1',
            userId: 'user-1',
            source: 'ncm_search',
            requestKind: 'autonomous',
            normalizedQuery: 'late night jazz',
            attemptedAt: 1_700_000_000_000,
            searchedCount: 20,
            resultCount: 8,
            addedCount: 2,
            selectedCount: 1,
          },
        ],
      },
      {
        salt: 'one-time-test-salt-with-enough-entropy',
        timeShiftMs: 1_000,
        nowMs: 1_700_000_100_000,
      },
    );

    expect(exported.retrievalAttempts[0]).toMatchObject({
      attemptId: expect.stringMatching(/^h_[a-f0-9]{32}$/),
      runId: expect.stringMatching(/^h_[a-f0-9]{32}$/),
      userId: expect.stringMatching(/^h_[a-f0-9]{32}$/),
      queryFingerprint: expect.stringMatching(/^h_[a-f0-9]{32}$/),
      attemptedAt: 1_700_000_001_000,
    });
    expect(exported.retrievalAttempts[0]).not.toHaveProperty('normalizedQuery');
    expect(JSON.stringify(exported)).not.toContain('late night jazz');
  });

  it('拒绝超过 1,000 条 Retrieval Attempts 的样本', () => {
    const retrievalAttempts = Array.from({ length: 1_001 }, (_, index) => ({
      attemptId: `attempt-${index}`,
      userId: 'user-1',
      source: 'ncm_search',
      requestKind: 'autonomous' as const,
      normalizedQuery: `query ${index}`,
      attemptedAt: 1_700_000_000_000,
      searchedCount: 10,
      resultCount: 5,
      addedCount: 1,
      selectedCount: 0,
    }));

    expect(() =>
      exportDjV2Replay(
        { episodes: [], selectionRuns: [], retrievalAttempts },
        {
          salt: 'one-time-test-salt-with-enough-entropy',
          timeShiftMs: 0,
          nowMs: 1_700_000_100_000,
        },
      ),
    ).toThrow(/retrievalAttempts.*maximum.*1000/i);
  });

  it('拒绝最近 30 天窗口外的记录', () => {
    const nowMs = 1_700_000_000_000;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;

    expect(() =>
      exportDjV2Replay(
        {
          episodes: [
            {
              episodeId: 'episode-old',
              userId: 'user-1',
              trackId: 'track-1',
              startedAt: nowMs - thirtyDaysMs - 1,
              positionMs: 0,
              listenedMs: 0,
              outcome: 'interrupted',
              protocolVersion: 2,
            },
          ],
          selectionRuns: [],
          retrievalAttempts: [],
        },
        {
          salt: 'one-time-test-salt-with-enough-entropy',
          timeShiftMs: 0,
          nowMs,
        },
      ),
    ).toThrow(/episodes\[0\]\.startedAt.*30-day window/i);
  });

  it('拒绝低熵 salt', () => {
    expect(() =>
      exportDjV2Replay(
        { episodes: [], selectionRuns: [], retrievalAttempts: [] },
        { salt: 'too-short', timeShiftMs: 0, nowMs: 1_700_000_000_000 },
      ),
    ).toThrow(/salt.*at least 32/i);
  });

  it('exporter 拒绝缺少 completedAt 的 Selection Run', () => {
    const { completedAt: _completedAt, ...selectionRun } = replaySelectionRun();

    expect(() => exportDjV2Replay({
      episodes: [], selectionRuns: [selectionRun], retrievalAttempts: []
    } as never, replayExportOptions())).toThrow(
      /selectionRuns\[0\]\.completedAt.*non-negative integer/i
    );
  });

  it('exporter 拒绝 completedAt 早于 startedAt 的 Selection Run', () => {
    expect(() => exportDjV2Replay({
      episodes: [],
      selectionRuns: [replaySelectionRun({ completedAt: 1_699_999_999_999 })],
      retrievalAttempts: []
    }, replayExportOptions())).toThrow(
      /selectionRuns\[0\]\.completedAt.*greater than or equal to startedAt/i
    );
  });

  it('拒绝会原样输出的自然语言 reason code', () => {
    expect(() =>
      exportDjV2Replay(
        {
          episodes: [],
          selectionRuns: [
            {
              runId: 'run-1',
              userId: 'user-1',
              startedAt: 1_700_000_000_000,
              completedAt: 1_700_000_000_010,
              selectedTrackIds: [],
              candidateCount: 0,
              eligibleCount: 0,
              appendedCount: 0,
              latencyMs: 10,
              hardViolationCount: 0,
              promptJsonStatus: 'valid',
              journeyPublished: true,
              narrationStatus: 'not_applicable',
              outcome: 'empty',
              reasonCodes: ['user asked for a sad song'],
            },
          ],
          retrievalAttempts: [],
        },
        {
          salt: 'one-time-test-salt-with-enough-entropy',
          timeShiftMs: 0,
          nowMs: 1_700_000_100_000,
        },
      ),
    ).toThrow(/selectionRuns\[0\]\.reasonCodes\[0\].*machine code/i);
  });

  it('严格拒绝 Policy Case qualitySignals 中的非法枚举和越界数值', () => {
    const policyCase = {
      caseId: 'case-1',
      runId: 'run-1',
      userId: 'user-1',
      candidateId: 'candidate-1',
      candidateTrackKey: 'track-key-1',
      candidateArtistKey: 'artist-key-1',
      mode: 'autonomous' as const,
      identityValid: true,
      source: 'search',
      qualitySignals: { titlePollution: 'private listener note' },
      titleMotifKeys: [],
      baseScore: 0.5,
      batchIndex: 0,
      batchLimit: 1,
      context: {
        explicitlyRequested: false,
        explicitTrackExcluded: false,
        explicitArtistExcluded: false,
        temporaryTrackExcluded: false,
        temporaryArtistExcluded: false,
        retrievalCooldown: false,
        queueContainsTrack: false,
        playedTrack: false,
      },
      pressure: [],
      expected: {
        admission: { action: 'admit', reasonCodes: ['admission_eligible'] },
        recall: { action: 'include', reasonCodes: ['recall_included'] },
        ranking: {
          action: 'rank', reasonCodes: ['ranking_scored'], adjustedScore: 0.5, contributions: [],
        },
        batch: [{ action: 'select', reasonCodes: ['batch_selected'] }],
        final: { action: 'select', reasonCodes: ['final_eligible'] },
        finalContext: {
          explicitlyRequested: false,
          explicitTrackExcluded: false,
          explicitArtistExcluded: false,
          temporaryTrackExcluded: false,
          temporaryArtistExcluded: false,
          retrievalCooldown: false,
          queueContainsTrack: false,
          playedTrack: false
        }
      },
    };
    const options = {
      salt: 'one-time-test-salt-with-enough-entropy',
      timeShiftMs: 1_000,
      nowMs: 1_700_000_100_000,
    };

    expect(() => exportDjV2Replay({
      episodes: [], selectionRuns: [], retrievalAttempts: [], policyCases: [policyCase],
    }, options)).toThrow(/policyCases\[0\]\.qualitySignals\.titlePollution.*known enum/i);
    expect(() => exportDjV2Replay({
      episodes: [], selectionRuns: [], retrievalAttempts: [],
      policyCases: [{ ...policyCase, qualitySignals: { popularity: 101 } }],
    }, options)).toThrow(/policyCases\[0\]\.qualitySignals\.popularity.*between 0 and 100/i);
  });

  it('exporter 拒绝 policy case 数不等于 candidateCount 的 run', () => {
    const selectionRun = {
      runId: 'run-1', userId: 'user-1', startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_010,
      selectedTrackIds: [], candidateCount: 2, eligibleCount: 1, appendedCount: 0,
      latencyMs: 10, hardViolationCount: 0, promptJsonStatus: 'valid' as const,
      journeyPublished: true, narrationStatus: 'not_applicable' as const,
      outcome: 'empty' as const, reasonCodes: ['no_eligible_candidate']
    };

    expect(() => exportDjV2Replay({
      episodes: [], selectionRuns: [selectionRun], retrievalAttempts: [],
      policyCases: [replayPolicyCase()]
    }, replayExportOptions())).toThrow(
      /selectionRuns\[0\].*policy case coverage.*expected 2, got 1/i
    );
  });

  it('按 run 重放多候选 Batch，而不是把每条候选当成单候选 Batch', () => {
    const first = replayPolicyCase({
      caseId: 'case-1', candidateId: 'candidate-1', candidateTrackKey: 'track-key-1',
      candidateArtistKey: 'shared-artist', baseScore: 0.9, batchIndex: 0,
      expected: replayPolicyExpectation({ baseScore: 0.9 })
    });
    const second = replayPolicyCase({
      caseId: 'case-2', candidateId: 'candidate-2', candidateTrackKey: 'track-key-2',
      candidateArtistKey: 'shared-artist', baseScore: 0.8, batchIndex: 1,
      expected: replayPolicyExpectation({
        baseScore: 0.8,
        batch: [{ action: 'defer', reasonCodes: ['batch_primary_artist_repeat'] }],
        final: null
      })
    });
    const exported = exportDjV2Replay({
      episodes: [], selectionRuns: [], retrievalAttempts: [], policyCases: [first, second]
    }, replayExportOptions());

    expect(replayDjV2(exported).policyReplay).toEqual({
      decisionMismatchCount: 0,
      hardViolationCount: 0,
      runsWithIncompletePolicyCases: 0,
      phaseMismatchCounts: { admission: 0, recall: 0, ranking: 0, batch: 0, final: 0 },
      phaseExecutions: { admission: 2, recall: 2, ranking: 2, batch: 2, final: 1 }
    });
  });

  it('独立重放真实 Final，即使线上选择不是离线 Batch 的首选', () => {
    const offlineBatchWinner = replayPolicyCase({
      caseId: 'case-offline-a', candidateId: 'candidate-a', candidateTrackKey: 'track-key-a',
      candidateArtistKey: 'shared-artist', baseScore: 0.9, batchIndex: 0,
      expected: replayPolicyExpectation({
        baseScore: 0.9,
        final: null,
        finalContext: null
      })
    });
    const liveLlmPick = replayPolicyCase({
      caseId: 'case-live-b', candidateId: 'candidate-b', candidateTrackKey: 'track-key-b',
      candidateArtistKey: 'shared-artist', baseScore: 0.8, batchIndex: 1,
      expected: replayPolicyExpectation({
        baseScore: 0.8,
        batch: [{ action: 'defer', reasonCodes: ['batch_primary_artist_repeat'] }],
        final: { action: 'select', reasonCodes: ['final_eligible'] },
        finalContext: replayPolicyContext()
      })
    });
    const exported = exportDjV2Replay({
      episodes: [], selectionRuns: [], retrievalAttempts: [],
      policyCases: [offlineBatchWinner, liveLlmPick]
    }, replayExportOptions());

    expect(replayDjV2(exported).policyReplay).toMatchObject({
      decisionMismatchCount: 0,
      phaseMismatchCounts: { admission: 0, recall: 0, ranking: 0, batch: 0, final: 0 },
      phaseExecutions: { admission: 2, recall: 2, ranking: 2, batch: 2, final: 1 }
    });
  });

  it('不同用户复用同一 runId 时仍按用户隔离 policy replay', () => {
    const selectionRun = (userId: string) => ({
      runId: 'shared-run', userId, startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_010,
      selectedTrackIds: [], candidateCount: 1, eligibleCount: 1, appendedCount: 0,
      latencyMs: 10, hardViolationCount: 0, promptJsonStatus: 'valid' as const,
      journeyPublished: true, narrationStatus: 'not_applicable' as const,
      outcome: 'empty' as const, reasonCodes: ['no_queue_append']
    });
    const exported = exportDjV2Replay({
      episodes: [],
      selectionRuns: [selectionRun('user-1'), selectionRun('user-2')],
      retrievalAttempts: [],
      policyCases: [
        replayPolicyCase({ runId: 'shared-run', userId: 'user-1' }),
        replayPolicyCase({
          caseId: 'case-2', runId: 'shared-run', userId: 'user-2',
          candidateId: 'candidate-2', candidateTrackKey: 'track-key-2',
          candidateArtistKey: 'artist-key-2'
        })
      ]
    }, replayExportOptions());

    expect(replayDjV2(exported).policyReplay).toEqual({
      decisionMismatchCount: 0,
      hardViolationCount: 0,
      runsWithIncompletePolicyCases: 0,
      phaseMismatchCounts: { admission: 0, recall: 0, ranking: 0, batch: 0, final: 0 },
      phaseExecutions: { admission: 2, recall: 2, ranking: 2, batch: 2, final: 2 }
    });
  });

  it('重放 pressure/context，并能检出非 Final 阶段的期望漂移', () => {
    const pressure = [{
      source: 'early_skip', reasonCode: 'early_skip_track', direction: 'penalty' as const,
      amount: 0.4, severity: 'suppress' as const, temporaryExcluded: true
    }];
    const policyCase = replayPolicyCase({
      pressure,
      expected: {
        admission: { action: 'admit', reasonCodes: ['admission_eligible'] },
        recall: {
          action: 'suppress',
          reasonCodes: ['temporary_queue_exclusion', 'early_skip_track_suppression']
        },
        ranking: null,
        batch: null,
        final: null,
        finalContext: null
      }
    });
    const exported = exportDjV2Replay({
      episodes: [], selectionRuns: [], retrievalAttempts: [], policyCases: [policyCase]
    }, replayExportOptions());
    expect(replayDjV2(exported).policyReplay).toMatchObject({
      decisionMismatchCount: 0,
      phaseMismatchCounts: { admission: 0, recall: 0, ranking: 0, batch: 0, final: 0 },
      phaseExecutions: { admission: 1, recall: 1, ranking: 0, batch: 0, final: 0 }
    });

    exported.policyCases[0]!.expected.recall = {
      action: 'include', reasonCodes: ['recall_included']
    };
    expect(replayDjV2(exported).policyReplay).toMatchObject({
      decisionMismatchCount: 1,
      phaseMismatchCounts: { admission: 0, recall: 1, ranking: 0, batch: 0, final: 0 }
    });
  });

  it('用独立 live Final context 重放最后一刻排除和幂等，不污染早期 Admission', () => {
    const explicit = replayPolicyCase({
      caseId: 'case-explicit',
      candidateId: 'candidate-explicit',
      candidateTrackKey: 'track-key-explicit',
      candidateArtistKey: 'artist-explicit',
      batchIndex: 0,
      expected: replayPolicyExpectation({
        baseScore: 0.5,
        final: { action: 'reject', reasonCodes: ['explicit_track_exclusion'] },
        finalContext: { ...replayPolicyContext(), explicitTrackExcluded: true }
      })
    });
    const idempotent = replayPolicyCase({
      caseId: 'case-idempotent',
      candidateId: 'candidate-idempotent',
      candidateTrackKey: 'track-key-idempotent',
      candidateArtistKey: 'artist-idempotent',
      source: 'liked',
      batchIndex: 1,
      expected: replayPolicyExpectation({
        baseScore: 0.5,
        final: { action: 'reject', reasonCodes: ['played_track_idempotency'] },
        finalContext: { ...replayPolicyContext(), playedTrack: true }
      })
    });
    const exported = exportDjV2Replay({
      episodes: [],
      selectionRuns: [],
      retrievalAttempts: [],
      policyCases: [explicit, idempotent]
    }, replayExportOptions());

    expect(replayDjV2(exported).policyReplay).toMatchObject({
      decisionMismatchCount: 0,
      hardViolationCount: 0,
      phaseMismatchCounts: { admission: 0, recall: 0, ranking: 0, batch: 0, final: 0 },
      phaseExecutions: { admission: 2, recall: 2, ranking: 2, batch: 2, final: 2 }
    });
  });

  it('以 0600 权限创建脱敏输出文件', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-replay-'));
    const inputPath = path.join(tempDir, 'input.json');
    const outputPath = path.join(tempDir, 'output.json');
    fs.writeFileSync(
      inputPath,
      JSON.stringify({ episodes: [], selectionRuns: [], retrievalAttempts: [] }),
    );

    try {
      exportDjV2ReplayFile({
        inputPath,
        outputPath,
        salt: 'one-time-test-salt-with-enough-entropy',
        timeShiftMs: 86_400_000,
        nowMs: 1_700_000_000_000,
      });

      expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toMatchObject({ schemaVersion: 2 });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('从只读 30 天表构建输入、忽略预算外不完整 run 并执行当前五阶段 policy', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossfadio-replay-builder-'));
    const dbPath = path.join(tempDir, 'state.db');
    const startedAtMs = Date.now() - 1_000;
    const startedAt = new Date(startedAtMs).toISOString();
    const olderStartedAt = new Date(startedAtMs - 1).toISOString();
    const completedAt = new Date(startedAtMs + 250).toISOString();
    const futureStartedAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    const futureCompletedAt = new Date(Date.now() + 24 * 60 * 60 * 1_000 + 250).toISOString();
    const narrationDeadlineAt = new Date(startedAtMs + 24 * 60 * 60 * 1_000).toISOString();
    const expiresAt = new Date(startedAtMs + 30 * 24 * 60 * 60 * 1_000).toISOString();

    try {
      execFileSync('python3', ['-c', [
        'import sqlite3, sys',
        'connection = sqlite3.connect(sys.argv[1])',
        'connection.executescript(sys.stdin.read())',
        'connection.commit()',
        'connection.close()',
      ].join('; '), dbPath], {
        encoding: 'utf8',
        input: `
          CREATE TABLE listening_episodes (
            id TEXT, user_id TEXT, track_id TEXT, started_at TEXT, ended_at TEXT,
            duration_ms INTEGER, position_ms INTEGER, listened_ms INTEGER,
            outcome TEXT, protocol_version INTEGER
          );
          CREATE TABLE selection_replay_runs (
            id TEXT, user_id TEXT, run_id TEXT, selected_track_ids_json TEXT,
            candidate_count INTEGER, eligible_count INTEGER, appended_count INTEGER,
            latency_ms INTEGER, hard_violation_count INTEGER, prompt_json_status TEXT,
            journey_published INTEGER, narration_status TEXT,
            narration_deadline_at TEXT,
            outcome TEXT, reason_codes_json TEXT, started_at TEXT,
            completed_at TEXT, expires_at TEXT
          );
          CREATE TABLE retrieval_attempts (
            id TEXT, user_id TEXT, run_id TEXT, source TEXT, request_kind TEXT,
            normalized_query TEXT, attempted_at TEXT, searched_count INTEGER,
            result_count INTEGER, added_count INTEGER, selected_count INTEGER
          );
          CREATE TABLE selection_policy_replay_cases (
            id TEXT, user_id TEXT, run_id TEXT, candidate_id TEXT,
            candidate_track_key TEXT, candidate_artist_key TEXT, mode TEXT,
            identity_valid INTEGER, source TEXT, quality_signals_json TEXT,
            title_motif_keys_json TEXT, base_score REAL, batch_index INTEGER,
            batch_limit INTEGER, context_json TEXT, pressure_json TEXT,
            expected_json TEXT,
            created_at TEXT, expires_at TEXT
          );
          INSERT INTO listening_episodes VALUES (
            'episode-1', 'user-1', 'track-1', '${startedAt}', '${completedAt}',
            180000, 60000, 59000, 'completed', 2
          );
          INSERT INTO listening_episodes VALUES (
            'episode-future', 'user-1', 'track-future', '${futureStartedAt}', '${futureCompletedAt}',
            180000, 60000, 59000, 'completed', 2
          );
          INSERT INTO selection_replay_runs VALUES (
            'selection-1', 'user-1', 'run-1', '["track-1"]', 1, 1, 1, 250,
            0, 'valid', 1, 'succeeded', '${narrationDeadlineAt}',
            'succeeded', '["final_eligible"]',
            '${startedAt}', '${completedAt}', '${expiresAt}'
          );
          INSERT INTO selection_replay_runs VALUES (
            'selection-running', 'user-1', 'run-running', '[]', 0, 0, 0, 0,
            0, 'not_observed', 0, 'not_applicable', NULL,
            'failed', '[]', '${startedAt}', NULL, '${expiresAt}'
          );
          INSERT INTO selection_replay_runs VALUES (
            'selection-future', 'user-1', 'run-future', '[]', 0, 0, 0, 0,
            0, 'valid', 1, 'not_applicable', NULL,
            'empty', '[]', '${futureStartedAt}', '${futureCompletedAt}', '${expiresAt}'
          );
          INSERT INTO selection_replay_runs VALUES (
            'selection-overflow', 'user-1', 'run-overflow', '[]', 2000, 0, 0, 0,
            0, 'valid', 1, 'not_applicable', NULL,
            'empty', '[]', '${olderStartedAt}', '${completedAt}', '${expiresAt}'
          );
          INSERT INTO retrieval_attempts VALUES (
            'attempt-1', 'user-1', 'run-1', 'ncm_search', 'autonomous',
            'fixture query', '${startedAt}', 10, 3, 1, 1
          );
          INSERT INTO retrieval_attempts VALUES (
            'attempt-future', 'user-1', 'run-future', 'ncm_search', 'autonomous',
            'future fixture query', '${futureStartedAt}', 10, 3, 1, 1
          );
          INSERT INTO selection_policy_replay_cases VALUES (
            'case-1', 'user-1', 'run-1', 'candidate-1', 'track-key-1',
            'artist-key-1', 'autonomous', 1, 'search', '{}', '[]', 0.5, 0, 1,
            '{"explicitlyRequested":false,"explicitTrackExcluded":false,"explicitArtistExcluded":false,"temporaryTrackExcluded":false,"temporaryArtistExcluded":false,"retrievalCooldown":false,"queueContainsTrack":false,"playedTrack":false}',
            '[]',
            '{"admission":{"action":"admit","reasonCodes":["admission_eligible"]},"recall":{"action":"include","reasonCodes":["recall_included"]},"ranking":{"action":"rank","reasonCodes":["ranking_scored"],"adjustedScore":0.5,"contributions":[]},"batch":[{"action":"select","reasonCodes":["batch_selected"]}],"final":{"action":"select","reasonCodes":["final_eligible"]},"finalContext":{"explicitlyRequested":false,"explicitTrackExcluded":false,"explicitArtistExcluded":false,"temporaryTrackExcluded":false,"temporaryArtistExcluded":false,"retrievalCooldown":false,"queueContainsTrack":false,"playedTrack":false}}',
            '${startedAt}', '${expiresAt}'
          );
          INSERT INTO selection_policy_replay_cases VALUES (
            'case-running', 'user-1', 'run-running', 'candidate-running',
            'track-key-running', 'artist-key-running', 'autonomous', 1, 'search',
            '{}', '[]', 0.5, 0, 1,
            '{"explicitlyRequested":false,"explicitTrackExcluded":false,"explicitArtistExcluded":false,"temporaryTrackExcluded":false,"temporaryArtistExcluded":false,"retrievalCooldown":false,"queueContainsTrack":false,"playedTrack":false}',
            '[]',
            '{"admission":{"action":"admit","reasonCodes":["admission_eligible"]},"recall":{"action":"include","reasonCodes":["recall_included"]},"ranking":{"action":"rank","reasonCodes":["ranking_scored"],"adjustedScore":0.5,"contributions":[]},"batch":[{"action":"select","reasonCodes":["batch_selected"]}],"final":{"action":"select","reasonCodes":["final_eligible"]},"finalContext":{"explicitlyRequested":false,"explicitTrackExcluded":false,"explicitArtistExcluded":false,"temporaryTrackExcluded":false,"temporaryArtistExcluded":false,"retrievalCooldown":false,"queueContainsTrack":false,"playedTrack":false}}',
            '${startedAt}', '${expiresAt}'
          );
        `,
      });

      const builderOutput = execFileSync(
        'python3',
        [path.resolve('scripts/build-readonly-replay-input.py')],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env: { ...process.env, CROSSFADIO_REPLAY_DB: dbPath },
        },
      );
      const exported = exportDjV2Replay(JSON.parse(builderOutput), {
        salt: 'one-time-test-salt-with-enough-entropy',
        timeShiftMs: 0,
        nowMs: Date.now(),
      });
      const replay = replayDjV2(exported);

      expect(replay.counts).toEqual({
        episodes: 1,
        selectionRuns: 1,
        retrievalAttempts: 1,
        policyCases: 1,
      });
      expect(replay.policyReplay).toEqual({
        decisionMismatchCount: 0,
        hardViolationCount: 0,
        runsWithIncompletePolicyCases: 0,
        phaseMismatchCounts: { admission: 0, recall: 0, ranking: 0, batch: 0, final: 0 },
        phaseExecutions: { admission: 1, recall: 1, ranking: 1, batch: 1, final: 1 },
      });
      expect(assertReplayReleaseGates(replay, replay)).toEqual({ passed: true, failures: [] });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('只验证会进入预算前缀的 run，并在达到 case/run 上限时立即停止', () => {
    const scriptPath = JSON.stringify(path.resolve('scripts/build-readonly-replay-input.py'));
    const output = execFileSync('python3', ['-c', `
import datetime as dt, importlib.util, json, sqlite3
spec = importlib.util.spec_from_file_location("replay_builder", ${scriptPath})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
runs = [
  {"userId":"user","runId":"new","candidateCount":1500},
  {"userId":"user","runId":"overflow","candidateCount":600},
  {"userId":"user","runId":"older","candidateCount":1}
]
counts = {("user","new"):1500, ("user","overflow"):600, ("user","older"):1}
selected = module.select_complete_run_prefix(runs, counts)
max_run_count = len(module.select_complete_run_prefix([
  {"userId":"user","runId":f"zero-{index}","candidateCount":0}
  for index in range(501)
], {}))
selected_incomplete = None
try:
  module.select_complete_run_prefix(runs, {**counts, ("user","new"):1499})
except RuntimeError as error:
  selected_incomplete = str(error)
unselected_incomplete = module.select_complete_run_prefix(
  runs,
  {**counts, ("user","overflow"):599, ("user","older"):0}
)
exact_budget = module.select_complete_run_prefix([
  {"userId":"user","runId":"exact","candidateCount":2000},
  {"userId":"user","runId":"zero-after-budget","candidateCount":0}
], {("user","exact"):2000})
connection = sqlite3.connect(":memory:")
connection.row_factory = sqlite3.Row
connection.execute("""
  CREATE TABLE selection_replay_runs (
    user_id TEXT, run_id TEXT, started_at TEXT, completed_at TEXT,
    selected_track_ids_json TEXT, candidate_count INTEGER, eligible_count INTEGER,
    appended_count INTEGER, latency_ms INTEGER, hard_violation_count INTEGER,
    prompt_json_status TEXT, journey_published INTEGER, narration_status TEXT,
    narration_deadline_at TEXT, outcome TEXT, reason_codes_json TEXT
  )
""")
origin = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
for index in range(502):
  started_at = (origin + dt.timedelta(seconds=index)).isoformat()
  connection.execute(
    "INSERT INTO selection_replay_runs VALUES (?, ?, ?, ?, '[]', 0, 0, 0, 0, 0, 'valid', 1, 'not_applicable', NULL, 'empty', '[]')",
    ("user", f"run-{index:03d}", started_at, started_at)
  )
candidates = module.selection_run_candidates(
  connection,
  "2000-01-01T00:00:00Z",
  "2100-01-01T00:00:00Z"
)
print(json.dumps({
  "selected":[row["runId"] for row in selected],
  "maxRunCount":max_run_count,
  "selectedIncomplete":selected_incomplete,
  "unselectedIncomplete":[row["runId"] for row in unselected_incomplete],
  "exactBudget":[row["runId"] for row in exact_budget],
  "candidateQuery": {
    "count": len(candidates),
    "first": candidates[0]["runId"],
    "last": candidates[-1]["runId"]
  }
}))
`], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }
    });

    expect(JSON.parse(output)).toEqual({
      selected: ['new'],
      maxRunCount: 500,
      selectedIncomplete: 'incomplete policy replay coverage for user/new: expected 1500, got 1499',
      unselectedIncomplete: ['new'],
      exactBudget: ['exact'],
      candidateQuery: { count: 501, first: 'run-501', last: 'run-001' }
    });
  }, 15_000);

  it('exporter 拒绝负数时长', () => {
    expect(() =>
      exportDjV2Replay(
        {
          episodes: [
            {
              episodeId: 'episode-1',
              userId: 'user-1',
              trackId: 'track-1',
              startedAt: 1_700_000_000_000,
              positionMs: 0,
              listenedMs: -1,
              outcome: 'interrupted',
              protocolVersion: 2,
            },
          ],
          selectionRuns: [],
          retrievalAttempts: [],
        },
        {
          salt: 'one-time-test-salt-with-enough-entropy',
          timeShiftMs: 86_400_000,
          nowMs: 1_700_000_100_000,
        },
      ),
    ).toThrow(/episodes\[0\]\.listenedMs.*non-negative integer/i);
  });
});

function replayExportOptions() {
  return {
    salt: 'one-time-test-salt-with-enough-entropy',
    timeShiftMs: 0,
    nowMs: 1_700_000_100_000
  };
}

function replaySelectionRun(
  overrides: Partial<DjV2ReplaySelectionRunInput> = {}
): DjV2ReplaySelectionRunInput {
  return {
    runId: 'run-1',
    userId: 'user-1',
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_000_010,
    selectedTrackIds: [],
    candidateCount: 0,
    eligibleCount: 0,
    appendedCount: 0,
    latencyMs: 10,
    hardViolationCount: 0,
    promptJsonStatus: 'valid',
    journeyPublished: true,
    narrationStatus: 'not_applicable',
    outcome: 'empty',
    reasonCodes: ['no_candidate'],
    ...overrides
  };
}

function replayPolicyExpectation(input: {
  baseScore: number;
  batch?: DjV2ReplayPolicyCaseInput['expected']['batch'];
  final?: DjV2ReplayPolicyCaseInput['expected']['final'];
  finalContext?: DjV2ReplayPolicyCaseInput['expected']['finalContext'];
}): DjV2ReplayPolicyCaseInput['expected'] {
  const final = input.final === undefined
    ? { action: 'select', reasonCodes: ['final_eligible'] }
    : input.final;
  return {
    admission: { action: 'admit', reasonCodes: ['admission_eligible'] },
    recall: { action: 'include', reasonCodes: ['recall_included'] },
    ranking: {
      action: 'rank', reasonCodes: ['ranking_scored'],
      adjustedScore: input.baseScore, contributions: []
    },
    batch: input.batch ?? [{ action: 'select', reasonCodes: ['batch_selected'] }],
    final,
    finalContext: final === null
      ? null
      : input.finalContext ?? replayPolicyContext()
  };
}

function replayPolicyCase(
  overrides: Partial<DjV2ReplayPolicyCaseInput> = {}
): DjV2ReplayPolicyCaseInput {
  return {
    caseId: 'case-1',
    runId: 'run-1',
    userId: 'user-1',
    candidateId: 'candidate-1',
    candidateTrackKey: 'track-key-1',
    candidateArtistKey: 'artist-key-1',
    mode: 'autonomous',
    identityValid: true,
    source: 'search',
    qualitySignals: {},
    titleMotifKeys: [],
    baseScore: 0.5,
    batchIndex: 0,
    batchLimit: 2,
    context: replayPolicyContext(),
    pressure: [],
    expected: replayPolicyExpectation({ baseScore: 0.5 }),
    ...overrides
  };
}

function replayPolicyContext(): DjV2ReplayPolicyCaseInput['context'] {
  return {
    explicitlyRequested: false,
    explicitTrackExcluded: false,
    explicitArtistExcluded: false,
    temporaryTrackExcluded: false,
    temporaryArtistExcluded: false,
    retrievalCooldown: false,
    queueContainsTrack: false,
    playedTrack: false
  };
}

describe('DJ v2 replay baseline', () => {
  it('用固定 fixture 锁定手动跳过的 50% 负反馈边界', () => {
    const fixturePath = path.resolve('tests/fixtures/dj-v2/feedback-boundary.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    expect(replayListeningFeedback(fixture)).toEqual({
      manualSkipCount: 2,
      earlySkipNegativeCount: 1,
      midpointOrLaterSkipCount: 1,
      unknownDurationSkipCount: 0
    });
  });

  it('汇总硬违规、补歌成功率与 p95 延迟', () => {
    const exported = exportDjV2Replay(
      {
        episodes: [],
        selectionRuns: [
          {
            runId: 'run-1',
            userId: 'user-1',
            startedAt: 1_700_000_000_000,
            completedAt: 1_700_000_000_100,
            selectedTrackIds: ['track-1'],
            candidateCount: 0,
            eligibleCount: 0,
            appendedCount: 1,
            latencyMs: 100,
            hardViolationCount: 0,
            promptJsonStatus: 'valid',
            journeyPublished: true,
            narrationStatus: 'succeeded',
            outcome: 'succeeded',
            reasonCodes: ['taste_match'],
          },
          {
            runId: 'run-2',
            userId: 'user-1',
            startedAt: 1_700_000_010_000,
            completedAt: 1_700_000_010_200,
            selectedTrackIds: [],
            candidateCount: 0,
            eligibleCount: 0,
            appendedCount: 0,
            latencyMs: 200,
            hardViolationCount: 1,
            promptJsonStatus: 'valid',
            journeyPublished: true,
            narrationStatus: 'not_applicable',
            outcome: 'empty',
            reasonCodes: ['no_eligible_candidate'],
          },
        ],
        retrievalAttempts: [],
      },
      {
        salt: 'one-time-test-salt-with-enough-entropy',
        timeShiftMs: 0,
        nowMs: 1_700_000_100_000,
      },
    );
    exported.selectionRuns[0]!.candidateCount = 5;
    exported.selectionRuns[0]!.eligibleCount = 2;
    exported.selectionRuns[1]!.candidateCount = 3;

    expect(replayDjV2(exported)).toEqual({
      schemaVersion: 2,
      counts: { episodes: 0, selectionRuns: 2, retrievalAttempts: 0, policyCases: 0 },
      baseline: {
        hardViolationCount: 1,
        queueSuccessRate: 0.5,
        p95LatencyMs: 200,
        promptJsonValidityRate: 1,
        journeyAvailabilityRate: 1,
        narrationSuccessWithin24hRate: 1,
      },
      policyReplay: {
        decisionMismatchCount: 0,
        hardViolationCount: 0,
        runsWithIncompletePolicyCases: 2,
        phaseMismatchCounts: { admission: 0, recall: 0, ranking: 0, batch: 0, final: 0 },
        phaseExecutions: { admission: 0, recall: 0, ranking: 0, batch: 0, final: 0 }
      }
    });
  });

  it('拒绝包含未哈希标识的 replay 文件', () => {
    expect(() =>
      replayDjV2({
        schemaVersion: 2,
        episodes: [
          {
            episodeId: 'raw-episode-id',
            userId: 'raw-user-id',
            trackId: 'raw-track-id',
            startedAt: 1_700_000_000_000,
            positionMs: 0,
            listenedMs: 0,
            outcome: 'interrupted',
            protocolVersion: 2,
          },
        ],
        selectionRuns: [],
        retrievalAttempts: [],
        policyCases: [],
      } as never),
    ).toThrow(/episodes\[0\]\.episodeId.*hashed/i);
  });

  it('replayer 拒绝缺少 completedAt 的 Selection Run', () => {
    const exported = exportDjV2Replay({
      episodes: [], selectionRuns: [replaySelectionRun()], retrievalAttempts: []
    }, replayExportOptions());
    delete (exported.selectionRuns[0] as { completedAt?: number }).completedAt;

    expect(() => replayDjV2(exported as never)).toThrow(
      /selectionRuns\[0\]\.completedAt.*non-negative integer/i
    );
  });

  it('replayer 拒绝 completedAt 早于 startedAt 的 Selection Run', () => {
    const exported = exportDjV2Replay({
      episodes: [], selectionRuns: [replaySelectionRun()], retrievalAttempts: []
    }, replayExportOptions());
    exported.selectionRuns[0]!.completedAt = exported.selectionRuns[0]!.startedAt - 1;

    expect(() => replayDjV2(exported)).toThrow(
      /selectionRuns\[0\]\.completedAt.*greater than or equal to startedAt/i
    );
  });

  it('拒绝手工 replay 文件中的自然语言字段', () => {
    const exported = exportDjV2Replay(
      {
        episodes: [],
        selectionRuns: [
          {
            runId: 'run-1',
            userId: 'user-1',
            startedAt: 1_700_000_000_000,
            completedAt: 1_700_000_000_010,
            selectedTrackIds: [],
            candidateCount: 0,
            eligibleCount: 0,
            appendedCount: 0,
            latencyMs: 10,
            hardViolationCount: 0,
            promptJsonStatus: 'valid',
            journeyPublished: true,
            narrationStatus: 'not_applicable',
            outcome: 'empty',
            reasonCodes: ['no_candidate'],
          },
        ],
        retrievalAttempts: [],
      },
      {
        salt: 'one-time-test-salt-with-enough-entropy',
        timeShiftMs: 86_400_000,
        nowMs: 1_700_000_100_000,
      },
    );
    exported.selectionRuns[0]!.reasonCodes = ['raw user message'];

    expect(() => replayDjV2(exported)).toThrow(
      /selectionRuns\[0\]\.reasonCodes\[0\].*machine code/i,
    );
  });

  it('仓库人工 fixture 可直接执行并得到稳定基线', () => {
    const fixturePath = path.resolve('tests/fixtures/dj-v2/baseline.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    expect(replayDjV2(fixture)).toEqual({
      schemaVersion: 2,
      counts: { episodes: 2, selectionRuns: 2, retrievalAttempts: 1, policyCases: 2 },
      baseline: {
        hardViolationCount: 0,
        queueSuccessRate: 0.5,
        p95LatencyMs: 1_800,
        promptJsonValidityRate: 1,
        journeyAvailabilityRate: 1,
        narrationSuccessWithin24hRate: 1,
      },
      policyReplay: {
        decisionMismatchCount: 0,
        hardViolationCount: 0,
        runsWithIncompletePolicyCases: 0,
        phaseMismatchCounts: { admission: 0, recall: 0, ranking: 0, batch: 0, final: 0 },
        phaseExecutions: { admission: 2, recall: 1, ranking: 1, batch: 1, final: 1 }
      }
    });
  });

  it('Prompt JSON 合法率只统计 observed 三态运行', () => {
    const fixturePath = path.resolve('tests/fixtures/dj-v2/baseline.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    fixture.selectionRuns[0].promptJsonStatus = 'not_observed';
    fixture.selectionRuns[1].promptJsonStatus = 'valid';
    fixture.selectionRuns.push({
      ...fixture.selectionRuns[1],
      runId: 'h_12121212121212121212121212121212',
      candidateCount: 0,
      promptJsonStatus: 'invalid'
    });

    expect(replayDjV2(fixture).baseline.promptJsonValidityRate).toBe(0.5);

    fixture.selectionRuns.forEach((run: { promptJsonStatus: string }) => {
      run.promptJsonStatus = 'not_observed';
    });
    const notObserved = replayDjV2(fixture);
    expect(notObserved.baseline.promptJsonValidityRate).toBeNull();
    expect(assertReplayReleaseGates(notObserved, notObserved)).toEqual({
      passed: true,
      failures: []
    });
  });

  it('要求 current 和 baseline 每个 run 的 policy case 数精确等于 candidateCount', () => {
    const fixturePath = path.resolve('tests/fixtures/dj-v2/baseline.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const clean = replayDjV2(fixture);
    fixture.selectionRuns = [fixture.selectionRuns[0]];
    fixture.selectionRuns[0].candidateCount = 2;
    fixture.policyCases = [fixture.policyCases[0]];
    const incomplete = replayDjV2(fixture);

    expect(incomplete.policyReplay.runsWithIncompletePolicyCases).toBe(1);
    expect(() => assertReplayReleaseGates(incomplete, clean)).toThrow(/policy_case_coverage_incomplete/);
    expect(() => assertReplayReleaseGates(clean, incomplete)).toThrow(/baseline_policy_case_coverage_incomplete/);
  });

  it('拒绝 baseline policy replay 自身的 mismatch 和 hard violation', () => {
    const fixturePath = path.resolve('tests/fixtures/dj-v2/baseline.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const clean = replayDjV2(fixture);
    const badBaseline = {
      ...clean,
      policyReplay: {
        ...clean.policyReplay,
        decisionMismatchCount: 1,
        hardViolationCount: 1
      }
    };

    expect(() => assertReplayReleaseGates(clean, badBaseline)).toThrow(
      /baseline_policy_decision_mismatch.*baseline_policy_hard_violation/
    );
  });

  it('hard-fails release gates on violations, queue regression, latency regression or invalid final JSON', () => {
    const baseline = {
      schemaVersion: 2 as const,
      counts: { episodes: 0, selectionRuns: 10, retrievalAttempts: 0, policyCases: 1 },
      baseline: {
        hardViolationCount: 0,
        queueSuccessRate: 0.8,
        p95LatencyMs: 1_000,
        promptJsonValidityRate: 1,
        journeyAvailabilityRate: 1,
        narrationSuccessWithin24hRate: 1
      },
      policyReplay: {
        decisionMismatchCount: 0,
        hardViolationCount: 0,
        runsWithIncompletePolicyCases: 0,
        phaseMismatchCounts: { admission: 0, recall: 0, ranking: 0, batch: 0, final: 0 },
        phaseExecutions: { admission: 1, recall: 1, ranking: 1, batch: 1, final: 1 }
      }
    };
    expect(assertReplayReleaseGates(baseline, baseline)).toEqual({ passed: true, failures: [] });
    expect(() => assertReplayReleaseGates({
      ...baseline,
      baseline: {
        hardViolationCount: 1,
        queueSuccessRate: 0.7,
        p95LatencyMs: 1_151,
        promptJsonValidityRate: 0.99,
        journeyAvailabilityRate: 0.99,
        narrationSuccessWithin24hRate: 0.97
      }
    }, baseline)).toThrow(
      /hard_violation_count_nonzero.*queue_success_rate_regressed.*p95_latency_regressed_over_15_percent.*prompt_json_validity_below_100_percent.*journey_availability_below_100_percent.*narration_success_within_24h_below_98_percent/
    );
  });

  it('拒绝负数计数以免基线指标失真', () => {
    const fixturePath = path.resolve('tests/fixtures/dj-v2/baseline.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    fixture.selectionRuns[0].hardViolationCount = -1;

    expect(() => replayDjV2(fixture)).toThrow(
      /selectionRuns\[0\]\.hardViolationCount.*non-negative integer/i,
    );
  });
});
