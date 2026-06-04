# Crossfadio Music Agent Tool-Loop Design

- **日期**: 2026-06-04
- **状态**: 设计稿
- **范围**: 统一 `/api/sse/pick-next` 自动补歌与 `/api/sse/chat` 聊天推荐的服务端选歌架构
- **目标**: 用真正的 bounded tool-loop agent 替代当前分散在路由中的串行推荐脚本，同时把候选生产升级为 retrieval/rerank 架构

## 1. 背景

当前代码已经有单 Agent 三 Mode 架构，以及较完整的 DJ 自动选歌 pipeline。核心链路集中在：

- `src/server/http/routes/djNext.ts`: 自动补歌，包含红心采样、LLM 生成风格/艺人、外部百科扩展、NCM 搜索、LLM 从候选中挑歌、fallback。
- `src/server/http/chat-sse-worker.ts`: 聊天推荐，先用 chat agent 生成 action，再对泛推荐请求做 NCM 搜索与 LLM 二次挑选。
- `src/server/agent/*`: 现有 plan / segue / chat 的 prompt fragments、schema 校验、LLM 调用。
- `src/server/store/messages.ts` 与 `src/server/store/chat-preferences.ts`: 已有聊天偏好沉淀所需的 store API，但生产链路尚未真正调用 `saveChatPreference()`。

现有问题不是完全没有 agent，而是选歌核心仍像一条固定脚本：

1. 候选池生产方式偏窄，主要依赖红心随机样本和搜索召回。
2. LLM 可以精排，但如果召回质量不足，最终选歌上限会被候选池限制。
3. 自动补歌与聊天推荐各自维护一套候选逻辑，重复且难以统一调优。
4. 聊天、歌单、播放行为、今日计划已经有数据源，但未被稳定转化为可复用的选歌信号。
5. `pick-next` SSE 的 abort signal 没有真正传入底层选歌任务，客户端断开后仍可能继续改队列。

## 2. 非目标

- 不修改现有前端交互和 HTTP/SSE 外部合约。
- 不引入向量库或重型长期记忆系统。
- 不让 LLM 直接修改队列、写数据库或编造可播放歌曲 ID。
- 不一次性重写 plan / segue agent；本设计只覆盖选歌和推荐。

## 3. 总体架构

新增 `src/server/music-agent/`：

```text
music-agent/
  index.ts          # MusicAgent facade
  loop.ts           # bounded tool-loop runner
  context.ts        # 构建用户/播放/聊天/计划上下文
  memory.ts         # 从聊天抽取偏好，写 chat_preferences
  candidates.ts     # CandidatePool：召回、去重、source/evidence
  rank.ts           # 服务端初排、diversity、负反馈惩罚
  tools.ts          # agent 可调用工具白名单
  prompts.ts        # tool-loop system prompt
  knowledge.ts      # 稳定音乐知识包：风格邻接、场景映射、基础选歌常识
  trends.ts         # 运行时趋势上下文：榜单、热门艺人、近期风格，带缓存和预算
  schema.ts         # tool call / observation / final output schema
```

`MusicAgent` 对路由暴露两个入口：

```ts
musicAgent.pickNext({
  userId,
  ncmClient,
  signal,
  emitDebug
});

musicAgent.recommendFromChat({
  userId,
  ncmClient,
  userText,
  actions,
  signal,
  emitProgress
});
```

路由职责保留为：

- 校验请求和用户身份。
- 传入 scoped `NcmClient`。
- 把客户端 queue snapshot 同步到服务端 queue store。
- 调用 `MusicAgent`。
- 根据 agent 返回结果执行 `addToQueue()` / `swapNext()`。
- 广播现有 `queue-appended`、`queue-updated`、`dj.debug`、`chat.recommend.progress` 事件。

队列 mutation 仍由服务端路由或服务端 adapter 执行，LLM 只输出决策。

## 4. Tool Loop

每次选歌启动一个 bounded loop：

```text
1. buildContext：收集当前时间、天气、daily theme、queue、today plan、recent chat、recent plays、activeDirective、taste、playlists。
2. maybeExtractMemory：把未抽取聊天沉淀到 chat_preferences。
3. LLM 看到 context summary、预算和当前候选池摘要。
4. LLM 输出 tool_call。
5. 服务端执行白名单 tool，并把 observation 追加回 loop。
6. CandidatePool 随工具结果更新。
7. 重复直到 LLM 输出 final，或预算耗尽。
8. 服务端校验 final picks 必须来自 CandidatePool。
9. 应用队列修改并发事件；如果失败则 fallback。
```

