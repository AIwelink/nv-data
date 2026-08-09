#!/usr/bin/env bash
# nvt-monitor 一键部署脚本（Ubuntu/Debian 服务器）
# 用法：在 clone 下来的 nvt-monitor 目录里执行  bash deploy.sh
# 作用：检查/安装 Node 18+ → 安装依赖 → 生成 .env → pm2 常驻 + 开机自启
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
say()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $*"; }
die()  { echo -e "${RED}[deploy]${NC} $*"; exit 1; }

cd "$(dirname "$0")"

# ---------- 1. Node.js 18+ ----------
command -v node >/dev/null 2>&1 || { say "未检测到 Node.js，开始安装…"; apt-get update -y && apt-get install -y nodejs npm || die "安装 nodejs/npm 失败，请手动安装 Node 18+"; }
NODE_MAJOR=$(node -e "console.log(Number(process.versions.node.split('.')[0]))")
[ "${NODE_MAJOR:-0}" -ge 18 ] || die "Node 版本过低：$(node -v)，需要 18+（建议用 nodesource 安装 Node 20）"
say "Node $(node -v) OK"

# ---------- 2. 安装依赖（跳过 devDependencies，playwright 只在本机用） ----------
command -v npm >/dev/null 2>&1 || die "未找到 npm"
say "安装依赖（--omit=dev）…"
npm install --omit=dev || die "npm install 失败"

# ---------- 3. 生成 .env（不覆盖已有配置） ----------
if [ ! -f .env ]; then
  cp .env.example .env
  warn "已生成 .env，请编辑填写："
  warn "  WEB_PASSWORD=<看板访问口令>"
  warn "  NVT_COOKIE=<scm_session 的 cookie 值>  ← 本机刷新 cookie 后填到这里"
  warn "  海外服务器通常直连可通；若需代理再填 PROXY=..."
  die "请先编辑 .env 后再运行本脚本"
fi

# ---------- 4. pm2 常驻 ----------
command -v pm2 >/dev/null 2>&1 || { say "安装 pm2…"; npm install -g pm2 || die "安装 pm2 失败"; }

say "启动服务（pm2）…"
pm2 delete nvt-monitor >/dev/null 2>&1 || true
pm2 start server.js --name nvt-monitor || die "pm2 start 失败"
pm2 save || warn "pm2 save 失败"
pm2 startup 2>/dev/null | tail -n 1 | bash 2>/dev/null || warn "开机自启设置失败，可稍后手动执行：pm2 startup"

PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo 3000)
say "部署完成：http://<服务器IP>:${PORT}"
pm2 status nvt-monitor

# ---------- 5. 自检 ----------
say "等待服务启动并自检…"
sleep 3
if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  say "健康检查通过 ✓"
else
  warn "健康检查未通过，请查看日志：pm2 logs nvt-monitor"
fi
