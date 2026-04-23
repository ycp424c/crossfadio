# Crossfadio 产品与技术架构设计

> 你的本地 AI DJ 桌面应用 —— 读你自己的歌单,像电台 DJ 一样为你串起今天的声音。

- **文档日期**:2026-04-23
- **状态**:设计稿(MVP 前)
- **决策人**:justynchen
- **适用范围**:MVP(含 V1.1 标注)
- **实施任务拆分**:`docs/superpowers/specs/2026-04-23-crossfadio-mvp-task-breakdown.md`
- **UI 设计资产(Image 2)**:`docs/superpowers/design/ui-image2/README.md`

---

## §1 产品定位与用户故事

### 1.1 一句话定位

**Crossfadio = 本地 AI DJ 桌面应用。** 它读你自己的网易云歌单和 `user/*.md` 里的品味语料,按时段生成"今日电台计划",像电台 DJ 一样介绍歌曲、把歌平滑串起来;边听边聊即可动态调整。全程本地运行,LLM / TTS / 网易云 cookie 只留在你自己的电脑上。

### 1.2 四条黄金用户故事

1. **早上 9 点打开 app**:看到今日 4 时段计划,点"通勤"立刻开播;第一段开头 DJ 会说"早上好,外面 23°C 多云,给你挑了 3 首清新的醒脑曲,先来 The Beatles 的 Here Comes The Sun"。
2. **专注工作时**:歌 A 淡出最后 8 秒,DJ 低声说一句"这首 Bon Iver 的 Holocene,像雪落下来的声音,让它把接下来 45 分钟铺满",歌 B 淡入。全程零点击。
3. **深夜写代码**:在聊天框说"想要再安静一点,没有人声的那种",DJ 回"好,把下一首换成 Nils Frahm 的钢琴",UI 立刻显示队列变了,下一首 crossfade 前顺势换。
4. **临时场景切换**:聊天里说"我接下来要去跑步 30 分钟,想听 Rap",DJ 回"已为你排了 8 首 Kendrick / J. Cole / Eminem 的快节奏作品,BPM 90–110",UI 立刻刷新队列覆盖当前时段,第一首 3 秒内起播。

### 1.3 产品边界

- **个人用 / 本地优先 / 单机 Electron app**
- 不做:多用户、云同步、社交分享、商业化订阅
- 核心价值不在"播放器"本身,而在"像电台 DJ 一样懂你 + 把歌串起来"

---

## §2 MVP 范围与分期

### 2.1 MVP 必做(对应图1 的 01–05 全部模块)

- **01 正在播放**:当前曲目、进度、封面、接下来队列、快速操作
- **02 今日电台计划**:4 时段(早/午/傍晚/深夜)规划展示 + 一键切段
- **03 和 AI DJ 聊天**:自然语言对话 + 快捷指令
- **04 动态编排 Timeline**:crossfade 波形/时间轴 **只读可视化**(手动拖编辑留 V1.1)
- **05 口味画像 / 设置**:`user/*.md` 编辑器 + LLM/TTS endpoint + 声音预览
- **Crossfade 引擎**:等能量交叉 + Filter Sweep
- **TTS 串场**:底铺式插入(DJ 口播叠在下一首前奏上)
- **网易云**:扫码登录 + 歌单读取 + 直链播放 + 歌词
- **持久化**:SQLite (`state.db`) + `user/*.md` 语料
- **Agent**:单 Agent 双 Mode(plan / segue / chat)
- **天气注入**:wttr.in 或 openweather

### 2.2 V1.1 推迟

- Timeline 拖拽可编辑
- 日历 hook(今日有会议 → 会议段切静默 / instrumental-only)

### 2.3 明确不做

- UPnP / Naim 等客厅功放推流
- lark / feishu / IM 集成
- 多用户 / 云同步 / 社交

---

## §3 技术栈

| 维度 | 选型 | 备注 |
|------|------|------|
| 语言 | **TypeScript**(全栈) | 主/preload/renderer 共享 zod schema |
| 桌面框架 | **Electron** + **electron-vite** | HMR 完善 |
| UI | **React + Tailwind + shadcn/ui** | 贴合图1 深色质感 |
| 本地状态 | **zustand**(renderer) | |
| Agent 抽象 | **自研**,compute(fragments) | LLM 用 OpenAI 兼容协议 |
| LLM 客户端 | **OpenAI-compatible**(用户填 base_url + api_key + model) | 覆盖 OpenAI/DeepSeek/Moonshot/OpenRouter/Ollama 等 |
| TTS 客户端 | **OpenAI `audio/speech` 兼容** | 同样填 endpoint+key+voice |
| 音乐源 | **网易云** via 内嵌 NeteaseCloudMusicApi 子进程 | 扫码登录 |
| 播放引擎 | **Web Audio API**(AudioContext + GainNode + BiquadFilterNode) | renderer 侧 |
| 本地 Server | **Electron 主进程内嵌 HTTP + WS**(127.0.0.1,随机端口) | 保留与图2 一致的 BFF 边界 |
| 状态存储 | **better-sqlite3** | `messages`/`plays`/`plan`/`prefs`/`tts_cache` |
| 凭证存储 | Electron **`safeStorage`** | 走系统 keychain |
| 用户语料 | **`user/*.md` + `playlists.json`** | 人类可读、可 git |
| 定时 | **node-cron** | |
| 日志 | **pino** | 结构化 JSON → `userData/logs/` |
| 测试 | **Vitest** 单元/集成 + **Playwright-for-Electron** e2e | |

