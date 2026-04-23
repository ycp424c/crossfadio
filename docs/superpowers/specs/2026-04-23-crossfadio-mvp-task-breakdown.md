# Crossfadio MVP 任务拆分与持续维护清单

- 文档日期: 2026-04-23
- 文档状态: Active（持续维护）
- 对应架构: `docs/superpowers/specs/2026-04-23-crossfadio-ai-dj-design.md`
- 目标范围: MVP（M0-M5）+ V1.1 预留任务位
- 维护人: justynchen

---

## 1. 使用说明

1. 本文档是执行视角，不替代架构设计；架构变更以架构文档为准。
2. 每个任务必须有唯一 ID（`M{里程碑}-{序号}`），并维护 `状态/依赖/验收`。
3. 估时单位是人天，默认可并行；里程碑工期以关键路径为准。
4. 状态枚举固定为：`TODO` / `DOING` / `BLOCKED` / `DONE` / `DROPPED`。

---

## 2. 拆分原则

1. 先打通端到端主路径（登录 -> 起播 -> 换歌 -> 聊天调整）。
2. 先做高风险依赖（NCM 直链、Web Audio 时序、LLM/TTS 契约、鉴权）。
3. 先做“可运行骨架”，再做体验打磨和边界失败策略。
4. 所有任务都要能落到代码目录与可验证的验收结果。

---

## 3. 里程碑总览（来自架构文档 §14）

| 里程碑 | 目标 | 预计工期 | 出口标准 |
|---|---|---:|---|
| M0 | 工程骨架 | 3d | `api/health` 可用，窗口可启动，日志/DB 初始化成功 |
| M1 | 播放 MVP | 4d | 扫码登录 + 连播 + crossfade 无明显断点 |
| M2 | AI 底座 | 3d | LLM/TTS 设置可用，`compute()` 跑通 chat/segue 最小链路 |
| M3 | 规划能力 | 3d | 每日计划可生成/持久化/展示，fallback 可用 |
| M4 | DJ 串场与动态调整 | 5d | 串场口播 + 聊天 actions + replan 生效 |
| M5 | 打磨与发布准备 | 3d | 冒烟 e2e 通过，文档齐全，可进入试用 |

---

## 4. 任务拆分（WBS）

### 4.0 并行轨道：UI 设计（Image 2）

说明：本轨道可与 M0 工程基座并行推进，先产出视觉方案，再由前端任务分批落地。

| ID | 任务 | 依赖 | 主要产出 | 验收标准 | 估时 | 优先级 | 状态 |
|---|---|---|---|---|---:|---|---|
| UI-01 | 建立 Image 2 设计规范（主题/栅格/关键组件） | 无 | UI 生成提示词基线与页面清单 | 能稳定生成 Player/Plan/Settings 三类页面 | 0.3 | P0 | DONE |
| UI-02 | 生成首批桌面高保真设计稿（Image 2） | UI-01 | 设计图 4 张（board/player/plan/settings） | 设计图已落盘到仓库设计目录 | 0.5 | P0 | DONE |
| UI-03 | 建立设计资产索引与版本规则 | UI-02 | `docs/superpowers/design/ui-image2/README.md` | 每张图可追溯用途、日期、版本 | 0.2 | P1 | DONE |
| UI-04 | 组件级细化稿（按钮/卡片/输入框/队列项） | UI-01 | 组件拆解设计图 | 覆盖 shadcn 二次样式改造所需最小组件集 | 0.6 | P1 | TODO |
| UI-05 | 响应式适配稿（桌面窄窗/常规宽窗） | UI-02 | 两档断点设计图 | Player/Plan/Settings 在窄窗不破版 | 0.5 | P1 | TODO |
| UI-06 | 动效稿（crossfade 时间轴/口播状态） | UI-02 | 关键状态帧（至少 6 帧） | 能指导 M4 Timeline 可视化实现 | 0.5 | P2 | TODO |
| UI-07 | 设计到代码映射清单（Design -> Component） | UI-04 | 组件映射表（设计图区域 -> 代码组件） | 每个核心模块有明确实现归属 | 0.3 | P0 | TODO |

### 4.1 M0 工程骨架（3d）

