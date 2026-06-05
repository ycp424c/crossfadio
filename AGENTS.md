# AGENTS.md

1. 默认使用中文回复用户问题。
2. 如果网络出现问题，使用代理 `127.0.0.1:7897` 重试；加代理后执行一样的命令不需要重复询问权限。
3. 如果新建会话里要修改工作区文件，但工作区有文件未提交，可以打断并询问是否要先提交或清理工作区。
4. 如果可能，尽量使用 subagent 提高效率。

## 线上日志

主应用日志在数据目录，不在 `REDACTED_SERVICE_DIR/server.log`：

- 主应用日志：`REDACTED_DATA_DIR/logs/app-YYYY-MM-DD.log`
- 当天日志：`REDACTED_DATA_DIR/logs/app-$(date +%F).log`
- 启动 stdout/stderr：`REDACTED_SERVICE_DIR/server.log`，正常可能为空，只在启动失败或崩溃时看

通过 aliyun CLI 查当天线上日志：

```bash
aliyun ecs RunCommand --RegionId REDACTED_ECS_REGION \
  --InstanceId.1 REDACTED_ECS_INSTANCE_ID \
  --Type RunShellScript \
  --Timeout 60 \
  --CommandContent 'LOG="REDACTED_DATA_DIR/logs/app-$(date +%F).log"; tail -n 200 "$LOG"'
```

再用 `DescribeInvocations --IncludeOutput true` 拉取输出并 base64 解码；完整流程见 `docs/ops-runbook.md` 的“怎么连上去”和“看日志”章节。

DJ 自动选歌排查常用过滤：

```bash
LOG="REDACTED_DATA_DIR/logs/app-$(date +%F).log"
tail -n 1200 "$LOG" | grep -E \
  'MusicAgent ranked convergence|MusicAgent fallback|DJ pick-next: broadcast appended tracks|appended fewer than target|fallback: appended tracks|LLM returned whitelisted'
```