---

## §4 系统架构总览

严格对齐图2 的四层,BRAIN 从 "Claude Code 子进程" 替换为 **自研 Agent 模块**(内置 OpenAI 兼容 LLM 客户端,用户可在设置里配置 endpoint)。

```
┌───────────────────────────────────────────────────────────────┐
│  L1  外部上下文                                                │
│  ├─ user/*.md         taste / routines / mood-rules /         │
│  │                    dj-persona / playlists.json             │
│  ├─ LLM endpoint      OpenAI 兼容(用户配)                     │
│  ├─ TTS endpoint      OpenAI audio/speech 兼容(用户配)        │
│  ├─ NCM API           内嵌子进程 127.0.0.1:xxxxx              │
│  └─ Weather           wttr.in / openweather                   │
└───────────────────────────────────────────────────────────────┘
                              ↓
┌───────────────────────────────────────────────────────────────┐
│  L2  本地大脑 (Electron 主进程 / Node)                         │
│  ├─ router         意图分流(快捷指令直连 / 聊天走 agent)      │
│  ├─ context        prompt 组装(6 片 fragments)               │
│  ├─ agent          compute(fragments) → {say,play[],actions}  │
│  ├─ scheduler      07:00 日规划 / 小时情绪检查 / 时段进入      │
│  ├─ tts            OpenAI 兼容 → cache/tts/<hash>.mp3         │
│  ├─ ncm            spawn + 登录/歌单/直链/歌词/搜索             │
│  ├─ llm            OpenAI 兼容 client(流式/非流式)             │
│  ├─ store          better-sqlite3                              │
│  ├─ security       safeStorage 封装                            │
│  └─ http+ws server 127.0.0.1 随机端口                          │
└───────────────────────────────────────────────────────────────┘
                              ↓  localhost HTTP + WS
┌───────────────────────────────────────────────────────────────┐
│  L3  运行时聚合(每次触发按 6 片粘成 prompt)                   │
│   ① system      dj-persona.md + mode 专属约束                  │
│   ② corpus      taste / routines / mood-rules / playlists     │
│   ③ env         time / weather / now-playing                  │
│   ④ memory      recent plays(50) + recent chat(20)           │
│   ⑤ input       user chat / segue trigger / plan request      │
│   ⑥ trace       triggeredBy + lastDecision                    │
│        ─── MODEL ───                                           │
│        compute(fragments) → {mode, say, play[], actions?,...} │
└───────────────────────────────────────────────────────────────┘
                              ↓
┌───────────────────────────────────────────────────────────────┐
│  L4  交互表层 (Electron Renderer / React + Tailwind)           │
│  ├─ 三视图:Player / Profile / Settings                        │
│  ├─ Web Audio 引擎(双 deck + TTS 通道 + GainNode + Biquad)   │
│  ├─ WS 流式聊天 + 推送                                          │
│  └─ 10s prefetch 下一首直链                                    │
└───────────────────────────────────────────────────────────────┘
```

### 4.1 关键数据流

- **启动 → 起播**:renderer `GET /api/plan/today` → main scheduler(若无今日计划,触发 plan mode)→ 返回计划 → renderer 取首段首曲 → `GET /api/now` 拿直链 → Web Audio 起播
- **换歌 crossfade**:renderer 在 `d-12s` 触发 `POST /api/segue/trigger`(体验优先,尽量保证有口播)→ main 调 segue mode + tts → WS 推 `segue.tts-ready` → 到达 crossfade 起点执行 §9.3 的底铺式插入
- **聊天**:renderer WS 送 `{type:"chat",text}` → router → agent(chat mode)→ 流式回 `{delta.say, done{say,actions}}` → renderer 展示 + 执行 actions → WS 推 `queue-updated`

---

## §5 目录结构与代码组织

### 5.1 仓库布局