| ID | 任务 | 依赖 | 主要产出 | 验收标准 | 估时 | 优先级 | 状态 |
|---|---|---|---|---|---:|---|---|
| M0-01 | 初始化 Electron + Vite + TS + React + Tailwind + shadcn | 无 | 可运行工程骨架、基础脚本 | `pnpm dev` 能打开窗口且 HMR 正常 | 0.5 | P0 | DONE |
| M0-02 | 建立主/预加载/渲染三层目录与 shared schema 目录 | M0-01 | `src/main` `src/preload` `src/renderer` `src/shared` | 目录与入口能被构建识别 | 0.3 | P0 | DONE |
| M0-03 | 主进程启动流程与窗口管理（含单实例约束） | M0-01 | `main/index.ts` 启动与生命周期管理 | 二次启动不重复开实例 | 0.4 | P0 | DONE |
| M0-04 | 内嵌 HTTP + WS 服务骨架（含 session token 鉴权） | M0-02 | `server/routes` + `ws.ts` | `GET /api/health` + WS 连接鉴权可用 | 0.6 | P0 | DONE |
| M0-05 | SQLite 初始化与迁移框架（messages/plays/plan/prefs/tts_cache） | M0-02 | `store/db.ts` + `migrations.ts` | 首次启动自动建表，不重复建表报错 | 0.5 | P0 | DONE |
| M0-06 | user-template 首次复制到 userData/user | M0-03 | 语料模板拷贝逻辑 | 空目录首次启动能落盘模板文件 | 0.3 | P1 | DONE |
| M0-07 | pino 日志落盘与日志分级约定 | M0-03 | `logger.ts` + 文件日志 | 日志按天写入 `userData/logs` | 0.4 | P1 | DONE |

### 4.2 M1 播放 MVP（4d）

| ID | 任务 | 依赖 | 主要产出 | 验收标准 | 估时 | 优先级 | 状态 |
|---|---|---|---|---|---:|---|---|
| M1-01 | NCM 子进程管理与健康探测 | M0-03 | `ncm/spawn.ts` | 子进程崩溃可重启，状态可感知 | 0.5 | P0 | DOING |
| M1-02 | NCM 扫码登录接口（qr/status/logout） | M1-01 | `/api/ncm/login/*` | 扫码成功能拿 cookie 并持久化 | 0.7 | P0 | DOING |
| M1-03 | NCM 客户端封装（歌单/搜索/歌曲 URL/歌词） | M1-01 | `ncm/client.ts` | 单测可 mock 返回标准 DTO | 0.6 | P0 | DONE |
| M1-04 | Web Audio 双 deck 播放引擎基础能力 | M0-02 | `renderer/audio/engine.ts` | A/B deck 可切换、可停止/恢复 | 0.7 | P0 | DONE |
| M1-05 | 等能量 crossfade + filter sweep | M1-04 | `crossfade.ts` | 切歌时无明显音量塌陷 | 0.5 | P0 | DONE |
| M1-06 | `api/now` `api/next` + prefetch 时序 | M1-03 M1-04 | `routes/now,next.ts` + `prefetch.ts` | d-10s 预取，B deck 可按时就绪 | 0.5 | P0 | DONE |
| M1-07 | Player 视图（播放信息/队列/控制） | M1-04 | `views/Player` + 组件 | 可播放、暂停、skip、prev、like | 0.6 | P1 | TODO |
| M1-08 | 播放历史落库（plays）与基础错误码处理 | M0-05 M1-06 | `plays.ts` | 播放开始/结束、skip 原因可记录 | 0.4 | P1 | TODO |

### 4.3 M2 AI 底座（3d）

| ID | 任务 | 依赖 | 主要产出 | 验收标准 | 估时 | 优先级 | 状态 |
|---|---|---|---|---|---:|---|---|
| M2-01 | OpenAI-compatible LLM client（流式/非流式） | M0-04 | `llm/client.ts` `llm/stream.ts` | 可连通配置端点并返回统一结构 | 0.6 | P0 | TODO |
| M2-02 | OpenAI-compatible TTS client 与缓存索引 | M0-05 | `tts/client.ts` `tts/cache.ts` | hash 维度含 endpoint/model/voice/speed/format/text | 0.5 | P0 | TODO |
| M2-03 | `safeStorage` 凭证封装与降级策略 | M0-03 | `security.ts` | key/cookie 不明文落盘 | 0.5 | P0 | TODO |
| M2-04 | Settings 视图（LLM/TTS/声音试听） | M2-01 M2-02 M2-03 | `views/Settings` | 可保存配置、可试听、可错误提示 | 0.6 | P1 | TODO |
| M2-05 | Agent `compute(fragments)` 骨架与 schema 校验 | M0-02 M2-01 | `agent/compute.ts` `schema.ts` | 非法输出可重试/降级 | 0.5 | P0 | TODO |
| M2-06 | fragments 组装与 mode 模板（plan/segue/chat） | M2-05 | `fragments.ts` `modes.ts` | 输入 6 片完整拼装并可测试 | 0.4 | P0 | TODO |
| M2-07 | FakeLLM/FakeTTS 测试替身与基础集成测试 | M2-01 M2-02 M2-05 | `tests/unit` `tests/integration` | chat/segue 最小链路通过 | 0.4 | P1 | TODO |

