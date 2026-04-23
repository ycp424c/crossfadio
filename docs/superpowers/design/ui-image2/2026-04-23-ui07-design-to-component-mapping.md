# Crossfadio UI-07 设计到代码映射清单（Design -> Component）

- 文档日期: 2026-04-23
- 对应任务: UI-07（设计到代码映射清单）
- 上游输入: `2026-04-23-ui04-component-breakdown.md`

## 1. 目标

1. 把设计图区域映射到明确的 React 组件职责。
2. 明确每个组件依赖的数据来源（API / store / Web Audio 状态）。
3. 作为 `M1-07` 的直接施工清单（Definition of Ready）。

## 2. Player 视图映射（M1-07）

| 设计图区域 | 设计来源 | 目标组件 | 目标文件（规划） | 关键数据依赖 | 对应接口/状态 |
|---|---|---|---|---|---|
| 三栏主框架 | `player-v1` / `board-v1` | `PlayerView` | `src/renderer/views/Player/PlayerView.tsx` | 页面布局状态 | 本地视图状态 |
| 左侧导航 | `player-v1` | `SideNav` | `src/renderer/components/layout/SideNav.tsx` | 当前路由、连接状态 | `ncm status`、后续全局 store |
| 当前播放主卡 | `player-v1` | `NowPlayingHero` | `src/renderer/components/player/NowPlayingHero.tsx` | 当前曲目、封面、元信息、歌词摘要 | `GET /api/now` |
| 进度条 | `player-v1` | `SeekBar` | `src/renderer/components/player/SeekBar.tsx` | `positionSec`、`durationSec` | Web Audio engine state |
| 双 Deck 面板 | `player-v1` | `DeckCrossfadePanel` | `src/renderer/components/player/DeckCrossfadePanel.tsx` | A/B deck、crossfade 进度、就绪状态 | `audio/engine.ts` + `audio/crossfade.ts` |
| 传输控制 | `player-v1` | `TransportControls` | `src/renderer/components/player/TransportControls.tsx` | 播放状态、可用动作 | 本地控制 action（后续 `/api/control`） |
| 播放状态条 | `player-v1` | `PlaybackStatusStrip` | `src/renderer/components/player/PlaybackStatusStrip.tsx` | 下一首倒计时、预取状态、dB/filter 文案 | `audio/prefetch.ts` + mixer state |
| 右侧播放队列 | `player-v1` | `QueuePanel` | `src/renderer/components/player/QueuePanel.tsx` | 队列数组、当前项索引 | `GET /api/next` + queue store |
| AI 助理面板 | `player-v1` / `board-v1` | `ChatAssistantPanel` | `src/renderer/components/player/ChatAssistantPanel.tsx` | chat messages、quick actions、输入态 | WS（后续 chat/queue-updated） |

## 3. Plan / Settings 预映射（非 M1-07 主路径）

| 页面 | 设计区域 | 目标组件 | 目标文件（规划） |
|---|---|---|---|
| Today Plan | 时段卡片组 | `PlanSegmentGrid` | `src/renderer/components/plan/PlanSegmentGrid.tsx` |
| Today Plan | 全局时间线 | `PlanTimelineReadonly` | `src/renderer/components/plan/PlanTimelineReadonly.tsx` |
| Today Plan | 右侧摘要面板 | `PlanInsightPanel` | `src/renderer/components/plan/PlanInsightPanel.tsx` |
| Settings | 服务配置表单 | `ServiceConfigForm` | `src/renderer/components/settings/ServiceConfigForm.tsx` |
| Settings | TTS 试听 | `TtsPreviewCard` | `src/renderer/components/settings/TtsPreviewCard.tsx` |
| Settings | 口味画像编辑器 | `TasteCorpusEditor` | `src/renderer/components/settings/TasteCorpusEditor.tsx` |

## 4. 组件分层约束

1. `views/*` 只做页面布局与组合，不直接写网络请求。
2. `components/*` 只接收 props 和回调，不依赖全局单例。
3. 数据拉取统一走 `renderer/api.ts`（后续补齐 now/next/control/chat 封装）。
4. Web Audio 相关状态由 `renderer/audio/*` 输出只读快照，组件层不直接持有 AudioNode。

## 5. M1-07 开始门槛检查（DoR）

1. `UI-04` 组件细化稿已具备组件清单和状态定义。
2. 本映射表已覆盖 Player 每个视觉区域并给出目标文件路径。
3. `M1-04` / `M1-06` 已完成，可提供可播数据和时序能力。
4. `UI-05` 仍建议先做，但不阻塞 `M1-07` 主线实现。
