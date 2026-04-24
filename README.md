# Crossfadio

Crossfadio 是一个本地运行的 AI DJ Web App（Node.js + React + TypeScript）。

## 当前状态

当前实现已经完成从 Electron 到本地 Web Server 架构的迁移：

- Vite + React + Tailwind 前端
- Node.js + Express 本地 HTTP/WS 服务
- `GET /api/health`
- SQLite 初始化与迁移（messages/plays/plan/prefs/tts_cache）
- `user-template/` 首次启动拷贝至用户应用目录
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
- `CROSSFADIO_PORT`: Crossfadio Web Server 端口（默认 `4318`）
- `CROSSFADIO_DATA_DIR`: 自定义本地数据目录
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

- `pnpm dev:web`: 启动前端开发服务器
- `pnpm dev:server`: 启动本地后端服务
- 浏览器访问 `http://127.0.0.1:5173`

## 生产运行

```bash
pnpm build
pnpm start
```

- 服务默认监听 `http://127.0.0.1:4318`
- 仅允许本机 `localhost/127.0.0.1` 访问

## 数据目录

- macOS 默认目录：`~/Library/Application Support/Crossfadio`
- Linux 默认目录：`~/.crossfadio`
- Windows 默认目录：`%APPDATA%/Crossfadio`
- 包含 `state.db`、`logs/`、`user/`、`secrets.json`
- `secrets.json` 为文件存储降级方案，不再使用 Electron `safeStorage`

## 检查

```bash
pnpm check
pnpm build
```
