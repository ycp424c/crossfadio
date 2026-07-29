#!/bin/bash
# Crossfadio 部署脚本 — 本地构建 → 制品中转 → 远端部署 → 重启服务
#
# 前置条件：
#   1. 本地已安装 aliyun CLI 并配置好凭据（~/.aliyun/config.json）
#   2. 本地已安装 pnpm
#   3. 已从 scripts/ops.env.example 创建被 Git 忽略的 .local/ops/production.env
#
# 用法：
#   ./scripts/deploy.sh              # 部署当前分支
#   ./scripts/deploy.sh --dry-run    # 只构建，不上传/部署
#   ./scripts/deploy.sh --restart    # 仅重启线上服务（不构建/上传）
#   ./scripts/deploy.sh --status     # 仅查看线上状态
#   ./scripts/deploy.sh --check-config # 仅校验本地私密配置
#   CROSSFADIO_OPS_ENV_FILE=/private/path ./scripts/deploy.sh
#
set -euo pipefail

# ── 配置 ────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPS_ENV_FILE="${CROSSFADIO_OPS_ENV_FILE:-$REPO_ROOT/.local/ops/production.env}"

if [ ! -f "$OPS_ENV_FILE" ]; then
  printf 'ERROR: 缺少本地私密运维配置：%s\n' "$OPS_ENV_FILE" >&2
  printf '请复制 scripts/ops.env.example 到 .local/ops/production.env 并只在本地填写。\n' >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$OPS_ENV_FILE"
set +a

required_ops_vars=(
  ECS_REGION
  ECS_INSTANCE
  OSS_BUCKET
  OSS_ENDPOINT
  OSS_OBJECT
  SERVICE_PORT
  SERVICE_DIR
  TARBALL
  SIGNED_URL_TIMEOUT
)

for required_ops_var in "${required_ops_vars[@]}"; do
  if [ -z "${!required_ops_var:-}" ]; then
    printf 'ERROR: %s 未在 %s 中配置\n' "$required_ops_var" "$OPS_ENV_FILE" >&2
    exit 1
  fi
done

if ! [[ "$SERVICE_PORT" =~ ^[0-9]+$ ]] || ! [[ "$SIGNED_URL_TIMEOUT" =~ ^[0-9]+$ ]]; then
  printf 'ERROR: SERVICE_PORT 和 SIGNED_URL_TIMEOUT 必须是正整数\n' >&2
  exit 1
fi

# ── 工具函数 ────────────────────────────────────────────────────────────────────

red()    { echo -e "\033[31m$1\033[0m"; }
green()  { echo -e "\033[32m$1\033[0m"; }
yellow() { echo -e "\033[33m$1\033[0m"; }

die() { red "ERROR: $1"; exit 1; }

# 在 ECS 上执行命令并等待结果
ecs_run() {
  local desc="$1"
  local script="$2"
  local timeout="${3:-60}"

  yellow "→ ECS: ${desc}..."

  # 将脚本存为临时文件，避免 shell 转义问题
  local tmpfile
  tmpfile=$(mktemp)
  printf '%s\n' "$script" > "$tmpfile"

  local invoke_id
  invoke_id=$(aliyun ecs RunCommand \
    --RegionId "$ECS_REGION" \
    --InstanceId.1 "$ECS_INSTANCE" \
    --Type RunShellScript \
    --Timeout "$timeout" \
    --CommandContent "$(cat "$tmpfile")" 2>/dev/null | python3 -c "
import json, sys
raw = sys.stdin.read()
idx = raw.find('{')
if idx >= 0:
    d = json.loads(raw[idx:])
    print(d.get('InvokeId',''))
")
  rm -f "$tmpfile"

  if [ -z "$invoke_id" ]; then
    die "无法提交命令到 ECS"
  fi

  # 轮询结果
  local elapsed=0
  local interval=3
  while [ "$elapsed" -lt "$timeout" ]; do
    sleep "$interval"
    elapsed=$((elapsed + interval))

    local raw
    raw=$(aliyun ecs DescribeInvocations \
      --RegionId "$ECS_REGION" \
      --InvokeId "$invoke_id" \
      --IncludeOutput true 2>/dev/null)

    # 从 aliyun CLI 输出中提取 JSON 并解析
    local parsed
    parsed=$(echo "$raw" | python3 -c "
import json, sys, base64
raw = sys.stdin.read()
idx = raw.find('{')
if idx < 0:
    sys.exit(1)
d = json.loads(raw[idx:])
invs = d.get('Invocations',{}).get('Invocation',[]) if 'Invocations' in d else d.get('Invocation',[])
insts = invs[0].get('InvokeInstances',{}).get('InvokeInstance',[]) if isinstance(invs, list) and invs else []
inst = insts[0] if insts else {}
sys.stdout.write('__STATUS__' + inst.get('InvocationStatus','') + '\n')
out = inst.get('Output','')
if out:
    sys.stdout.write(base64.b64decode(out).decode())
")

    local real_status output
    real_status=$(echo "$parsed" | sed -n 's/^__STATUS__//p' | head -1)
    output=$(echo "$parsed" | sed '/^__STATUS__/d')

    if [ -n "$output" ]; then
      echo "$output"
    fi

    case "$real_status" in
      Success) green "  ✓ 完成"; return 0 ;;
      Failed)  red "  ✗ 失败"; return 1 ;;
      Stopped) red "  ✗ 已停止"; return 1 ;;
      Running) ;;
      *)       yellow "  ... ${real_status}" ;;
    esac
  done

  die "命令超时（${timeout}s）"
}