LLM 每轮只允许两类输出：

```ts
type MusicAgentLoopOutput =
  | { type: 'tool_call'; tool: MusicAgentToolName; input: unknown }
  | { type: 'final'; say: string; picks: FinalPick[]; rejected: RejectedPick[] };
```

非法 tool、非法 input、非 JSON、final pick 不在候选池中，都不能直接执行；runner 会 retry 或进入 fallback。

## 5. 候选池与 ID 生产

NCM ID 生产要从当前的“搜索结果列表”升级为 retrieval/rerank 候选池。

候选对象：

```ts
type MusicCandidate = {
  id: string;
  name: string;
  artist: string;
  sources: Array<'liked' | 'playlist' | 'plan' | 'search' | 'style_expansion' | 'trend'>;
  evidence: string[];
  scores: {
    intentMatch: number;
    tasteMatch: number;
    timeFit: number;
    planFit: number;
    novelty: number;
    recentPenalty: number;
    skipPenalty: number;
    sourceConfidence: number;
  };
};
```

`CandidatePool` 负责：

- 按 NCM id 合并候选。
- 按 normalized title + primary artist 去重，避免同歌不同 ID。
- 保留多 source evidence。
- 维护 hard filters 和 soft penalties。
- 生成 top-N 摘要给 LLM。
- 校验 final picks 是否来自白名单。

## 6. 召回工具

第一版工具白名单：

```text
get_context_summary
get_music_knowledge
get_trend_context
expand_queries
recall_from_liked
recall_from_playlists
recall_from_plan_segment
recall_from_ncm_search
recall_from_style_expansion
recall_from_trending
rank_candidates
diversify_candidates
finalize_pick
```

### 6.1 get_music_knowledge

稳定音乐知识可以作为内置上下文，但不能无限堆 prompt。第一版用结构化知识包，而不是长篇 system prompt。

知识来源：

1. 仓库内维护的 curated 静态数据，例如 `src/server/music-agent/data/music-knowledge.zh-CN.ts`。
2. 内容只放低漂移知识：风格邻接、场景能量、人声密度、查询模板、多样性规则。
3. 不放“最近热门艺人”“今年流行风格”“榜单歌曲”这类会过期的信息；这些只走 `get_trend_context`。
4. 不依赖 LLM 现场编知识。LLM 只能从静态知识包中取相关 slice，再结合用户上下文生成 query plan。

知识包包含：

- 风格邻接：例如 city pop 可向 synth pop、AOR、80s J-pop、粤语怀旧流行扩展。
- 场景映射：工作、通勤、深夜、跑步、下午低能量时段分别适合的能量和人声密度。
- 查询模板：中文、英文、风格、艺人、场景词如何组合成 NCM 搜索词。
- 负向约束：低能量不等于无聊，安静不等于纯器乐，探索不等于随机陌生。
- 多样性常识：同艺人、同厂牌、同 OST/合集来源不应连续占满候选。

输出给 LLM 的不是完整知识库，而是根据当前请求摘出的短摘要：

```ts
type MusicKnowledgeSlice = {
  styleAdjacency: string[];
  sceneRules: string[];
  queryTemplates: string[];
  diversityRules: string[];
  negativeMappings: string[];
};
```

静态知识包示例结构：

```ts
type MusicKnowledgeBase = {
  styleGraph: Record<string, string[]>;
  sceneProfiles: Record<string, {
    energyRange: [number, number];
    vocalDensity: 'low' | 'medium' | 'high';
    preferredStyles: string[];
    avoidTraits: string[];
  }>;
  queryTemplates: Array<{
    intent: string;
    templates: string[];
  }>;
  negativeMappings: Record<string, string[]>;
  diversityRules: string[];
};
```

维护原则：

- 小而准，优先覆盖当前产品常见意图：专注、通勤、下午放松、深夜、跑步、女声、少人声、别太吵。
- 可人工更新，更新需要单测验证 query slice 和 scene profile。
- 不把知识包当百科库；具体艺人和歌曲仍由 NCM / playlist / trend recall 产生。

