#!/usr/bin/env bash
# 络图 NetLuo 一键安装（只需要 Docker，不需要 Node、不需要克隆源码）
#
#   curl -fsSL https://raw.githubusercontent.com/chensnails/netluo/main/install.sh | sudo bash
#
# 带参数就要落成文件再跑（管道方式没法传参）：
#   curl -fo install.sh https://raw.githubusercontent.com/chensnails/netluo/main/install.sh
#   sudo bash install.sh --password 'xxx'
#
# 默认零配置：画布由主站同源转发（本站 /drawio/），反向代理只需要转发主站一个端口。
# 画布确实放在别处时才加 --drawio http(s)://<对外地址>。
#
# 已装过再跑一次即为升级：会重新拉镜像并原地重启，数据卷不动。
set -euo pipefail

RAW="https://raw.githubusercontent.com/chensnails/netluo/main"
DIR=/opt/netluo
PORT=3090
VERSION=1
DRAWIO_URL=""
ADMIN_PASSWORD=""
NO_DRAWIO=0

say() { printf '\033[1;36m[netluo]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[netluo]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[netluo]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法：install.sh [选项]
  -d, --dir <路径>      安装目录，默认 /opt/netluo
  -p, --port <端口>     络图监听端口，默认 3090
  -v, --version <标签>  镜像标签（1 / 1.3 / 1.3.1 / latest），默认 1
      --drawio <URL>    改用外部 drawio 地址（浏览器可达）；默认不填，由主站同源转发 /drawio/
  -w, --password <密码> 管理员密码；不给且在终端里会交互询问，非交互则自动生成
      --no-drawio       不起 drawio 容器（只用 Markdown 时省 768MB，需配 --drawio 自备地址）
  -h, --help            显示本帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -d|--dir) DIR=$2; shift 2 ;;
    -p|--port) PORT=$2; shift 2 ;;
    -v|--version) VERSION=$2; shift 2 ;;
    --drawio) DRAWIO_URL=$2; shift 2 ;;
    -w|--password) ADMIN_PASSWORD=$2; shift 2 ;;
    --no-drawio) NO_DRAWIO=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（install.sh --help 看用法）" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "没找到 docker。安装：curl -fsSL https://get.docker.com | sudo sh"
docker info >/dev/null 2>&1 || die "当前用户连不上 docker daemon，请用 sudo 运行或把用户加进 docker 组"
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else die "缺 compose 插件：装 docker-compose-plugin（或 docker-compose）后重试"; fi

# compose 文件：脚本旁边有就用本地的（源码仓库里跑），否则从 raw 下载
mkdir -p "$DIR"
cd "$DIR"
if [ -f topo/docker-compose.yml ]; then
  cp topo/docker-compose.yml docker-compose.yml
else
  curl -fsSfo docker-compose.yml "$RAW/topo/docker-compose.yml" \
    || die "下载 docker-compose.yml 失败，检查这台机器能否访问 raw.githubusercontent.com"
fi

HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
# 默认不设 DRAWIO_URL：主站把画布转发在同源 /drawio/ 下，反代只需一个端口。
# --no-drawio 时不建画布容器，必须自备外部地址，否则会把 .env 里原有的外部地址清掉导致画布全瞎。
if [ -z "$DRAWIO_URL" ] && [ "$NO_DRAWIO" = 1 ] && [ -f .env ]; then
  DRAWIO_URL=$(grep '^DRAWIO_URL=' .env | head -1 | cut -d= -f2-)
  [ -n "$DRAWIO_URL" ] || die "--no-drawio 需要自备画布：install.sh --drawio http://<对外地址>[:端口]"
fi
[ -n "$ADMIN_PASSWORD" ] || [ ! -t 0 ] || read -rsp "设置 admin 登录密码（留空则自动生成并打印）：" ADMIN_PASSWORD; echo

if [ -f .env ]; then
  say "已存在 $DIR/.env，沿用其中的配置（版本/端口按本次参数更新）"
  for kv in "DRAWIO_URL=$DRAWIO_URL" "PORT=$PORT" "NETLUO_VERSION=$VERSION"; do
    k=${kv%%=*}
    grep -q "^$k=" .env || echo "$kv" >> .env
  done
  sed -i "s|^NETLUO_VERSION=.*|NETLUO_VERSION=$VERSION|; s|^DRAWIO_URL=.*|DRAWIO_URL=$DRAWIO_URL|; s|^PORT=.*|PORT=$PORT|" .env
else
  # TOPO_SECRET 留空即可：服务端会生成随机密钥并持久化到数据卷，重启不会踢掉登录态
  cat > .env <<EOF
ADMIN_PASSWORD=$ADMIN_PASSWORD
TOPO_SECRET=
DRAWIO_URL=$DRAWIO_URL
NETLUO_VERSION=$VERSION
PORT=$PORT
EOF
  chmod 600 .env
  say "已生成 $DIR/.env"
fi

say "拉取镜像 ghcr.io/chensnails/netluo-app:$VERSION …"
if [ "$NO_DRAWIO" = 1 ]; then
  $DC pull topo && $DC up -d --remove-orphans topo
else
  $DC pull && $DC up -d --remove-orphans
fi

say "等待服务就绪…"
ready=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { $DC logs --tail 50 topo; die "服务没起来，上面是最后 50 行日志"; }

if [ -z "$ADMIN_PASSWORD" ]; then
  # 服务端首次初始化时随机生成了密码，落在数据卷里；取出来交给终端，然后删掉文件
  ADMIN_PASSWORD=$(docker exec netluo cat /data/admin-password 2>/dev/null || true)
  docker exec netluo rm -f /data/admin-password 2>/dev/null || true
fi

cat <<EOF

$(say '装好了')
  访问地址   http://${HOST_IP:-<本机IP>}:$PORT        账号 admin
  画布       ${DRAWIO_URL:-本站同源 /drawio/（内置转发，反代只需这一个端口）}
$( [ -n "$ADMIN_PASSWORD" ] && printf '  密码       %s   ← 只显示这一次，登录后请去「设置」改密\n' "$ADMIN_PASSWORD" )
  数据       docker volume inspect netluo_topo-data
  日志       cd $DIR && $DC logs -f topo
  升级       sudo bash install.sh --version <新版本号>   （或改 .env 的 NETLUO_VERSION 后 $DC pull && $DC up -d）
EOF

# 实测一下画布是否真的能经本站取到：502 = 上游容器没起来或地址配错，比让用户在浏览器里对着白屏猜有用
canvas_code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/drawio/" 2>/dev/null || echo 000)
if [ -n "$DRAWIO_URL" ]; then
  warn "本次用的是外部画布地址 $DRAWIO_URL：若本站是 https，它也必须 https，否则浏览器按混合内容拦掉。"
elif [ "$canvas_code" = 502 ] || [ "$canvas_code" = 000 ]; then
  warn "画布容器没应答（HTTP $canvas_code）。用 $DC ps && $DC logs --tail 30 drawio 看它起没起来；只用 Markdown 可以忽略。"
elif [ "$canvas_code" != 200 ] && [ "$canvas_code" != 302 ] && [ "$canvas_code" != 304 ]; then
  warn "画布转发返回 HTTP $canvas_code，画布可能打不开；确认 drawio 容器健康后重跑本脚本。"
fi
