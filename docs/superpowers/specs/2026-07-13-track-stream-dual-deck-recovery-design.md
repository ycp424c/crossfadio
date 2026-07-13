# 音频流双 Deck 主动恢复设计

## 背景

单个 `<audio>` 在弱网下出现低缓冲、`waiting` 或 `stalled` 时，只能等到真实媒体错误后刷新 URL。为了减少可听见的中断，播放器保留一个静音 standby deck，提前准备当前歌曲的新流或队列中的下一首。

本设计扩展连续失败重试机制，但不改变“三次真实媒体错误后停止自动恢复、稳定播放十秒后清零”的既有合同。

## 决策

- 保留 active / standby 两个原生 `<audio>`，成功准备后交换引用。
- 连续三次低缓冲采样、`waiting` 或 `stalled` 可以触发当前歌曲的预防性恢复。
- 预防性切换不增加、也不清零真实媒体错误预算。
- 只有 active deck 的真实 `error` 消耗一次预算；即使 standby 已就绪，也必须先检查并增加同一组三次预算。
- 真实错误使用 standby 切换失败时，降级到刷新 `/api/now` URL 并从断点续播。
- standby 事件必须同时匹配 request ID 和期望 source URL。旧请求产生的 `loadedmetadata`、`canplay`、`error` 一律忽略。
- standby 预载最多尝试三次，使用固定 500ms 间隔，不使用指数退避。
- 下一首提升必须在 `play()` 完成后重新校验来源歌曲、standby request、队列对象和当前索引；过期结果不能覆盖用户切歌或远端队列更新。
- 切歌、队列清空和组件卸载必须使在途请求、timer、旧音源和 crossfade timer 全部失效。

## Prefetch 边界

Prefetch 到达触发点后保持 armed，避免粗粒度 `timeupdate` 越过窄窗口后永远错过预载。每首歌曲仍由 `prefetchTriggeredRef` 保证只触发一次。

这项语义修复保留在 `audio/prefetch.ts` 及其独立测试中，交付时应与双 Deck 状态机拆成独立提交。

## 状态与降级

1. standby 目标先失效旧 request 并卸载旧 source，再发起新请求。
2. API 或媒体加载失败时执行有界固定间隔重试；最终失败则清空 staged 状态。
3. 当前歌曲预防性恢复最终失败后进入 15 秒冷却，active deck 继续播放。
4. 下一首预载最终失败时，曲终沿用普通加载路径。
5. standby `play()` 被拒绝时，不交换 deck；真实错误路径继续刷新当前 URL。

## 测试要求

- 旧 request 或旧 source 的 standby 事件被忽略。
- 预防性切换不改变错误预算；真实错误始终计数，第四次停止。
- standby 切换失败会走 URL 刷新降级。
- 十秒有效播放仍是唯一自动清零错误预算的条件。
- 异步提升期间发生 skip、prev、远端队列更新或卸载时，不应用旧 transition。
- 固定重试间隔不会随 attempt 指数增长，第三次失败后停止。