### 6.2 get_trend_context

“最近红火的艺人、流行风格、榜单”应该加入上下文，但必须作为运行时趋势上下文，不写死在内置 prompt。

原因：

- 趋势会过期，写进 prompt 会快速陈旧。
- 榜单和热门风格有地域、语言、平台差异。
- 用户当前偏好和短期指令仍应高于大众趋势。

第一版设计为可选 tool：

```ts
type TrendContext = {
  fetchedAt: string;
  locale: 'zh-CN' | 'global';
  sources: Array<
    | 'ncm_search_hot'
    | 'ncm_toplist'
    | 'ncm_top_song'
    | 'ncm_personalized_newsong'
    | 'ncm_recommend_songs'
    | 'ncm_artist_toplist'
    | 'web_chart'
    | 'manual_cache'
  >;
  hotArtists: string[];
  hotStyles: string[];
  chartTrackHints: Array<{ title: string; artist: string; reason: string }>;
  confidence: number;
};
```

趋势来源按可用性分层，第一版优先 NCM，本地包已支持这些接口：

1. `/search/hot/detail`: 热搜词，适合生成 `hotStyles`、热门艺人 query 和近期话题 query。
2. `/toplist/detail`: 榜单元信息，选取云音乐热歌榜、新歌榜、飙升榜、原创榜等，再用 `/playlist/detail` 拉榜单曲目。
3. `/top/song?type=...`: 新歌速递，按区域取近期新歌，作为 `chartTrackHints`。
4. `/personalized/newsong`: 推荐新音乐，作为低权重新歌补充。
5. `/recommend/songs`: 登录态每日推荐。这更偏“个性化新鲜度”，不是大众 trend；只在有登录态且预算允许时作为辅助 source。
6. `/toplist/artist`: 热门艺人榜，形成 `hotArtists`。
7. 外部 chart / web search provider：只作为可选增强，配置允许且网络可用才使用。
8. 本地手动缓存或上次成功抓取结果。
9. 无趋势上下文时，直接跳过，不阻塞选歌。

实现上需要给 `NcmClient` 补趋势相关方法，或新增只读 `NcmTrendClient` adapter。趋势 adapter 只返回短字段：

```ts
type TrendTrackHint = {
  title: string;
  artist: string;
  source: TrendContext['sources'][number];
  reason: string;
};
```

不要把完整榜单 payload 传给 LLM，也不要在日志里记录 cookie 或完整 URL。

缓存策略：

- 缓存文件放在 app data 目录，例如 `<dataDir>/cache/trends/zh-CN.json`，不进 git。
- 默认 TTL 12 小时；热搜可更短，新歌和榜单可更长。
- `pick-next` 最多使用缓存或 2 秒内返回的趋势。
- `chat recommend` 只使用已有缓存，不主动长时间抓取。
- 趋势上下文只影响 query expansion 和 exploration recall，不覆盖 `activeDirective`。

### 6.3 expand_queries

输入：

- 用户聊天请求或 `auto-fill` 原因。
- 当前时段、天气、daily theme。
- `queue.activeDirective`。
- `taste.md` 与 `chat_preferences`。
- 当前 plan segment。
- `MusicKnowledgeSlice`。
- `TrendContext`，如果可用。

`expand_queries` 是一个 query planner，不是让 LLM 随便写几个搜索词。输出必须符合 schema：

```ts
type QueryPlan = {
  intentQueries: string[];
  tasteAnchorQueries: string[];
  planQueries: string[];
  trendQueries: string[];
  explorationQueries: string[];
  negativeTerms: string[];
  rationale: string;
};
```

示例 query groups：

```text
intent: ["华语 女声 indie pop", "下午 放松 女歌手"]
taste: ["City Pop 女声", "粤语 female vocal"]
trend: ["近期热门 女声 流行", "华语新歌 indie pop"]
exploration: ["dream pop female vocalist", "indie folk soft vocal"]
```

生成规则：