```
crossfadio/
├─ package.json
├─ electron.vite.config.ts
├─ tsconfig.{node,web}.json
├─ docs/superpowers/specs/          规划文档
├─ resources/                       图标 / tray
├─ user-template/                   首次启动时拷到 userData/user/
│  ├─ taste.md  routines.md  mood-rules.md
│  ├─ playlists.json  dj-persona.md
├─ src/
│  ├─ main/                         本地大脑 (Node)
│  │  ├─ index.ts                  app 启动、窗口管理、spawn ncm
│  │  ├─ server/                   localhost HTTP + WS
│  │  │  ├─ routes/{chat,now,next,plan,taste,ncm,tts,control,prefs}.ts
│  │  │  └─ ws.ts
│  │  ├─ agent/
│  │  │  ├─ compute.ts             compute(fragments) 入口
│  │  │  ├─ fragments.ts           6 片组装
│  │  │  ├─ modes.ts               plan / segue / chat 三 mode
│  │  │  └─ tools.ts               Action 工具定义
│  │  ├─ router.ts                 意图分流
│  │  ├─ context.ts                环境注入
│  │  ├─ scheduler.ts              cron + hook
│  │  ├─ llm/{client,stream}.ts
│  │  ├─ tts/{client,cache}.ts
│  │  ├─ ncm/{spawn,client}.ts
│  │  ├─ weather.ts
│  │  ├─ store/                    better-sqlite3
│  │  │  ├─ db.ts  migrations.ts
│  │  │  └─ {messages,plays,plan,prefs,ttsCache}.ts
│  │  ├─ user-corpus/{paths,loader,writer}.ts
│  │  ├─ security.ts               safeStorage 封装
│  │  └─ logger.ts                 pino
│  ├─ preload/index.ts             暴露 WS url + app 基础信息
│  ├─ renderer/
│  │  ├─ App.tsx                   三视图路由
│  │  ├─ views/{Player,Profile,Settings}/
│  │  ├─ components/{PlayerBar,TodayPlan,ChatPanel,Timeline,...}.tsx
│  │  ├─ audio/
│  │  │  ├─ engine.ts              AudioContext + 双 deck + TTS
│  │  │  ├─ crossfade.ts           等能量曲线 + filter sweep
│  │  │  ├─ ducking.ts             底铺式 TTS 插入
│  │  │  └─ prefetch.ts            10s 预取
│  │  ├─ ws/client.ts
│  │  ├─ api.ts
│  │  └─ store/                    zustand
│  └─ shared/
│     ├─ schema.ts                 zod(compute I/O、WS 事件、HTTP DTO)
│     └─ types.ts
└─ tests/{unit,e2e}/
```

### 5.2 运行时 userData 布局

```
${app.getPath('userData')}/
├─ user/                     用户可手编的语料(MVP 也提供 UI 编辑器)
│  ├─ taste.md  routines.md  mood-rules.md
│  ├─ playlists.json         [{id,name,provider,segments,tags,energyRange,priority}]
│  └─ dj-persona.md          DJ 人格 system prompt
├─ state.db                  better-sqlite3
├─ cache/tts/<sha>.mp3       tts 音频缓存
├─ secrets.bin               safeStorage 加密(LLM key, TTS key, ncm cookie)
└─ logs/app-YYYY-MM-DD.log
```

---

## §6 Agent 核心设计

### 6.1 接口签名

```ts
// src/main/agent/compute.ts
export function compute(
  fragments: Fragments,
  opts?: { stream?: boolean; signal?: AbortSignal }
): AsyncIterable<AgentEvent> | Promise<AgentOutput>;
```

- 非流式(plan mode):返回 `AgentOutput`
- 流式(segue / chat mode):yield `AgentEvent`(`delta.say` / `delta.action` / `done`)

### 6.2 Fragments 输入 6 片

```ts
const Fragments = z.object({
  mode: z.enum(["plan", "segue", "chat"]),

  // ① system prompt(dj-persona.md 全文 + mode 专属追加)
  system: z.string(),

  // ② 用户语料
  corpus: z.object({
    taste: z.string(),
    routines: z.string(),
    moodRules: z.string(),
    playlists: PlaylistRef.array()
  }),

  // ③ 环境注入
  env: z.object({
    nowIso: z.string(),
    localTime: z.string(),           // "周二 21:30"
    weather: z.object({ tempC: z.number(), desc: z.string() }).nullable(),
    nowPlaying: NowPlaying.nullable()
  }),

  // ④ 已检索记忆
  memory: z.object({
    recentPlays: PlayRecord.array(), // 最近 50 首
    recentChat: Message.array()      // 最近 20 条
  }),

  // ⑤ 用户输入 / 工具结果
  input: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("chat"), text: z.string() }),
    z.object({ kind: z.literal("segueTrigger"), from: Track, to: Track }),
    z.object({ kind: z.literal("planRequest"), date: z.string() }),
    z.object({ kind: z.literal("toolResult"), tool: z.string(), data: z.unknown() })
  ]),

  // ⑥ 轨迹
  trace: z.object({
    triggeredBy: z.enum(["scheduler", "user", "segue-hook"]),
    lastDecision: z.unknown().nullable()
  })
});
```

### 6.3 三 Mode × 输出 Schema

**plan mode** — 今日电台计划(非流式)

```ts
const PlanOutput = z.object({
  mode: z.literal("plan"),
  date: z.string(),
  segments: z.array(z.object({
    id: z.enum(["morning","work","evening","late-night"]),
    label: z.string(),
    timeRange: z.string(),
    mood: z.string(),
    energyPct: z.number().min(0).max(100),
    tracks: z.array(z.object({
      query: z.string(),    // "Here Comes The Sun — The Beatles"
      reason: z.string()
    }))
  })),
  narrative: z.string()
});
```

**segue mode** — 两首歌之间的 DJ 串场(流式)