### 4.4 M3 规划能力（3d）

| ID | 任务 | 依赖 | 主要产出 | 验收标准 | 估时 | 优先级 | 状态 |
|---|---|---|---|---|---:|---|---|
| M3-01 | scheduler（07:00 日规划 + 每小时检查） | M0-03 M2-06 | `scheduler.ts` | cron 可触发且防重入 | 0.5 | P0 | TODO |
| M3-02 | plan mode 输出契约与落库（plan/version） | M2-05 M0-05 | `plan.ts` | 每日计划可持久化覆盖更新 | 0.5 | P0 | TODO |
| M3-03 | query -> ncmId 兑现与匹配策略 | M1-03 M3-02 | `plan resolver` | query 能稳定映射 songId，失败返回 null | 0.5 | P0 | TODO |
| M3-04 | `playlists.json` 结构化元数据读取与校验 | M0-06 | `user-corpus/loader.ts` | segments/tags/energyRange/priority 校验通过 | 0.4 | P0 | TODO |
| M3-05 | fallback 计划打分器（segments+tags+energy） | M3-04 | `plan fallback scorer` | LLM 失败时可出可播计划 | 0.4 | P0 | TODO |
| M3-06 | `api/plan/*`（today/regenerate/replan-segment/gap-fill） | M0-04 M3-02 | `routes/plan.ts` | API 契约与 schema 一致 | 0.5 | P0 | TODO |
| M3-07 | Today Plan UI（4 时段 + 一键切段） | M3-06 | `components/TodayPlan` | 可展示/切段/刷新计划版本 | 0.4 | P1 | TODO |
| M3-08 | 天气注入（wttr/openweather）与错误降级 | M2-01 | `weather.ts` | 天气失败不阻塞生成计划 | 0.3 | P1 | TODO |

### 4.5 M4 DJ 串场与动态调整（5d）

| ID | 任务 | 依赖 | 主要产出 | 验收标准 | 估时 | 优先级 | 状态 |
|---|---|---|---|---|---:|---|---|
| M4-01 | segue mode 与 `api/segue/trigger` 异步流程 | M2-06 M0-04 | `routes/segue.ts` + requestId | 可在 d-12s 提前触发并异步返回 | 0.6 | P0 | TODO |
| M4-02 | TTS ready 事件与 `segue.tts-ready` WS 推送 | M4-01 M2-02 | `ws events` | renderer 收到 ready 后可安全装载音频 | 0.5 | P0 | TODO |
| M4-03 | “体验优先”串场时序（标准/晚到/模板/纯降级） | M4-01 M4-02 M1-05 | `performSegue` 编排 | 串场体验符合设计文档四级顺序 | 0.8 | P0 | TODO |
| M4-04 | 模板口播缓存机制（fallback tts） | M2-02 | `cache/tts/fallback` 管理 | 主 TTS 超时仍可播一条模板口播 | 0.4 | P1 | TODO |
| M4-05 | chat mode 流式输出与意图识别 | M2-06 M0-04 | `routes/chat.ts` + WS delta | chat.delta/chat.done 事件稳定 | 0.6 | P0 | TODO |
| M4-06 | Action 执行器（swap/add/skip/ban/replan/set_pref） | M4-05 M3-06 | `router.executeActions()` | actions 落地且队列实时更新 | 0.7 | P0 | TODO |
| M4-07 | Timeline 只读可视化（crossfade/ducking 时序） | M1-05 M4-03 | `components/Timeline` | 可视化和实际参数一致 | 0.5 | P1 | TODO |
| M4-08 | ChatPanel + Queue 同步刷新（queue-updated） | M4-05 M4-06 | `components/ChatPanel` | “跑步 30 分钟 Rap”3s 内触发队列变更 | 0.5 | P0 | TODO |
| M4-09 | 串场与聊天链路集成测试（FakeLLM/FakeTTS） | M4-03 M4-06 | integration tests | 回归覆盖 3 个关键场景 | 0.4 | P1 | TODO |

