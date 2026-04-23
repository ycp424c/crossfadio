# Crossfadio UI-04 组件级细化稿（Image 2）

- 文档日期: 2026-04-23
- 对应任务: UI-04（组件级细化稿）
- 关联设计图:
`2026-04-23-board-v1.png`
`2026-04-23-player-v1.png`
`2026-04-23-plan-timeline-v1.png`
`2026-04-23-settings-profile-v1.png`

## 1. 目标与边界

1. 为 `M1-07 Player 视图` 提供可直接编码的最小组件集。
2. 为后续 `Today Plan / Settings / Profile` 保留一致的组件样式语言。
3. 本稿聚焦组件结构、状态、尺寸策略，不替代像素级视觉稿。

## 2. 全局设计基线

### 2.1 布局与容器

| 项 | 规则 |
|---|---|
| 主体布局 | 左侧导航 + 中央主工作区 + 右侧辅助面板 |
| 主卡片圆角 | `16px`（大卡片），`12px`（次级卡片） |
| 描边 | `1px` 深色描边（低对比） |
| 背景 | 深色渐变 + 微弱发光阴影 |
| 间距节奏 | `8 / 12 / 16 / 24 / 32` |

### 2.2 色彩与状态语义

| 语义 | 色系 |
|---|---|
| 主强调（播放/活跃） | 紫蓝渐变 |
| 次强调（时间轴高亮） | 蓝/青 |
| 操作强调（播放主按钮） | 橙金 |
| 成功状态 | 绿 |
| 警告状态 | 橙 |
| 危险状态 | 红 |

### 2.3 文字层级

| 层级 | 用途 |
|---|---|
| H1 | 页面标题（如“正在播放”“今日计划”“设置”） |
| H2 | 组件区块标题（播放队列、AI 助理、安全与隐私） |
| Body | 歌曲信息、描述文案、设置说明 |
| Meta | 时长、时间戳、状态标签 |

## 3. Player 必备组件（M1-07 核心）

### 3.1 SideNav（侧边导航）

| 子项 | 状态 |
|---|---|
| 导航项（图标+文案） | default / hover / active |
| 服务状态卡 | connected / degraded / disconnected |
| 用户信息卡 | default |

### 3.2 NowPlayingHero（当前播放主信息）

| 子项 | 状态 |
|---|---|
| 封面图 | loaded / fallback |
| 曲目信息 | title / artist / tags / year |
| 操作按钮 | like / ban / more |
| 歌词摘要区 | 有词 / 无词（显示占位） |

### 3.3 SeekBar（播放进度）

| 子项 | 状态 |
|---|---|
| 进度条 | idle / hover / dragging |
| 左右时间 | 当前播放时间 / 总时长 |

### 3.4 DeckCrossfadePanel（双 Deck 混音面板）

| 子项 | 状态 |
|---|---|
| Deck A/B 卡片 | idle / active / preloaded |
| 波形条 | 静态展示 / 动态（后续接实时） |
| X-FADE 中心块 | 显示剩余秒数、交叉淡入淡出文案 |
| Crossfade 百分比 | `0% ~ 100%` |

### 3.5 TransportControls（播放控制区）

| 按钮 | 状态 |
|---|---|
| shuffle / prev / play-pause / next / loop | default / hover / active / disabled |

### 3.6 PlaybackStatusStrip（底部状态条）

| 信息项 | 说明 |
|---|---|
| 下一首倒计时 | 例如“10 秒后切入” |
| Deck 就绪 | B Deck 是否完成预载 |
| 衰减提示 | dB 数值提示 |
| Filter 提示 | LPF/HPF 扫频状态 |

### 3.7 QueuePanel（播放队列）

| 子项 | 状态 |
|---|---|
| 队列标题+计数 | default |
| 队列行项 | default / hover / active / dragging（后续） |
| 操作区 | 清空、添加 |

### 3.8 ChatAssistantPanel（AI DJ 助理）

| 子项 | 状态 |
|---|---|
| 对话气泡 | system / user |
| 快捷 action chips | default / hover / active |
| 输入框 | idle / focus / sending |
| 发送按钮 | default / disabled |

## 4. 通用基础组件（跨页面复用）

| 组件 | 用途 |
|---|---|
| `AppShellCard` | 页面主卡片容器（统一边框/背景） |
| `SectionHeader` | 区块标题 + 右侧操作 |
| `IconActionButton` | 小尺寸图标按钮 |
| `GradientPrimaryButton` | 主按钮（播放/提交） |
| `StatusBadge` | LIVE、在线、连接状态、标签 |
| `TagChip` | 情绪/风格/分类标签 |
| `InputField` | 文本输入（含 prefix/suffix） |
| `SelectField` | 下拉配置项 |
| `WaveformMini` | 小型波形展示 |

## 5. 组件优先级（实现顺序）

1. `SideNav`
2. `NowPlayingHero`
3. `SeekBar`
4. `DeckCrossfadePanel`
5. `TransportControls`
6. `PlaybackStatusStrip`
7. `QueuePanel`
8. `ChatAssistantPanel`

## 6. 验收口径（UI-04）

1. 覆盖按钮、卡片、输入框、队列项四类最小组件集。
2. 所有组件都具备至少 `default + active/disabled` 状态定义。
3. 可直接驱动 `UI-07` 设计到代码映射。