```ts
const SegueOutput = z.object({
  mode: z.literal("segue"),
  say: z.string(),                // ≤100 字
  duckingHintSec: z.number(),     // 建议底铺秒数(默认 8)
  filterSweep: z.boolean(),
  emotionTag: z.string()
});
```

**chat mode** — 用户聊天(流式 `say` + 末尾 `actions`)

```ts
const ChatOutput = z.object({
  mode: z.literal("chat"),
  intent: z.enum(["chitchat","adjust_queue","replan","control","ask_meta"]),
  say: z.string(),
  actions: z.array(Action).default([])
});
```

**意图识别**在 chat mode 内置:agent 每条回复都先判是闲聊还是要调整,没必要改歌单时 `actions=[]`。

### 6.4 Actions — 可执行工具

```ts
const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("swap_next"), pick: TrackQuery }),
  z.object({ type: z.literal("add_to_queue"), pick: TrackQuery,
             position: z.enum(["end","after_current"]) }),
  z.object({ type: z.literal("skip") }),
  z.object({ type: z.literal("ban_artist"), artist: z.string() }),
  z.object({ type: z.literal("ban_track"), title: z.string(), artist: z.string() }),
  z.object({ type: z.literal("adjust_mood"), mood: z.string(),
             applyTo: z.enum(["remaining_segment","next_n"]), n: z.number().optional() }),
  z.object({ type: z.literal("replan_segment"), hint: z.object({
    mood: z.string().optional(),
    genre: z.string().optional(),
    bpmMin: z.number().optional(), bpmMax: z.number().optional(),
    durationMin: z.number(),
    count: z.number().optional()
  })}),
  z.object({ type: z.literal("set_pref"), key: z.string(), value: z.unknown() })
]);
```

执行路径:agent 输出 actions → `router.executeActions()` → 各 action 调 ncm/store/scheduler → WS 推 `queue-updated`。

### 6.5 Prompt 组装策略

`fragments.ts` 按固定顺序拼 messages:

1. `system` → `system` 消息(dj-persona.md + mode 约束)
2. `corpus + env` → 第一条 user 消息,XML 包裹 `<corpus>...</corpus><env>...</env>`
3. `memory` → 第二条 user 消息,`<recent_plays>...` `<recent_chat>...`
4. `input` → 最后一条 user 消息(自然语言或工具结果 JSON)
5. `trace` 附在 input 下

每个 mode 在 `system` 尾部追加 mode-specific 约束与 JSON 输出契约,例如 segue mode 要求"100 字内口播,严格返回 `{say, duckingHintSec, filterSweep, emotionTag}` JSON"。

### 6.6 Schema 校验与兜底

所有 LLM 输出过 zod。失败时:

- **plan / chat**:重试 1 次,prompt 追加"上次输出不合法:<err>"
- **segue**:连续失败 2 次 → 跳过串场,降级为纯 crossfade(不阻塞播放)

### 6.7 为什么单 Agent 不会"分裂"

三 mode 共享 `fragments.ts` 组装、`context.ts` 环境注入、`compute()` 入口、`AgentOutput` 联合类型。差异只在 `modes.ts` 里的 3 张 prompt 模板 + 3 个 schema,改一 mode 不影响其他。

---

## §7 数据模型

### 7.1 `user/*.md` — 冷数据 / 人格语料

**`dj-persona.md`** — DJ 人格

```markdown
你是一位深夜电台 DJ。说话温和、不过度煽情,像老朋友。
推荐歌曲时要讲"为什么是现在、这一首",而不是念百科。
每句串场控制在两三句话,不抢歌的风头。
```

**`taste.md`** — 品味画像

```markdown
## 流派偏好
Indie Pop / Dream Pop / Post-Rock / Ambient / 冷门 Rap

## 年代
1990s / 2000s / 2010s

## 语言
中文 / 英文 / 日文

## 能量偏好
30% – 60%

## BPM 偏好
60 – 100

## 黑名单
- artist: "XXX"
- track: "YYY"
```

**`routines.md`** — 作息

```markdown
## 早晨
06:00 – 09:00 | 清新 · 唤醒

## 工作
09:00 – 17:30 | 专注 · 流畅

## 傍晚
17:30 – 21:00 | 放松 · 治愈

## 深夜
21:00 – 02:00 | 沉浸 · 深潜

## 睡眠规则
23:00 后降低低音,无刺耳频段

## 能量曲线
早温和 → 午中等 → 晚低
```

**`mood-rules.md`** — 特殊规则

```markdown
- 周一早上只放 instrumental
- 下雨天优先 ambient / post-rock
- "跑步"意图:BPM 90-120,Rap/Electronic,避免慢歌
- "写代码":优先 instrumental / lo-fi,避免中文人声
```

**`playlists.json`**

```json
[
  {
    "id": "24381616",
    "name": "深夜低频",
    "provider": "ncm",
    "segments": ["late-night", "evening"],
    "tags": ["ambient", "sleep", "instrumental"],
    "energyRange": [20, 45],
    "priority": 2
  },
  {
    "id": "2829883790",
    "name": "工作专注",
    "provider": "ncm",
    "segments": ["work"],
    "tags": ["focus", "instrumental", "lofi"],
    "energyRange": [35, 60],
    "priority": 1
  }
]
```

