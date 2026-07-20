# DJ v2 replay fixtures

这里仅存放人工构造、已经脱敏且可提交的 replay 数据。真实线上导出必须写到 `.local/dj-v2-replay/`，不得复制进本目录。

- `baseline.json`：schema v2 的最小可执行样本，会真实调用当前 Admission、Recall、Ranking、Batch 与 Final Policy。
- `feedback-boundary.json`：两次手动跳过分别位于 50% 前一毫秒和正好 50%，锁定“只有前者产生 Early Skip 负反馈”。
- `server-scenarios.json`：无真实账号的 server-level 场景输入，覆盖 hard gate、合作艺人隔离和 Journey 异步润色生命周期；它包含人工可读实体，因此不属于可上传的脱敏 replay。

## Exporter 输入

顶层只能包含 `episodes`、`selectionRuns`、`retrievalAttempts`、`policyCases`。每类最多分别为 1,000、500、1,000、2,000 条，主事件时间必须在导出时点之前 30 天内。Selection/Policy 必须按完整 run 采样：构建器在同一个固定的只读事务里，按新到旧最多读取 501 个已完成 run；随后选择同时满足 500 runs / 2,000 cases 上限的最新前缀，只读取并校验该前缀的全部 cases。达到任一预算即停止，预算外的旧 run 或尚未完成的 run 不参与统计与校验；禁止独立截断 `policyCases`。

- `episodes`：`episodeId`、`userId`、`trackId`、可选 `primaryArtistId`、`startedAt`、可选 `endedAt` / `durationMs`、`positionMs`、`listenedMs`、`outcome`、`protocolVersion`。
- `selectionRuns`：`runId`、`userId`、`startedAt`、必填且不早于开始时间的 `completedAt`、`selectedTrackIds`、`candidateCount`、`eligibleCount`、`appendedCount`、`latencyMs`、`hardViolationCount`、`promptJsonStatus`（`not_observed` / `valid` / `invalid`）、`journeyPublished`（同步 Journey 已发布）、`narrationStatus`、可选 `narrationDeadlineAt`、`outcome`、`reasonCodes`。Prompt JSON 合法率只统计 observed；Narration 24 小时指标只统计 `succeeded` / `failed`，`pending` 与 `not_applicable` 不进入分母。
- `retrievalAttempts`：`attemptId`、可选 `runId`、`userId`、`source`、`requestKind`、`normalizedQuery`、`attemptedAt`、`searchedCount`、`resultCount`、`addedCount`、`selectedCount`。
- `policyCases`：只包含哈希前的实体 key、严格枚举/数值范围内的机器质量信号、标题 motif key、各候选上下文与 pressure，以及 Admission / Recall / Ranking / Batch / Final 的真实期望；不含歌名、艺人名、prompt 或自然语言。同一个 `runId` 的候选会作为一个真实 Batch 一起重放，而不是逐条按单候选重放。Replay 会逐 run 精确比较 case 数与 `candidateCount`；current 或 baseline 任一不完整都会阻断 release gate。

所有未知字段都会失败。禁止字段或内容包括 raw chat、message、PDC、prompt、歌词、cookie、token、URL、authorization、secret 和原始日志正文。`reasonCodes` 与 `source` 都只能使用小写下划线机器码；检索词不会进入输出，只生成一致 `queryFingerprint`。

## 本地人工数据

```bash
mkdir -p .local/dj-v2-replay
DJ_V2_REPLAY_SALT="$(openssl rand -hex 32)" \
  pnpm exec tsx scripts/export-dj-v2-replay.ts \
  --input path/to/artificial-input.json \
  --output .local/dj-v2-replay/artificial.json \
  --shift-ms -31536000000

pnpm exec tsx scripts/replay-dj-v2.ts \
  --input .local/dj-v2-replay/artificial.json \
  --baseline tests/fixtures/dj-v2/baseline.json
```

仓库内的离线验收可直接运行：

```bash
pnpm test -- tests/unit/dj-v2-replay.spec.ts tests/unit/dj-v2-server-scenarios.spec.ts
```

salt 只通过环境变量传入，不写命令行、文件或输出；每批数据重新生成。Exporter 以 `0600` 新建输出，目标已存在时会失败而不是覆盖。