### 4.6 M5 打磨与发布准备（3d）

| ID | 任务 | 依赖 | 主要产出 | 验收标准 | 估时 | 优先级 | 状态 |
|---|---|---|---|---|---:|---|---|
| M5-01 | 全局错误 UX（toast/离线角标/登录过期引导） | M1-02 M3-06 M4-03 | 统一错误交互层 | 常见失败可感知且可恢复 | 0.5 | P1 | TODO |
| M5-02 | Profile 视图（`user/*.md` + playlists.json 编辑） | M0-06 M3-04 | `views/Profile` | 可编辑并实时校验语料格式 | 0.6 | P1 | TODO |
| M5-03 | 快捷指令与高频操作入口（安静/跑步/跳过） | M4-06 | 快捷指令面板 | 一键触发 action 成功 | 0.4 | P2 | TODO |
| M5-04 | e2e 冒烟（5 条关键链路） | M1-M4 完成 | `tests/e2e` | 本地通过登录->起播->换歌->聊天->重排 | 0.7 | P0 | TODO |
| M5-05 | README 与运维文档（配置、故障、隐私） | 全量 | 文档更新 | 新人可按文档 30 分钟起服务 | 0.4 | P1 | TODO |
| M5-06 | 发布前检查清单（构建、打包、回滚） | 全量 | release checklist | 可执行一次本地打包与回滚演练 | 0.4 | P1 | TODO |

### 4.7 DOING 阻塞说明

1. `M1-01`：待接入真实 NeteaseCloudMusicApi 启动命令与 cookie 持久化策略，当前仅完成通用子进程管理骨架。
2. `M1-02`：800/801/802/803 状态码已在 `auth.ts` 映射到 `hint/message/hasCookie`，路由已输出标准 `{code,hint,message,hasCookie}`；仍需真实扫码闭环（跑通 NCM 子进程并完成一次登录）验收。
3. `M1-03`：已完成（DONE）。错误码统一为 `NCM_E_*`，`NcmApiError` 分类输出（timeout/unavailable/cookie_expired/rate_limited/bad_response/unknown）；`src/shared/schema.ts` 落盘 `NcmSong/NcmSongUrl/NcmLyric/NcmPlaylistDetail` DTO 并在 `client.ts` 用 zod 校验落地；单测覆盖 QR 四分支 + 错误分类 + DTO 正向映射（共 23 用例）。
4. `M1-04`：已完成（DONE）。新增 `src/renderer/audio/engine.ts` 双 deck 引擎（A/B 切换、stop、suspend/resume、snapshot），并补充 `tests/unit/audio-engine.spec.ts` 覆盖核心状态流转（累计 26 用例通过）。
5. `M1-05`：已完成（DONE）。新增 `src/renderer/audio/crossfade.ts`，实现等能量曲线调度（`cos/sin`）与 `from` deck lowpass sweep（20kHz → 2kHz）；补充 `tests/unit/crossfade.spec.ts` 校验曲线边界、恒功率特性、参数调度与 dB/gain 转换（累计 32 用例通过）。
6. `M1-06`：已完成（DONE）。新增 `src/main/server/routes/now-next.ts`（`/api/now` + `/api/next`）与 `src/renderer/audio/prefetch.ts`（d-12/d-10/d-8 触发时序计算）；补充 `now-next/prefetch` 单测覆盖队列选取、时长估算和触发窗口（累计 43 用例通过）。

### 4.8 M1-07 前置 UI 任务与依赖（已确认）

目标：在开始 `M1-07 Player 视图` 前，先把视觉基线、组件映射和窄窗约束固化，避免返工。

1. 设计前置任务（必须完成）：
`UI-04` 组件级细化稿（按钮/卡片/输入框/队列项）
`UI-07` Design -> Component 映射清单
2. 设计前置任务（建议完成）：
`UI-05` 响应式适配稿（桌面窄窗/常规宽窗）
3. 代码前置依赖（必须完成）：
`M1-04` Web Audio 双 deck 基础能力（为 Player 控件提供真实状态）
`M1-06` `api/now` / `api/next` + prefetch 时序（为队列与下一首信息提供数据）
4. 明确依赖链：
`UI-04 -> UI-07 -> M1-07`
`UI-05 -> M1-07(窄窗布局约束)`
`M1-04 + M1-06 -> M1-07(可交互与可播数据)`
5. 开始门槛（Definition of Ready）：
组件映射表可直接落到 `views/Player` + `components/*`；
`api/now` 与 `api/next` 返回 DTO 已冻结（至少 1 个版本迭代内不破坏字段）。