- 当前聊天请求和 `activeDirective` 先形成 intent queries。
- `taste.md` 与 `chat_preferences` 形成 taste anchor queries。
- 当前 plan segment 形成 plan queries。
- trend context 只生成 trend queries，不能覆盖前面三类。
- music knowledge 用于补风格邻接和查询模板，例如把“安静女声”扩成“soft female vocal / dream pop / acoustic pop”。
- `negativeTerms` 用于后续过滤或降权，例如“不要太吵”映射为高能量、重型、噪声倾向 penalty。

### 6.4 recall_from_liked

从红心歌曲 ID 采样并拉详情。

- `comfort` 模式提高 liked source 权重。
- `explore` 模式只保留较小 liked sample，作为 taste anchor。
- evidence: `用户红心歌曲`。

### 6.5 recall_from_playlists

读取 `playlists.json` 中匹配当前 segment、tags、energyRange 的歌单，用 `getPlaylistDetail()` 拉曲目。

- `playlist.priority` 影响 `sourceConfidence`。
- evidence: `来自歌单 <name>，标签 <tags>`。

### 6.6 recall_from_plan_segment

读取今日 plan 的当前时段：

- `segment.mood`、`energyPct`、`tracks.query` 进入 ranking。
- `tracks.query` 可以先 resolve 到 NCM id，也可作为搜索 query。
- evidence: `今日计划当前时段推荐`。

### 6.7 recall_from_ncm_search

对 query groups 调 NCM `cloudsearch`。

- 每个 query 限制返回数量，避免单 query 垄断候选池。
- query source 进入 evidence。
- 结果统一进 CandidatePool。

### 6.8 recall_from_trending

把 trend context 转化为候选，而不是直接相信趋势文本。

- `hotArtists` 会变成 NCM 搜索 query。
- `hotStyles` 会进入 exploration query。
- `chartTrackHints` 需要通过 NCM 搜索或 resolve 后才进入 CandidatePool。
- 所有趋势候选的 source 是 `trend`，并带 `confidence`。
- 如果趋势结果与用户明确指令冲突，只能低权重进入候选池。

趋势不是“越热越好”，而是用于提高召回新鲜度：

- `explore` 模式可以适当提高 trend source 权重。
- `comfort` 模式只在 taste anchor 能解释时使用 trend source。

### 6.9 recall_from_style_expansion

复用现有 MusicBrainz/Wikipedia 风格艺人扩展。

- 只在 explore 模式、候选不足、或候选同质时调用。
- 受独立预算控制，避免外部网络拖慢主链路。
- evidence: `由风格 <style> 扩展到艺人 <artist>`。

## 7. 过滤、初排与多样性

Hard filters：

- 今天已播过。
- 当前队列已有。
- `ban.track.*` / `ban.artist.*`。
- NCM 详情缺失或无艺人。
- normalized title + primary artist 重复。

Soft penalties：

- 最近 50 首播过。
- 最近 skip 过。
- 同艺人短期过密。
- source 单一。
- 与 `activeDirective` 冲突。

服务端初排：

```ts
score =
  intentMatch * 0.30 +
  tasteMatch * 0.20 +
  timeFit * 0.15 +
  planFit * 0.10 +
  sourceConfidence * 0.10 +
  novelty * 0.15 -
  recentPenalty -
  skipPenalty;
```

`rank_candidates` 输出 top 20-40 给 LLM，不把完整候选池塞进 prompt。

`diversify_candidates` 规则：

- 同一艺人最多 1 首进入最终 top 10。
- 同一 source 不能占满 top 10。
- `pick-next` 选 2 首时尽量不同艺人、不同 source。
- `explore` 模式提高 `search` / `style_expansion` / `trend` 占比。
- `comfort` 模式提高 `liked` / `playlist` 占比。

召回不足不是直接 fallback，而是 observation：

```json
{
  "candidateCount": 18,
  "problems": ["female_vocal_underrepresented", "too_many_recent_artists"]
}
```

LLM 必须根据 observation 决定补召回、重新 rank、diversify，或在预算内 finalize。

## 8. 记忆与行为反馈

### 8.1 聊天记忆

新增：

```ts
extractChatPreferencesIfDue(userId, llmConfig, signal)
```

触发时机：

- 每次 `recommendFromChat` 前。
- 每次 `pickNext` 前做轻量检查。
- 只处理 `messages.extracted_at IS NULL`。
- 少于 4 条未抽取消息时跳过。

写入现有 store：