字段约定:

- `segments`:该歌单适配的时段 id(`morning/work/evening/late-night`),用于 plan fallback 和 `gap-fill`。
- `tags`:语义标签,用于按 `mood` / 用户 chat 意图做相似匹配。
- `energyRange`:`[min,max]` 能量区间,用于兜底时与当前段能量目标做打分。
- `priority`:同分时的稳定排序(数字越小优先级越高)。

### 7.2 `state.db` 表结构

```sql
-- 会话消息(聊天 + 串场)
CREATE TABLE messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  role      TEXT    NOT NULL,            -- 'user' | 'dj' | 'system'
  mode      TEXT,                         -- 'chat' | 'segue' | 'plan'
  content   TEXT    NOT NULL,
  meta_json TEXT                          -- intent / emotionTag / actions
);
CREATE INDEX idx_messages_ts ON messages(ts);

-- 播放历史
CREATE TABLE plays (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_start    INTEGER NOT NULL,
  ts_end      INTEGER,
  ncm_id      TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  artist      TEXT    NOT NULL,
  duration_ms INTEGER,
  played_ms   INTEGER,
  skipped     INTEGER DEFAULT 0,
  reason      TEXT,
  liked       INTEGER DEFAULT 0,
  mood        TEXT,
  segment_id  TEXT
);
CREATE INDEX idx_plays_ts ON plays(ts_start);

-- 今日计划快照(覆盖式,每日一条)
CREATE TABLE plan (
  date       TEXT PRIMARY KEY,
  plan_json  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  version    INTEGER NOT NULL
);

-- 偏好 / 运行时配置(不含敏感凭证)
CREATE TABLE prefs (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 种子 key:
-- llm.endpoint  llm.model
-- tts.endpoint  tts.voice  tts.speed
-- ui.theme  player.crossfadeSec  player.duckingDb  player.ttsStartOffset
-- player.enableFilterSweep  scheduler.autoPlanning
-- weather.provider  weather.city

-- TTS 缓存索引
CREATE TABLE tts_cache (
  hash       TEXT PRIMARY KEY,       -- sha256(endpoint+model+voice+speed+format+text)
  text       TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  model      TEXT NOT NULL,
  voice      TEXT NOT NULL,
  speed      REAL NOT NULL,
  format     TEXT NOT NULL DEFAULT 'mp3',
  bytes_len  INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

### 7.3 `secrets.bin` — safeStorage 加密

反序列化后:

```ts
{
  llmApiKey: string,
  ttsApiKey: string,
  ncmCookie: string,
  ncmLoginAt: number
}
```

所有读写走 `main/security.ts` 封装,renderer 永远不接触原文。设置页展示为 `sk-...xxxx` 脱敏摘要。

### 7.4 歌曲解析缓存(内存,非持久化)

`TrackQuery` → NCM `songId` + 直链 + 歌词。内存 LRU(500 项 / TTL 10 分钟)。直链到期前 60s 自动刷新。

---

## §8 HTTP + WS API 契约

### 8.1 总原则

- 本地 HTTP server 监听 `127.0.0.1` 随机端口
- HTTP 请求必须带 `X-Session` header;WS 连接必须带 `?session=<sessionToken>`
- **请求-响应**走 HTTP;**流式 / 推送**走单条 WS(`/stream`)
- 所有 body 用 JSON;错误统一 `{ error: { code, message } }`

### 8.2 HTTP 端点

| Method | Path | 用途 | Req | Resp |
|---|---|---|---|---|
| GET | `/api/health` | 健康 | — | `{ok, version, port}` |
| GET | `/api/prefs` | 读偏好 | — | `{ [key]: value }` |
| PUT | `/api/prefs` | 写偏好 | `{key,value}` | `{ok}` |
| GET | `/api/taste` | 读所有语料文件 | — | `{taste,routines,moodRules,djPersona,playlists}` |
| PUT | `/api/taste/:file` | 写单个语料文件 | `{content}` | `{ok}` |
| POST | `/api/ncm/login/qr` | 申请扫码 | — | `{qrKey, qrImg(dataURL)}` |
| GET | `/api/ncm/login/status` | 轮询扫码状态 | `?key=` | `{code: 801\|802\|803\|800, cookie?, profile?}` |
| POST | `/api/ncm/logout` | 登出 | — | `{ok}` |
| GET | `/api/plan/today` | 今日计划 | — | `PlanOutput` |
| POST | `/api/plan/regenerate` | 重新规划全天 | — | `PlanOutput` |
| POST | `/api/plan/replan-segment` | 替换单时段 | `{segmentId, hint}` | `PlanOutput` |
| POST | `/api/plan/gap-fill` | 现场补位 | `{segmentId, count, durationMin, mood}` | `{tracks[]}` |
| GET | `/api/now` | 取当前曲直链 | `?ncmId=` | `{url, durationMs, lyric}` |
| GET | `/api/next` | 取下一首(配合 prefetch) | — | `{track, url, durationMs}` |
| POST | `/api/segue/trigger` | 触发 DJ 串场生成 | `{from, to}` | `{requestId}`(异步经 WS 回) |
| POST | `/api/tts/preview` | 设置页试听 | `{text, voice, speed}` | `audio/mpeg` |
| POST | `/api/control` | 播放控制 | `{action: "play"\|"pause"\|"skip"\|"prev"\|"like"\|"unlike"}` | `{ok}` |

### 8.3 WebSocket `/stream` 事件

连接格式:

`ws://127.0.0.1:{port}/stream?session=<sessionToken>`

