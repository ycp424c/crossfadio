# Crossfadio

Crossfadio 是一个本地运行的 AI DJ 桌面应用（Electron + React + TypeScript）。

## 当前状态

已落地 M0 骨架：

- Electron + Vite + React + Tailwind 基础工程
- 主进程单实例启动
- 内嵌本地 HTTP/WS 服务
- `GET /api/health`
- SQLite 初始化与迁移（messages/plays/plan/prefs/tts_cache）
- `user-template/` 首次启动拷贝至 userData
- NCM 基础接入（子进程管理 + 客户端封装 + `/api/ncm/status`）

## NCM 本地 API 启动配置（开发阶段）

当前代码会按以下顺序拉起 NCM API：

1. 如果配置了 `CROSSFADIO_NCM_COMMAND`，优先使用显式命令。
2. 否则默认尝试 `pnpm exec NeteaseCloudMusicApi`（已内置依赖）。
3. 如果两者都不可用，`/api/ncm/status` 会显示 disabled。

可选环境变量：

- `CROSSFADIO_NCM_COMMAND`: 自定义可执行命令（例如 `node` 或本地脚本）
- `CROSSFADIO_NCM_ARGS`: 自定义参数字符串（支持引号）
- `CROSSFADIO_NCM_PORT`: 端口（默认 `3000`）
- `CROSSFADIO_NCM_CWD`: 子进程工作目录
- `CROSSFADIO_NCM_HEALTH_PATH`: 健康探测路径（默认 `/`）
- `CROSSFADIO_NCM_DISABLE_AUTO=1`: 禁用默认自动拉起

重启策略：

- 健康检查超时（默认 8s）会判定启动失败
- 子进程崩溃后 3 秒重启
- 60 秒内最多重试 3 次，超过后停止重启并上报错误状态

## 开发

```bash
pnpm install
pnpm dev
```

## 检查

```bash
pnpm check
pnpm build
```