```ts
saveChatPreference(userId, summary, messageIds);
markMessagesExtracted(userId, ids);
```

抽取内容只保留音乐偏好：

- 最近偏好：女声、安静、下午放松。
- 长期偏好：粤语、City Pop、indie、不要太商业。
- 负向偏好：不想要太吵、太土、纯器乐。
- 场景偏好：工作时少人声，深夜低能量。

不抽取个人身份、工作内容、位置、非音乐闲聊。

### 8.2 优先级

选歌信号优先级：

```text
activeDirective > 当前聊天请求 > 当前计划时段 > chat_preferences > taste.md > daily theme
```

`queue.activeDirective` 是短期强约束。`chat_preferences` 是中长期软偏好。`taste.md` 是长期背景画像。

### 8.3 播放行为

从最近 50-100 条 `plays` 计算：

- `completed`: 不直接加分，但作为可接受信号，并用于短期去重。
- `skip`: 对 song id 加 `skipPenalty`，对 primary artist 加轻微 penalty。
- `error`: 只作为可播放性问题，不当作用户不喜欢。

第一版不新增表。

### 8.4 今日计划

`plan.payload_json` 进入 `pick-next`：

- 根据当前时间找到 segment。
- `segment.mood`、`energyPct`、`tracks` 参与 recall 和 ranking。
- 用户 chat 明确覆盖时，chat 优先。

## 9. 上下文摘要

不要把所有原始数据塞给 LLM。`context.ts` 生成压缩摘要：

```ts
type MusicAgentContextSummary = {
  request: 'auto-fill' | 'chat-recommend';
  currentMoment: {
    localTime: string;
    daypart: string;
    weather: string | null;
    dailyTheme?: string;
  };
  activeDirective: string;
  currentPlanSegment: string | null;
  tasteSummary: string;
  recentPreferenceSummary: string;
  recentPlaySignals: string;
  queueStateSummary: string;
  bannedSummary: string;
};
```

详细数据通过 tools 查询。这样 loop 能多轮获取上下文，又不会一开始撑爆 prompt。

## 10. 预算与 Fallback

预算：

```ts
type AgentBudget = {
  maxMs: number;
  maxSteps: number;
  maxLlmCalls: number;
  maxToolCalls: number;
  maxNcmSearches: number;
  maxPlaylistFetches: number;
  maxTrendFetchMs: number;
  maxCandidates: number;
};
```

默认建议：

```text
pick-next:
- maxMs 60s
- maxSteps 8
- maxLlmCalls 5
- maxCandidates 120

chat recommend:
- maxMs 35s
- maxSteps 5
- maxLlmCalls 3
- maxCandidates 80
```

Fallback 分层：

1. **ranked fallback**: CandidatePool 已有候选但 LLM final 失败时，服务端直接取 top diversified candidates。
2. **recall fallback**: 候选不足时，用 liked + playlist + plan segment 快速召回，不走 LLM。
3. **existing fallback**: NCM/LLM 都不可用时，沿用当前随机红心 fallback。

## 11. Abort 与并发

新接口统一传递 `AbortSignal`：

```ts
musicAgent.pickNext({ userId, ncmClient, signal });
musicAgent.recommendFromChat({ userId, ncmClient, userText, signal });
```

所有 LLM、NCM search、playlist fetch、style expansion 都要接收或检查 signal。

客户端断开、任务超时、用户取消推荐时，不应继续执行队列 mutation。

`isRunning` 仍按 userId 控制同一用户的自动补歌并发。聊天推荐沿用 jobId cancel 机制，但底层推荐 pipeline 必须接收 abort。

## 12. Trace 与调试

每次 loop 记录简洁 trace：

```ts
type AgentTraceStep = {
  step: number;
  thoughtSummary: string;
  tool?: string;
  toolInputSummary?: string;
  observationSummary?: string;
  candidateCount: number;
  elapsedMs: number;
};
```

不保存完整 prompt，不保存 API key，不保存 cookie，不保存用户原始长聊天。

可发出的 debug/progress 事件：

```text
music-agent.started
music-agent.tool
music-agent.candidates
music-agent.final
music-agent.fallback
```

第一版无需新增前端 UI，可复用现有 `dj.debug` 与 `chat.recommend.progress` 承载摘要。

## 13. 输出契约