鉴权失败时服务端立即关闭连接(`4401 Unauthorized`)。

**Client → Server**

```ts
{ type: "chat", text: string }
{ type: "ping" }
```

**Server → Client**

```ts
{ type: "chat.delta",    chunk: string, requestId: string }
{ type: "chat.done",     say: string, intent: ChatIntent, actions: Action[], requestId: string }
{ type: "segue.tts-ready", hash: string, url: string, requestId: string }
{ type: "segue.say-delta", chunk: string, requestId: string }
{ type: "now-playing",    track: Track, positionMs: number }
{ type: "queue-updated",  queue: Track[] }
{ type: "plan-updated",   plan: PlanOutput, version: number }
{ type: "toast",          level: "info"\|"warn"\|"error", message: string }
{ type: "ncm.cookie-expired" }
```

### 8.4 失败时的降级

- `/api/segue/trigger` 超时 3s → 保留本次换歌,按 §9.4 的"晚到插入/模板口播/纯 crossfade"三级降级处理
- `/api/plan/today` LLM 失败 → 返回降级计划(来自 `playlists.json` 的 `segments/tags/energyRange` 打分),header `X-Plan-Source: fallback`

---

## §9 播放引擎(renderer)

### 9.1 AudioContext 信号图

```
<audio#deckA>  → MES → GainA → BiquadA ─┐
<audio#deckB>  → MES → GainB → BiquadB ─┼→ MasterGain → destination
<audio#tts>    → MES → GainT           ─┘
```

- `deckA/deckB` 轮替(当前播 A,预取 B,切换后 A 空闲接下一首)
- `Biquad` 默认 lowpass 20kHz(透传);filter sweep 时扫到 2kHz
- `GainT` 默认 0,底铺时抬起到 1.0

### 9.2 Crossfade 曲线(等能量)

```ts
// A→B,起始时刻 t0,时长 D(默认 8s)
const steps = 64;
const out = new Float32Array(steps);
const ins = new Float32Array(steps);
for (let i = 0; i < steps; i++) {
  const x = i / (steps - 1);
  out[i] = Math.cos(x * Math.PI / 2);
  ins[i] = Math.sin(x * Math.PI / 2);
}
gainA.gain.setValueCurveAtTime(out, t0, D);
gainB.gain.setValueCurveAtTime(ins, t0, D);
biquadA.frequency.setValueAtTime(20000, t0);
biquadA.frequency.linearRampToValueAtTime(2000, t0 + D);
```

### 9.3 底铺式 TTS 插入

```
时间轴(crossfade 起点 t0=0,D=8s,TTS 时长 T≈5s):

A:  ━━━━━━┓
          ╲ fade out (0..D)
B:         ╱━━━━━━━━━━━━━━━━━━━━━━
          ╱ fade in
          └─ duck -8dB (t=1) ─┐
                              │ TTS 播放 (t=1..1+T)
                              └─ ramp 0dB (t=1+T)
TTS:     t=1 ▶ cache/tts/<hash>.mp3 ▶ t=1+T
```

```ts
async function performSegue(t0, ttsBuf, startOffset = 1.0, D = 8) {
  startCrossfade(t0, D);
  const tDuck = t0 + startOffset;
  gainB.gain.linearRampToValueAtTime(dbToGain(-8), tDuck + 0.2);
  ttsAudio.play();
  gainT.gain.setValueAtTime(1.0, tDuck);
  const tBack = tDuck + ttsBuf.duration + 0.2;
  gainB.gain.linearRampToValueAtTime(1.0, tBack + 0.4);
  gainT.gain.linearRampToValueAtTime(0.0, tBack);
}
```

### 9.4 Prefetch 与 segue 时序

```
progress=d-12s      renderer 触发 `/api/segue/trigger`(体验优先:提前拿口播)
progress=d-10s      renderer 预取下一首直链 → deck.load()
progress=d-9s       目标:收到 `segue.tts-ready`,deck#tts.src = url
progress=d-D(=d-8)  crossfade 开始
progress=d-7s       gainB duck 到 -8dB,TTS 起声(标准路径)
progress=d-(7-T)    TTS 结束,gainB 回 0dB
progress=d          A 静音,B 全量
```

晚到口播策略(体验优先):

- 若 `d-7s` 未就绪但 `d-5s` 前就绪:立即进入"晚到插入",缩短 ducking(最多 3s),仍保留一句口播。
- 若 `d-5s` 仍未就绪:优先使用本地模板口播缓存(`cache/tts/fallback/<voice>/<templateHash>.mp3`)。
- 模板口播也不可用时,才降级为纯 crossfade。