---

## 5. 关键路径（建议顺序）

1. `M0-01 -> M0-04 -> M1-01 -> M1-03 -> M1-04 -> M1-05 -> M1-06`
2. `M2-01 -> M2-05 -> M3-02 -> M3-06 -> M4-01 -> M4-03 -> M4-06`
3. `M3-04 -> M3-05`（fallback 可播能力）
4. `M4-08 -> M5-04`（端到端体验验收）

---

## 6. 持续维护规则（必须执行）

1. 每次合并 PR 时，必须更新本文档对应任务的 `状态` 与 `实际完成日期`（写入 §8 变更记录）。
2. 任务进入 `DOING` 时，必须写清“阻塞依赖”；超过 1 天未推进改为 `BLOCKED` 并写原因。
3. 每周五进行一次“任务盘点”：重估剩余任务工期，更新关键路径。
4. 架构文档发生变更时（接口、模型、降级策略），24 小时内同步调整任务拆分。
5. 禁止出现“无验收标准”的任务；新增任务必须补齐验收定义。

---

## 7. 下一个执行批次（建议）

| 批次 | 任务 ID | 目标 |
|---|---|---|
| Batch-1 | M0-01 M0-02 M0-03 M0-05 | 已完成（主框架和数据库底座已落地） |
| Batch-UI-A（并行） | UI-04 UI-07 | 与 Batch-1 并行，沉淀组件设计与映射清单 |
| Batch-2 | M0-04 M0-06 M0-07 | 已完成（服务最小骨架与 user-template 已落地） |
| Batch-3 | M1-01 M1-02 M1-03 | 下一批：打通 NCM 登录与取歌基础能力 |
| Batch-4 | M1-04 M1-05 M1-06 M1-07 | 形成可听的播放主链路 |

---

## 8. 变更记录

| 日期 | 变更人 | 变更内容 |
|---|---|---|
| 2026-04-23 | justynchen / codex | 首版任务拆分文档创建，覆盖 M0-M5 与持续维护规则 |
| 2026-04-23 | justynchen / codex | 新增并行 UI 设计轨道（Image 2），并落盘首批设计资产 |
| 2026-04-23 | justynchen / codex | 完成 M0 工程骨架（M0-01~M0-07），并通过 `pnpm check` / `pnpm build` |
| 2026-04-23 | justynchen / codex | 启动 M1：新增 NCM 子进程管理、NCM 客户端与 `/api/ncm/status`（M1-01/M1-03 进入 DOING） |
| 2026-04-23 | justynchen / codex | 确认 M1-07 前置 UI 任务与依赖（新增 §4.8）；推进 M1-02 至 DOING（扫码登录接口与 cookie 持久化骨架） |
| 2026-04-23 | justynchen / codex | 新增 NCM 认证单测（cookie 写入/清理），`pnpm test` 通过 |
| 2026-04-23 | justynchen / codex | M1-02/M1-03 推进：新增 `NCM_QR_CODE`/`NCM_ERROR_CODE` 共享 schema、`NcmApiError` 错误分类与路由 HTTP 状态映射；单测扩展到 QR 四分支 + 客户端错误分类（16 用例通过） |
| 2026-04-23 | justynchen / codex | M1-03 → DONE：补齐 `NcmSong/NcmSongUrl/NcmLyric/NcmPlaylistDetail` DTO schema，`client.ts` 改为返回强类型 DTO 并做 zod 校验；单测覆盖 DTO 正向映射与 schema 拒绝畸形 payload（累计 23 用例通过） |
| 2026-04-23 | justynchen / codex | M1-04 → DONE：新增 `renderer/audio/engine.ts` 双 deck 播放引擎基础能力（A/B 切换、停止、暂停/恢复、状态快照），并新增 `audio-engine` 单测（累计 26 用例通过） |
| 2026-04-23 | justynchen / codex | M1-05 → DONE：新增 `renderer/audio/crossfade.ts`（等能量 crossfade + filter sweep）与 `crossfade` 单测，覆盖恒功率曲线与参数调度（累计 32 用例通过） |
| 2026-04-23 | justynchen / codex | M1-06 → DONE：新增 `/api/now` 与 `/api/next` 路由、prefetch 时序工具 `audio/prefetch.ts`，并补充 `now-next/prefetch` 单测（累计 43 用例通过） |