最终输出：

```ts
type MusicAgentFinalOutput = {
  mode: 'pick_next' | 'chat_recommend';
  say: string;
  picks: Array<{
    id: string;
    name?: string;
    artist?: string;
    reason: string;
    source: 'liked' | 'playlist' | 'plan' | 'search' | 'style_expansion' | 'trend';
  }>;
  rejected: Array<{
    id: string;
    reason: string;
  }>;
  trace: AgentTraceStep[];
};
```

校验规则：

- `picks[].id` 必须在 CandidatePool。
- `picks` 最多 2 首。
- `say` 是给用户看的简短中文说明。
- `reason` 是工程调试和后续串场可用的选歌理由。
- `source` 必须来自候选对象的 sources。

## 14. 测试计划

单测：

```text
music-agent/schema.spec.ts
- tool_call / final schema
- 非法 tool 拒绝
- final pick 不在 candidate pool 拒绝

music-agent/candidates.spec.ts
- 多 source merge
- id 去重
- title+primary artist 去重
- ban artist/track hard filter
- recent skip penalty

music-agent/rank.spec.ts
- activeDirective 优先级
- explore/comfort source mix
- 同艺人 diversity

music-agent/memory.spec.ts
- 未抽取消息不足时跳过
- 只提取音乐偏好
- saveChatPreference + markMessagesExtracted

music-agent/knowledge.spec.ts
- 根据请求返回相关 style adjacency / scene rules
- 不返回过长知识包
- negativeMappings 能把“别太吵”转成降权特征

music-agent/trends.spec.ts
- 优先读取未过期缓存
- NCM 趋势接口失败时不阻塞选歌
- trend source 只影响 trendQueries / trend candidates
- `/recommend/songs` 标记为个性化新鲜度，不当作大众榜单

music-agent/loop.spec.ts
- 多轮 tool call
- 预算耗尽 fallback
- LLM final 非候选 id 被拒
- abort 后不执行队列 mutation
```

集成测试：

```text
dj pick-next
- fake LLM 先召回再 finalize
- LLM final 失败时 ranked fallback
- 候选不足时继续召回

chat recommend
- 用户说“下午多来点女歌手”
- 写入 activeDirective / chat_preferences
- 后续 pick-next 使用该偏好
```

验证命令：

```bash
pnpm check
pnpm test
```

## 15. 实施顺序

1. 建 `music-agent/schema.ts`、`candidates.ts`、`rank.ts`，先不接路由。
2. 建 `knowledge.ts` 和静态 `data/music-knowledge.zh-CN.ts`。
3. 建 `trends.ts`，补 NCM trend adapter 和 app data cache。
4. 建 `memory.ts`，接 `chat_preferences` 和 `messages.extracted_at`。
5. 建 `tools.ts` 和 `loop.ts`，用 fake LLM 完成 loop 单测。
6. 把 `chat-sse-worker.ts` 中 `runChatRecommendPipeline()` 迁到 `MusicAgent.recommendFromChat()`。
7. 把 `djNext.ts` 中 Phase 2-4 迁到 `MusicAgent.pickNext()`。
8. 修复 `pick-next` abort signal 传递。
9. 保留旧 helper 和 fallback，逐步删除路由里的重复逻辑。

## 16. 风险

- Tool-loop 比固定 pipeline 更贵更慢，必须严格预算。
- 候选召回工具太多时，LLM 可能来回调用低收益工具；prompt 和 observation 要明确“候选质量问题”。
- `chat_preferences` 可能把一次性偏好误当长期偏好；抽取 prompt 必须区分短期与长期。
- NCM 搜索质量不稳定，需要 playlist、plan、liked 多 source 兜底。
- Debug trace 不能泄露用户隐私、cookie、key 或完整长聊天。

## 17. 验收标准

- 自动补歌和聊天推荐都通过 `MusicAgent`。
- 最终选歌只能来自 CandidatePool 白名单。
- CandidatePool 支持 liked / playlist / plan / search / style expansion / trend 多 source。
- 聊天偏好能沉淀到 `chat_preferences` 并影响后续 `pick-next`。
- `plays.end_reason = skip` 能影响候选 penalty。
- 客户端断开或取消后不会继续改队列。
- `pnpm check` 和相关 Vitest 单测通过。
