#!/usr/bin/env bash
# 远程执行器：读取 /tmp/rc.txt 内容作为远程命令，密码从 server.env 读取并注入 expect，不回显。
set -u
cd "$(dirname "$0")/.." || exit 1
HOSTIP="$(grep -E '^Serverip=' server.env | cut -d= -f2-)"
HOSTPORT="$(grep -E '^Serverport=' server.env | cut -d= -f2-)"
USERNAME="$(grep -E '^name=' server.env | cut -d= -f2-)"
PASS="$(grep -E '^passwd=' server.env | cut -d= -f2-)"
CMD="$(cat /tmp/rc.txt)"
export HOSTIP HOSTPORT USERNAME PASS CMD
exec expect -c '
set timeout 120
set ip $env(HOSTIP); set port $env(HOSTPORT); set user $env(USERNAME); set pw $env(PASS); set cmd $env(CMD)
spawn ssh -p $port -o StrictHostKeyChecking=accept-new "$user@$ip" "$cmd"
expect {
  -re "(?i)password:" { send -- "$pw\r"; exp_continue }
  -re "(?i)yes/no" { send -- "yes\r"; exp_continue }
  eof
}
'
