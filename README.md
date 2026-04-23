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

当前代码会读取以下环境变量尝试拉起 NCM API：

- `CROSSFADIO_NCM_COMMAND`: 可执行命令（例如 `node` 或本地脚本）
- `CROSSFADIO_NCM_ARGS`: 参数字符串（按空格拆分）
- `CROSSFADIO_NCM_PORT`: 端口（默认 `3000`）

未配置 `CROSSFADIO_NCM_COMMAND` 时不会拉起子进程，`/api/ncm/status` 会返回 disabled 状态。

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
