# Multi-User Architecture Design

**Date:** 2026-04-30  
**Status:** Approved  
**Scope:** 多用户支持 + 线上部署适配

## Overview

将 Crossfadio 从单用户本地应用改造为支持多用户的线上服务。用户通过 NCM 扫码登录，服务端签发 JWT，所有用户数据在单一 SQLite 中以 `user_id` 隔离。LLM/TTS 由运营者统一配置，NCM ID 白名单控制访问。

## 1. 认证与 Session

### 白名单

- 文件路径：`{CROSSFADIO_DATA_DIR}/allowlist.json`
- 格式：NCM user ID 字符串数组 `["123456789", "987654321"]`
- 服务启动时读入内存，静态加载（第一版不做热重载）

### QR 登录流程

```
1. GET /api/ncm/login/qr          → 生成 qrKey，返回 qrimg（无变化）
2. GET /api/ncm/login/status?key= → 轮询，authorized 时：
   a. 调 NCM getLoginStatus 拿 userId（profile.userId）
   b. 检查白名单：
      - 不在 → insert blocked_login_attempts，返回 { code: 'FORBIDDEN' }
      - 在   → upsert users 表（ncm_id, cookie, profile_json, last_seen_at）
   c. 签发 JWT：{ sub: ncm_id, iat, exp }
   d. 返回 { code: 'AUTHORIZED', token: <jwt> }
3. 前端把 JWT 存 localStorage，后续请求带 Authorization: Bearer <token>
```

### JWT 配置

| 项 | 值 |
|---|---|
| 算法 | HS256 |
| 密钥 | `CROSSFADIO_JWT_SECRET`（必填，启动时校验） |
| 有效期 | 7 天（可配 `CROSSFADIO_JWT_TTL_DAYS`，默认 7） |
| Payload | `{ sub: ncm_id, iat, exp }` |

### WS Auth

第一条消息由 `{ type: 'auth', token: sessionToken }` 改为 `{ type: 'auth', token: <jwt> }`，服务端验证 JWT，成功后 `extWs.userId = payload.sub`，失败 close 4001。

## 2. 数据库 Schema

### 新增表

```sql
-- 已登录用户
CREATE TABLE IF NOT EXISTS users (
  ncm_id       TEXT PRIMARY KEY,
  ncm_cookie   TEXT NOT NULL,     -- AES-256-GCM 加密后的 cookie
  profile_json TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 被白名单拦截的登录尝试
CREATE TABLE IF NOT EXISTS blocked_login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ncm_id       TEXT NOT NULL,
  profile_json TEXT,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 现有表加 user_id 列

通过 migration 新增 `user_id TEXT NOT NULL DEFAULT ''`，历史数据设为 `'__legacy__'`：

| 表 | 备注 |
|---|---|
| `messages` | 聊天记录 |
| `plays` | 播放历史 |
| `plan` | 每日计划 |
| `prefs` | 用户偏好（含 tts.voice） |
| `segues` | 过渡语历史 |
| `chat_preferences` | LLM 提取的聊天偏好 |

`plan` 表 UNIQUE 约束改为 `UNIQUE(user_id, plan_date, version)`。

### 不加 user_id 的表

`tts_cache`（内容级 hash 共享）、`blocked_login_attempts`、`users`、`meta`。

### Cookie 加密

`SecretStore` 移除，加密逻辑抽取为 `src/server/crypto.ts`（AES-256-GCM 工具函数），供 users 表 cookie 字段加解密使用。加密密钥来自 `CROSSFADIO_JWT_SECRET`（或单独的 `CROSSFADIO_COOKIE_ENCRYPT_KEY`）。

## 3. 请求管道

### 新增中间件（`src/server/http/middleware/`）

**`auth.ts`**
- 读取 `Authorization: Bearer <token>`
- 验证 JWT 签名 + 过期
- 成功：`req.userId = payload.sub`
- 失败：返回 401

**`userScope.ts`**
- 读取 `req.userId`
- 从 `users` 表取 `ncm_cookie`，解密
- 构建 `NcmClient`（绑定该 cookie）
- 挂载：`req.ncmClient = NcmClient`
- 用户记录不存在：返回 401

### 路由分类

**公开路由（不挂中间件）**
- `GET /api/health`
- `GET /api/runtime`
- `GET /api/ncm/status`
- `GET|POST /api/ncm/login/qr`
- `GET /api/ncm/login/status`
- `GET /api/segue/audio/*`

**受保护路由**
- 其余所有 `/api/*` 路由，统一挂 `auth` + `userScope` 中间件

### Handler 改造规则

```ts
// 所有受保护 handler 从 req 取 userId 和 ncmClient
const { userId, ncmClient } = req as AuthedRequest;
// store 函数调用
getPlays(userId, ...args);
// NCM 调用
ncmClient.getLikedSongs();
```

### NcmAuthService 职责收窄

只负责 QR 登录流程（无状态，不持有 cookie）。登录成功后写 `users` 表，运行时 cookie 由 `userScope` 中间件从 DB 取。

## 4. Settings 重构

### 环境变量（运营者配置）

| 变量 | 必填 | 说明 |
|---|---|---|
| `CROSSFADIO_JWT_SECRET` | ✓ | JWT 签名密钥 |
| `CROSSFADIO_LLM_BASE_URL` | ✓ | LLM API endpoint |
| `CROSSFADIO_LLM_API_KEY` | ✓ | LLM API key |
| `CROSSFADIO_LLM_MODEL` | ✓ | 模型名 |
| `CROSSFADIO_TTS_BASE_URL` | ✓ | TTS endpoint |
| `CROSSFADIO_TTS_API_KEY` | ✓ | TTS API key |
| `CROSSFADIO_TTS_VOICE_DEFAULT` | | 默认音色（用户未选时 fallback） |
| `CROSSFADIO_HOST` | | 绑定地址，默认 `127.0.0.1` |
| `CROSSFADIO_ALLOWED_ORIGINS` | | 逗号分隔的允许 origin 列表 |

### 用户可配置（prefs 表）

- `tts.voice`：音色选择，Settings 页下拉，未设则 fallback 到 `CROSSFADIO_TTS_VOICE_DEFAULT`

### Settings 页 UI

- 移除：LLM/TTS key 填写表单、test-llm/test-tts 接口
- 保留：TTS voice 选择、NCM 登录状态、登出按钮
- 新增：只读展示当前 LLM/TTS 配置来源（masked）

### 移除接口

- `PUT /api/settings`（LLM/TTS 部分）
- `POST /api/settings/test-llm`
- `POST /api/settings/test-tts`

## 5. 部署与 CORS

### CORS

```
CROSSFADIO_ALLOWED_ORIGINS=https://your-domain.com
```

启动时解析为数组，origin 检查对比该数组。本地开发保留 localhost 自动允许。

### Host 绑定

```
CROSSFADIO_HOST=0.0.0.0   # 默认 127.0.0.1，线上改为 0.0.0.0
```

### user-corpus 目录

`data/users/{ncm_id}/` 替代 `data/user/`，`ensureUserCorpus(userId)` 在用户首次登录时初始化。

### NCM 进程

保持单个 subprocess，多用户共享，cookie 通过请求头区分。

## 不在本次范围内

- Scheduler 多用户适配（保持现状）
- 白名单热重载
- 用户管理 UI（增删白名单）
- Session 撤销 / 强制下线
