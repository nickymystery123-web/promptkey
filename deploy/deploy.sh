#!/usr/bin/env bash
# PromptKey Float — 阿里云演示部署脚本（自动识别 Ubuntu/Debian 或 CentOS/Alibaba Cloud Linux）
# 用法：项目已上传到 /opt/promptkey 后，在服务器上执行：
#   bash /opt/promptkey/deploy/deploy.sh
# 前提：/opt/promptkey/.env 已填 AI_API_KEY（HOST 会被本脚本自动改为 0.0.0.0）
set -euo pipefail

APP_DIR="/opt/promptkey"
SERVICE="promptkey"
PORT="${PORT:-8787}"

echo "==> [0/5] 识别系统"
if [ -f /etc/os-release ]; then
  . /etc/os-release
  echo "    系统：${PRETTY_NAME:-$NAME}"
else
  echo "    无法识别系统，继续尝试自动适配"
fi

echo "==> [1/5] 检查/安装 Node 22"
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v | sed 's/v\([0-9]*\)\..*/\1/')"
  echo "    已安装 Node $(node -v)"
  if [ "$NODE_VER" -lt 20 ]; then
    echo "    !! Node 版本 < 20，请升级到 22 后重跑（本项目使用原生 ESM + fetch）"
    exit 1
  fi
else
  echo "    Node 未安装，开始安装..."
  if command -v apt-get >/dev/null 2>&1; then
    # Ubuntu / Debian
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    # CentOS 8+ / Alibaba Cloud Linux 3 / Rocky
    dnf module install -y nodejs:22/common || dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    # CentOS 7
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    yum install -y nodejs
  else
    echo "    !! 未找到 apt/dnf/yum，请手动安装 Node 22 后重跑"
    exit 1
  fi
fi
NODE_BIN="$(command -v node)"
echo "    Node 路径：${NODE_BIN}"

echo "==> [2/5] 校验项目与 .env"
if [ ! -f "$APP_DIR/server/server.js" ]; then
  echo "    !! 未找到 $APP_DIR/server/server.js，请先上传项目到 $APP_DIR"
  exit 1
fi
if [ ! -f "$APP_DIR/.env" ]; then
  echo "    !! 未找到 .env，请先创建：cp .env.template .env 并填写 AI_API_KEY / AI_MODE=real"
  exit 1
fi
if grep -q '^HOST=' "$APP_DIR/.env"; then
  sed -i 's/^HOST=.*/HOST=0.0.0.0/' "$APP_DIR/.env"
else
  printf '\nHOST=0.0.0.0\n' >> "$APP_DIR/.env"
fi
echo "    .env HOST 已设为 0.0.0.0"

echo "==> [3/5] 创建 systemd 服务（开机自启 + 崩溃自动重启）"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=PromptKey Float
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} server/server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE"

echo "==> [4/5] 状态检查"
sleep 1
systemctl status "$SERVICE" --no-pager || true

echo "==> [5/5] 完成"
PUBLIC_IP="$(curl -s --max-time 5 ifconfig.me || curl -s --max-time 5 icanhazip.com || echo '<你的公网IP>')"
echo ""
echo "=============================================="
echo "  部署完成！"
echo "  访问链接：http://${PUBLIC_IP}:${PORT}/"
echo "  （需在阿里云安全组放行 TCP ${PORT} 端口）"
echo "=============================================="
echo "  查看日志：journalctl -u ${SERVICE} -f"
echo "  重启服务：systemctl restart ${SERVICE}"
echo "  停止服务：systemctl stop ${SERVICE}"
