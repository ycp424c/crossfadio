# Crossfadio

Crossfadio 是一个本地运行的 AI DJ Web App（Node.js + React + TypeScript）。

## 当前状态

多用户在线 AI DJ 服务，支持 JWT 认证、按用户隔离的数据存储：

- Vite + React + Tailwind 前端，4 Tab（播放 / 计划 / 聊天 / 设置）
- Node.js + Express HTTP/SSE 服务，JWT 认证，公开/受保护路由分离
- SQLite（better-sqlite3）：messages、plays、plan、prefs、segues、chat_preferences、users、blocked_login_attempts
- 每用户数据隔离（`user_id` 列 + per-user Map）
- NCM 接入（子进程管理 + 客户端封装 + 扫码登录 + JWT 签发）
- 白名单控制（`allowlist.json` + 管理员 Web UI，移除即撤销会话）
- Web Audio 双 Deck 播放引擎（等能量 crossfade + filter sweep）
- AI Agent（plan/segue/chat 三模式，OpenAI 兼容 LLM，env var 配置）
- TTS 串场口播（cache-first，底铺式插入，阿里云 Qwen TTS）
- 每日电台计划（4 时段自动生成 + 手动调整）
- 每日主题系统（LLM 生成，可单独开关）
- 聊天动态调整（自然语言换歌/加歌/切段）
- DJ 自动选歌（红心歌单采样 + LLM 搜索推荐）
- 探索 / 舒适区两种选歌模式：探索模式降低个人品味权重并扩展到主题、时间、天气、DJ 偏好；舒适区模式提高个人品味匹配
- NCM 唱片封面透传：歌曲详情的 `al.picUrl` 会进入播放主卡和队列项
- 过渡语音一次性 SSE 请求对临时 `502/503/504` 自动重试

## NCM 本地 API 启动配置（开发阶段）

当前代码会按以下顺序拉起 NCM API：

1. 如果配置了 `CROSSFADIO_NCM_COMMAND`，优先使用显式命令。
2. 否则默认尝试 `pnpm exec NeteaseCloudMusicApi`（已内置依赖）。
3. 如果两者都不可用，`/api/ncm/status` 会显示 disabled。

可选环境变量：

- `CROSSFADIO_NCM_COMMAND`: 自定义可执行命令
- `CROSSFADIO_NCM_ARGS`: 自定义参数字符串
- `CROSSFADIO_NCM_PORT`: 端口（默认 `3000`）
- `CROSSFADIO_PORT`: Web Server 端口（默认 `4318`）
- `CROSSFADIO_DATA_DIR`: 自定义本地数据目录
- `CROSSFADIO_NCM_CWD`: 子进程工作目录
- `CROSSFADIO_NCM_HEALTH_PATH`: 健康探测路径（默认 `/`）
- `CROSSFADIO_NCM_DISABLE_AUTO=1`: 禁用默认自动拉起
- `CROSSFADIO_HOST`: 服务绑定地址（默认 `127.0.0.1`）
- `CROSSFADIO_ALLOWED_ORIGINS`: 逗号分隔的 CORS 来源

多用户必需环境变量：

- `CROSSFADIO_JWT_SECRET`: JWT HS256 签名密钥
- `CROSSFADIO_LLM_BASE_URL` / `CROSSFADIO_LLM_API_KEY` / `CROSSFADIO_LLM_MODEL`
- `CROSSFADIO_TTS_BASE_URL` / `CROSSFADIO_TTS_API_KEY`
- `CROSSFADIO_ADMIN_NCM_ID`（可选，白名单管理员 NCM 用户 ID）

白名单：在数据目录下创建 `allowlist.json`（数组），或配置 `CROSSFADIO_ADMIN_NCM_ID` 后通过 Web UI「设置 → 白名单管理」页面操作。

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

默认配置（单机本地使用）：

- 服务监听 `http://127.0.0.1:4318`，仅本机访问
- 也可以不设白名单和 JWT，单用户跑

多用户在线部署（公网暴露）需要额外配置：

- `CROSSFADIO_HOST=0.0.0.0` 公开绑定
- `CROSSFADIO_JWT_SECRET` HS256 签名密钥（必须）
- `CROSSFADIO_LLM_*` / `CROSSFADIO_TTS_*` 完整配置
- 数据目录下放 `allowlist.json`（数组，允许登录的 NCM 用户 ID）
- 受保护路由要求 `Authorization: Bearer <jwt>`，扫码登录后从 `/api/ncm/login/status` 拿到 token

实际线上部署、重启、加白名单、改 persona 等操作流程见 [`docs/ops-runbook.md`](docs/ops-runbook.md)。日常部署使用 `./scripts/deploy.sh`（构建 → OSS 中转 → ECS 部署）。

## 数据目录

- macOS 默认目录：`~/Library/Application Support/Crossfadio`
- Linux 默认目录：`~/.crossfadio`
- Windows 默认目录：`%APPDATA%/Crossfadio`
- 包含 `state.db`、`logs/`、`users/<ncmId>/`（每用户语料）、`allowlist.json`

## 检查

```bash
pnpm check
pnpm test
pnpm build
```