# ── 子命令：构建 ────────────────────────────────────────────────────────────────

do_build() {
  green "=== 1. 构建 ==="

  cd "$REPO_ROOT"

  # 检查工作区是否干净
  if ! git diff-index --quiet HEAD --; then
    yellow "警告：工作区有未提交的改动，将一并打包"
  fi

  echo "安装依赖..."
  pnpm install --frozen-lockfile

  echo "构建..."
  pnpm build || die "构建失败"

  echo "打包构建产物..."
  LC_ALL=C tar czf "$TARBALL" -C "$REPO_ROOT" \
    --exclude='*.png' \
    --exclude='*.map' \
    out/ dist/

  local size
  size=$(du -h "$TARBALL" | cut -f1)
  green "构建完成：${TARBALL}（${size}）"
}

# ── 子命令：上传到 OSS ──────────────────────────────────────────────────────────

do_upload() {
  green "=== 2. 上传到 OSS ==="

  aliyun oss cp "$TARBALL" "${OSS_BUCKET}/${OSS_OBJECT}" \
    -e "$OSS_ENDPOINT" -f || die "上传 OSS 失败"

  local url
  url=$(aliyun oss sign "${OSS_BUCKET}/${OSS_OBJECT}" \
    -e "$OSS_ENDPOINT" --timeout "$SIGNED_URL_TIMEOUT" 2>/dev/null \
    | grep -E '^https?://' \
    | tail -1)

  if [ -z "$url" ]; then
    die "生成签名 URL 失败"
  fi

  echo "$url"
  green "上传完成"
}

# ── 子命令：ECS 端部署 ──────────────────────────────────────────────────────────