### 9.5 控制指令

- **skip**:0.8s 短 crossfade 到 B;B 未就绪则硬切
- **prev**:回放上一首,跳过串场
- **pause / play**:`AudioContext.suspend()/resume()`,crossfade 时刻用 `ctx.currentTime` 相对计算

### 9.6 用户可调(settings)

- `crossfadeSec`(默认 8,范围 2–16)
- `duckingDb`(默认 -8,范围 -14~-4)
- `ttsStartOffset`(默认 1.0,范围 0.2–2.0)
- `enableFilterSweep`(默认 true)

---

## §10 规划引擎(scheduler)

### 10.1 触发源

| 触发 | 时机 | 效果 |
|------|------|------|
| 日规划 cron | 每日 07:00 | 调 agent plan mode,写入 `plan` 表 |
| 首启 / 无当日计划 | `GET /api/plan/today` 命中空 | 同步触发日规划 |
| 时段进入 | 到达 routines.md 里某段起始 | 不调 LLM,UI 高亮切换 |
| 小时情绪检查 | 每小时 0 分 | 若 skip 率 > 40% 或 chat 负面情绪词 → `replan-segment` 改剩余未播 |
| 用户手动 | `POST /api/plan/regenerate` 或 `replan-segment` | 跑步等场景走这条 |
| 日历 hook | **V1.1** | 会议段切静默 / instrumental-only |

### 10.2 规划时的 context 注入

- `env.weather`(当时快照)
- `env.localTime`(含星期几)
- `corpus.routines / taste / moodRules` 原样
- `memory.recentPlays` = 过去 7 天最常播 + 最近 50 首去重

### 10.3 query → ncmId 兑现

agent 出的是 `TrackQuery = "title — artist"` 字符串,落地时:

```
for each track in plan.segments[*].tracks:
  hit = cache.lookup(query)
  if !hit:
    res = ncm.search(query, { type:"song", limit:3 })
    hit = pickBestMatch(res, query)   // 标题/作者相似度 + 时长过滤
  track.ncmId = hit?.id ?? null
```

**ncmId=null 时的补位**:播放前若 null,renderer `/api/plan/gap-fill`,agent 即时补 1 首。

### 10.4 replan-segment 最小扰动

- 已播曲保留历史不动
- 正在播的曲不打断
- 只替换"剩余未播"
- `plan.version += 1`;WS 推 `plan-updated`

### 10.5 降级

- LLM 超时/失败:从 `playlists.json` 按 `segments + tags + energyRange + priority` 打分选歌单取前 N 首,UI 角标"本地兜底计划"
- NCM 离线:用上一次成功的 plan(`plan` 表 date 倒序找第一条能全部兑现的)

### 10.6 `scheduler.autoPlanning` 开关

对应图1"自动规划"开关。关闭后只保留手动触发。

---

## §11 安全 & 隐私

### 11.1 凭证存储

- LLM Key / TTS Key / NCM cookie → `safeStorage.encryptString` → `userData/secrets.bin`
- 系统 keychain 不可用时退化到基于 `os.userInfo().username + machineId` 派生的 AES-256,设置页红字提示"凭证强度降级"
- Renderer 只拿脱敏摘要 `{configured, preview:"sk-...xxxx"}`

### 11.2 请求代理层

- `main/llm/client.ts` / `main/tts/client.ts` 是唯一出口
- 出站白名单:用户配的 LLM base_url / TTS base_url / NCM localhost / 天气 provider

### 11.3 本地 HTTP 防护

- 监听 `127.0.0.1` 随机端口
- 每次启动生成 `sessionToken` 写 renderer `sessionStorage`;HTTP 走 `X-Session`,WS 走 `?session=`
- `sessionToken` 仅本次 app 生命周期有效,进程退出即失效

### 11.4 隐私承诺(UI + README 明示)

- 默认不上报任何数据给除用户配置的 LLM/TTS/NCM 外的服务
- 不做匿名 crash report(MVP)
- 播放历史、聊天消息**永不离开本机**
- 设置页提供"一键删除所有数据"(清 `userData/` 下 `state.db` / `cache/` / `secrets.bin` / `user/`)

### 11.5 网易云登录

- **仅**支持扫码登录(防风控 + 降复杂度)
- cookie 过期检测:`/api/now` 命中 `code:301` 即 WS 推 `ncm.cookie-expired`,引导重新登录

---

## §12 错误处理策略

