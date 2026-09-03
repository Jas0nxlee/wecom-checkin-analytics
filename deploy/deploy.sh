#!/usr/bin/env bash
# 企业微信打卡分析看板 —— 一键打包并部署到内网 Docker 服务器
# 用法：bash deploy/deploy.sh            # 上传 + 构建 + 启动
#       bash deploy/deploy.sh --no-build # 仅上传源码与数据
#       bash deploy/deploy.sh --force    # 不检查端口占用，直接部署
#
# 部署目录：/opt/wecom-checkin-analytics/（与服务器上其他服务完全隔离）
# 密码从 server.env 读取，所有 expect 交互不回显、不打印到本脚本输出。
set -u
cd "$(dirname "$0")/.."   # 定位到项目根目录

HOSTIP="$(grep -E '^Serverip=' server.env | cut -d= -f2-)"
HOSTPORT="$(grep -E '^Serverport=' server.env | cut -d= -f2-)"
USERNAME="$(grep -E '^name=' server.env | cut -d= -f2-)"
PASS="$(grep -E '^passwd=' server.env | cut -d= -f2-)"
REMOTE_ROOT="/opt/wecom-checkin-analytics"

[ -n "$HOSTIP" ] || { echo "错误：server.env 缺少 Serverip"; exit 1; }
[ -n "$HOSTPORT" ] || HOSTPORT=22
[ -n "$USERNAME" ] || USERNAME=root
[ -n "$PASS" ] || { echo "错误：server.env 缺少 passwd"; exit 1; }

# 本机源码要同步的内容（不含 .git、__pycache__、data 大文件单独处理）
SRC_TIMESTAMP="$(date +%Y%m%d%H%M%S)"
WORK="$(mktemp -d)"
TARBALL="$WORK/deploy-${SRC_TIMESTAMP}.tar.gz"

echo "==> 1/5 打包源码与配置……"
tar --exclude='./.git' --exclude='./__pycache__' --exclude='./deploy' \
    --exclude='./tests' --exclude='./docs' --exclude='./__ui_test' \
    --exclude='./*.log' --exclude='./server.env' \
    -czf "$TARBALL" \
    server.py fetch_checkin.py checkin_policy.py \
    Dockerfile .dockerignore docker-compose.yml \
    web tools data config.json 2>/dev/null || true
ls -lh "$TARBALL"

# expect 驱动的 scp：密码从环境变量传入，不打印
echo "==> 2/5 上传 tarball 到服务器……"
export HOSTIP HOSTPORT USERNAME PASS TARBALL REMOTE_ROOT
expect <<'EXPECT_EOF'
set timeout 1800
set ip $env(HOSTIP); set port $env(HOSTPORT); set user $env(USERNAME)
set pw $env(PASS); set tarball $env(TARBALL); set remote $env(REMOTE_ROOT)
spawn scp -P $port -o StrictHostKeyChecking=accept-new "$tarball" "$user@$ip:/tmp/wecom-deploy.tar.gz"
expect {
  -re "(?i)password:" { send -- "$pw\r"; exp_continue }
  -re "(?i)yes/no" { send -- "yes\r"; exp_continue }
  eof
}
EXPECT_EOF
[ ${PIPESTATUS[0]:-0} -eq 0 ] || { echo "scp 失败"; exit 1; }

# 解压到远程隔离目录
echo "==> 3/5 远程解压到 $REMOTE_ROOT ……"
export HOSTIP HOSTPORT USERNAME PASS REMOTE_ROOT
expect <<'EXPECT_EOF'
set timeout 600
set ip $env(HOSTIP); set port $env(HOSTPORT); set user $env(USERNAME)
set pw $env(PASS); set remote $env(REMOTE_ROOT)
set cmd "set -e; mkdir -p $remote; rm -rf $remote/*; tar -xzf /tmp/wecom-deploy.tar.gz -C $remote; rm -f /tmp/wecom-deploy.tar.gz; ls -la $remote"
spawn ssh -p $port -o StrictHostKeyChecking=accept-new "$user@$ip" "$cmd"
expect {
  -re "(?i)password:" { send -- "$pw\r"; exp_continue }
  -re "(?i)yes/no" { send -- "yes\r"; exp_continue }
  eof
}
EXPECT_EOF

# 可选 --no-build：仅上传
if [ "${1:-}" = "--no-build" ]; then
  echo "==> 跳过构建（--no-build）。已上传源码到 $REMOTE_ROOT。"
  rm -rf "$WORK"
  exit 0
fi

# 端口占用检查（非强制时）
if [ "${1:-}" != "--force" ]; then
  echo "==> 4/5 检查端口 8787 是否被占用……"
  export HOSTIP HOSTPORT USERNAME PASS REMOTE_ROOT
  BIND=$(expect <<'EXPECT_EOF' 2>/dev/null
set timeout 60
set ip $env(HOSTIP); set port $env(HOSTPORT); set user $env(USERNAME)
set pw $env(PASS)
set cmd "(ss -ltn 2>/dev/null | grep -E ':8787 ') || echo FREE"
spawn ssh -p $port -o StrictHostKeyChecking=accept-new "$user@$ip" "$cmd"
expect {
  -re "(?i)password:" { send -- "$pw\r"; exp_continue }
  -re "(?i)yes/no" { send -- "yes\r"; exp_continue }
  eof
}
EXPECT_EOF
)
  if echo "$BIND" | grep -q "FREE"; then
    echo "    端口 8787 空闲，继续。"
  else
    echo "    端口 8787 已被占用，终止以免抢占现有服务。用 --force 可覆盖。"
    rm -rf "$WORK"
    exit 2
  fi
fi

echo "==> 5/5 远程构建并启动容器……"
export HOSTIP HOSTPORT USERNAME PASS REMOTE_ROOT
expect <<'EXPECT_EOF'
set timeout 1800
set ip $env(HOSTIP); set port $env(HOSTPORT); set user $env(USERNAME)
set pw $env(PASS); set remote $env(REMOTE_ROOT)
set cmd "cd $remote && docker compose build && docker compose up -d"
spawn ssh -p $port -o StrictHostKeyChecking=accept-new "$user@$ip" "$cmd"
expect {
  -re "(?i)password:" { send -- "$pw\r"; exp_continue }
  -re "(?i)yes/no" { send -- "yes\r"; exp_continue }
  -re "(?i)error|失败|exit" { }
  eof
}
EXPECT_EOF

rm -rf "$WORK"
echo "==> 完成。"
echo "    看板地址： http://${HOSTIP}:8787"