do_deploy() {
  local download_url="$1"
  green "=== 3. 部署到 ECS ==="

  # 脚本在 ECS 上执行，需要自包含
  ecs_run "下载并部署" "
set -e
cd $SERVICE_DIR

# 下载更新包（URL 写文件避免 shell 转义问题）
echo '[deploy] downloading...'
printf '%s' '$download_url' > /tmp/deploy-url.txt
curl -fsSL -o /tmp/deploy.tar.gz \"\$(cat /tmp/deploy-url.txt)\" || {
  echo '[deploy] download failed'
  exit 1
}
rm -f /tmp/deploy-url.txt
# 停止服务
echo '[deploy] stopping server...'
ALL_PIDS=\$(pgrep -f 'node out/server/index.js' 2>/dev/null || true)
if [ -n \"\$ALL_PIDS\" ]; then
  echo \"[deploy] killing PIDs: \$ALL_PIDS\"
  kill -TERM \$ALL_PIDS 2>/dev/null || true
  # 等端口释放
  for i in 1 2 3 4 5 6 7 8; do
    sleep 1
    ss -tlnp 2>/dev/null | grep -q ':$SERVICE_PORT' || { echo \"[deploy] port free after \${i}s\"; break; }
  done
  # force-kill 漏网的
  for pid in \$ALL_PIDS; do
    kill -0 \$pid 2>/dev/null && kill -9 \$pid 2>/dev/null || true
  done
fi

# 提取更新包
echo '[deploy] extracting...'
tar xzf /tmp/deploy.tar.gz
rm -f /tmp/deploy.tar.gz

# 清理不用的源文件（如果打包误带了）
rm -rf src/ tests/ 2>/dev/null || true

# 启动服务
echo '[deploy] starting server...'
set -a && . ./.env && set +a
nohup setsid node out/server/index.js > server.log 2>&1 < /dev/null & disown

# 等端口起来
for i in 1 2 3 4 5 6 7 8; do
  sleep 1
  ss -tlnp 2>/dev/null | grep -q ':$SERVICE_PORT' && { echo \"[deploy] server up after \${i}s\"; break; }
done

# 清理 orphan（如果有残留旧进程）
CURRENT_PID=\$(ss -tlnp 2>/dev/null | grep ':$SERVICE_PORT' | grep -oE 'pid=[0-9]+' | cut -d= -f2)
if [ -n \"\$CURRENT_PID\" ]; then
  for pid in \$(pgrep -f 'node out/server/index.js' 2>/dev/null || true); do
    if [ \"\$pid\" != \"\$CURRENT_PID\" ]; then
      echo \"[deploy] killing orphan PID \$pid\"
      kill -9 \$pid 2>/dev/null || true
    fi
  done
fi

# 健康检查
echo '[deploy] health check...'
sleep 2
curl -sS http://127.0.0.1:$SERVICE_PORT/api/health || {
  echo '[deploy] WARNING: health check failed, checking log tail...'
  tail -20 server.log
}
" 120
}

# ── 子命令：仅重启 ──────────────────────────────────────────────────────────────

do_restart() {
  green "=== 重启线上服务 ==="

  ecs_run "重启服务" "
set -e
cd $SERVICE_DIR

echo '[restart] stopping...'
ALL_PIDS=\$(pgrep -f 'node out/server/index.js' 2>/dev/null || true)
if [ -n \"\$ALL_PIDS\" ]; then
  kill -TERM \$ALL_PIDS 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8; do
    sleep 1
    ss -tlnp 2>/dev/null | grep -q ':$SERVICE_PORT' || { echo \"[restart] port free after \${i}s\"; break; }
  done
  for pid in \$ALL_PIDS; do
    kill -0 \$pid 2>/dev/null && kill -9 \$pid 2>/dev/null || true
  done
fi

echo '[restart] starting...'
set -a && . ./.env && set +a
nohup setsid node out/server/index.js > server.log 2>&1 < /dev/null & disown

for i in 1 2 3 4 5 6 7 8; do
  sleep 1
  ss -tlnp 2>/dev/null | grep -q ':$SERVICE_PORT' && { echo \"[restart] up after \${i}s\"; break; }
done

sleep 2
curl -sS http://127.0.0.1:$SERVICE_PORT/api/health
" 60
}

# ── 子命令：查看状态 ────────────────────────────────────────────────────────────

do_status() {
  green "=== 线上状态 ==="

  ecs_run "查询状态" "
echo '=== 进程 ==='
ps -ef --forest | grep -E 'node.*server' | grep -v grep || echo '(无 server 进程)'
echo ''
echo '=== 端口 ==='
ss -tlnp | grep ':$SERVICE_PORT' || echo '(端口未监听)'
echo ''
echo '=== 健康检查 ==='
curl -sS http://127.0.0.1:$SERVICE_PORT/api/health 2>/dev/null || echo '(无法连接)'
echo ''
echo '=== 最近日志 ==='
tail -10 server.log 2>/dev/null || echo '(无日志)'
echo ''
echo '=== 磁盘 ==='
df -h "$SERVICE_DIR" | tail -1
" 30
}

# ── 主流程 ──────────────────────────────────────────────────────────────────────

main() {
  local mode="${1:-deploy}"

  case "$mode" in
    --dry-run)
      do_build
      green "Dry run 完成，Tarball 在 ${TARBALL}"
      ;;

    --restart)
      do_restart
      ;;

    --status)
      do_status
      ;;

    --check-config)
      green "本地运维配置校验通过：${OPS_ENV_FILE}"
      ;;

    deploy|--deploy|"")
      do_build
      local url
      url=$(do_upload | grep -E '^https?://' | tail -1 || true)
      if [ -z "$url" ]; then
        die "未能从上传输出中提取签名 URL"
      fi
      do_deploy "$url"
      green "=== 部署完成 ==="
      echo ""
      do_status
      ;;

    *)
      echo "用法: $0 [--dry-run|--restart|--status|--check-config]"
      echo ""
      echo "  (无参数)    完整部署：构建 → 上传 → 部署"
      echo "  --dry-run   只构建，不上传/部署"
      echo "  --restart   仅重启线上服务"
      echo "  --status    查看线上状态"
      echo "  --check-config  仅校验本地私密配置"
      exit 1
      ;;
  esac
}

main "$@"