| 失败域 | 默认行为 | 用户可见 |
|---|---|---|
| LLM 超时 / schema 非法 | segue → 模板口播优先,失败再纯 crossfade;plan → 本地兜底;chat → "(DJ 走神了)" | toast.warn |
| TTS 失败 | segue → 晚到插入/模板口播优先,失败再纯 crossfade;preview 报错 | toast.warn |
| NCM 直链 404 | 跳过本曲,`plays.skipped=1,reason="url_404"` | 播放器淡显 |
| NCM 子进程崩溃 | 主进程 3s 重启,60s 内重试 3 次 | toast.err |
| 网络断开 | 缓存 tts + 已预取曲继续播完,之后离线模式 | 顶栏离线角标 |
| cookie 过期 | 引导扫码重登 | toast.warn + 模态 |
| safeStorage 解密失败 | 按凭证损坏处理,要求重填 | 设置页红字 |
| user/*.md 解析失败 | 标红该文件,不进 agent,其他语料正常 | 设置页行内提示 |
| 磁盘满 / tts cache 写失败 | 自动清最早 50% 缓存后重试 | 日志 info |

**全局兜底**:renderer 崩溃不影响主进程(Electron 自动重开窗口);主进程崩溃写 crash log 并退出(不自动重启避免崩溃循环)。

---

## §13 测试策略

### 13.1 测试金字塔

```
        ▲  Playwright-for-Electron(e2e,少量)
       ▲▲  → 登录→起播→换歌→crossfade→聊天调整→跑步 replan
      ▲▲▲  Vitest + jsdom(集成,中量)
     ▲▲▲▲  → HTTP 路由契约 / WS 事件时序 / compute × FakeLLM
    ▲▲▲▲▲  Vitest(单元,大量)
           → schema / fragments / crossfade / ducking /
             tts cache hash / query 匹配 / cron
```

### 13.2 依赖替身

- **FakeLLM**:按 mode 返回预定 schema 的 JSON,支持"第二次才合法"模拟重试
- **FakeTTS**:返回一段静音 MP3,时长可指定
- **FakeNCM**:静态 fixture(几个 playlist/song/url)
- **AudioContext**:`standardized-audio-context-mock`,验证 `setValueCurveAtTime` 参数

### 13.3 关键 e2e

1. 首启 → 扫码 → 首播 3s 内出声
2. Crossfade:听不到音量凹陷;filter sweep 曲线正确;TTS 底铺 gainB 轨迹正确
3. 聊天 replan:"想要再安静一点" → 3s 内 queue-updated
4. 跑步场景:"跑步 30 分钟 Rap" → `replan_segment` 成功;立即起播
5. 网络掉线:模拟断网 → 已预取曲继续播完,UI 离线角标

### 13.4 CI

本地 make target 为主(`test:unit` / `test:integration` / `test:e2e`)。GH Actions 可选,CI 上只跑 unit + integration(e2e 需要桌面环境)。

---

## §14 里程碑与分期(粗估)

| 里程碑 | 工期 | 产出 | 验收 |
|---|---|---|---|
| **M0 工程骨架** | 3d | electron-vite + TS + Tailwind + shadcn;主进程 HTTP+WS;SQLite 初始化;user-template 拷贝;pino 落盘 | `/api/health` 返回 ok;window 启动 |
| **M1 播放 MVP** | 4d | NCM 扫码登录 + 歌单读取;Web Audio 双 deck + crossfade(无 TTS);prefetch;Player UI | 单歌单从头到尾连播 + 平滑 crossfade |
| **M2 AI 底座** | 3d | LLM 兼容 client(流式/非流式);TTS 兼容 client + cache;safeStorage + 设置页;compute(fragments) 骨架 + FakeLLM 单测 | 设置页试听 TTS 成功;FakeLLM 走通 chat |
| **M3 规划** | 3d | scheduler + plan mode + 计划 UI + query→ncmId 兑现 + 降级 | 07:00 自动产出当日计划;UI 展示 4 时段 |
| **M4 DJ 串场 + 聊天 + 动态调整** | 5d | segue mode + ducking + chat mode + actions 执行 + WS 流 + Timeline 只读 | 换歌有 DJ 口播;聊天 replan 生效;跑步场景 |
| **M5 打磨** | 3d | 快捷指令 + 天气注入 + 5 模块 UI 整合 + e2e 冒烟 + README | Playwright 5 条 e2e 通过 |

**总计约 21 工作日**(纯工程落地,不含设计/迭代打磨)。

---

## §15 开放问题 / 后续决定项

- **已决(2026-04-23)**:串场策略采用"体验优先"。实现顺序 = 标准口播 > 晚到插入 > 模板口播 > 纯 crossfade。
- **已决(2026-04-23)**:`playlists.json` 采用结构化元数据(`segments/tags/energyRange/priority`),用于 fallback 与 gap-fill 打分。
- **V1.1**:Timeline 拖拽编辑、日历 hook
- **V1.2 候选**:多音源(QQ 音乐 / Spotify)、移动 PWA 版(因架构已按 BFF 分层,成本可控)
- **运营**:是否开放给他人 = 暂不。定位"个人 DJ"。
- **LLM 成本**:plan mode 每日 1 次(~2k tokens),segue 每首 1 次(~500 tokens),chat 按量。日均 <$0.10(GPT-4 级别)或 ~$0.01(DeepSeek/Qwen 级别)。

---

> 本文件是 Crossfadio 的产品与技术设计蓝本,作为后续实现计划(implementation plan)的唯一真源。任何变更走 git commit 历史。
