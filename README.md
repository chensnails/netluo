# 络图 NetLuo

网络拓扑与 Markdown 文档协作平台：自托管 drawio 画布 + 所见即所得 Markdown 编辑器，
带文件树、版本历史、编辑锁、只读分享链接、实例内多用户与双色主题。
单进程 Fastify + SQLite，不依赖任何外部服务，每个团队自建一套。

## 部署方式一：Docker 一键脚本（推荐）

目标机只需要 Docker，不需要 Node、不需要克隆源码：

```bash
curl -fsSL https://raw.githubusercontent.com/chensnails/netluo/main/install.sh | sudo bash
```

脚本会拉镜像、起服务、等健康检查通过，最后打印访问地址与 admin 密码。装完打开
`http://<主机>:3090`，drawio 画布在 `3091`。

带参数时先把脚本下到本地（管道方式传不了参数）：

```bash
curl -fo install.sh https://raw.githubusercontent.com/chensnails/netluo/main/install.sh
sudo bash install.sh --drawio http://192.168.1.20:3091 --version 1.2.0 --password '你的密码'
sudo bash install.sh --help     # 目录/端口/密码/不起 drawio 等选项
```

`--drawio` 是唯一需要留意的参数：它必须是**用户浏览器**能访问到的地址，填 `127.0.0.1`
会导致别人打不开画布。省略时脚本用首个网卡 IP 猜一个，装完可以再改。
已装过再跑一次即为升级，数据卷不动。

不想用脚本就手工两步（脚本做的也就是这些）：

```bash
mkdir -p /opt/netluo && cd /opt/netluo
curl -fo docker-compose.yml https://raw.githubusercontent.com/chensnails/netluo/main/topo/docker-compose.yml
cp /dev/null .env && chmod 600 .env        # 一行配置都不写也能起来，见下面的环境变量表
docker compose pull && docker compose up -d
docker exec netluo cat /data/admin-password   # 没设 ADMIN_PASSWORD 时取自动生成的密码
```

镜像包是 public，匿名拉取不需要登录。若你遇到 `denied`（例如在自己的仓库里重建，包继承成了私有），
两条退路。一是登录 registry 后再拉：

```bash
echo "<github 细粒度 PAT，可读 packages>" | docker login ghcr.io -u <GitHub 账号> --password-stdin
```

二是不用镜像、直接源码构建（需要 Docker，不需要 Node，schema 迁移与自检逻辑完全一样）：

```bash
git clone https://github.com/chensnails/netluo.git && cd netluo/topo
cp .env.example .env && docker compose up -d --build
```

## 部署方式二：单文件二进制

从 [Releases](https://github.com/chensnails/netluo/releases) 下载对应平台的文件和 `SHA256SUMS.txt`：

```bash
sha256sum -c SHA256SUMS.txt
chmod +x netluo-*-linux-x64
export DRAWIO_URL='http://your-host:3091'
export TOPO_DB=/var/lib/netluo/topo.db
./netluo-*-linux-x64 --smoke      # 自检：静态资源/鉴权/写链路/多用户/备份全跑一遍
./netluo-*-linux-x64              # 首次启动会生成密钥与随机管理员密码，写在 TOPO_DB 同目录
```

令牌密钥与管理员密码都不要求提供（见下面的环境变量表），所以最短路径就是上面四行。
二进制自带 Node 运行时、原生 SQLite 模块与前端资源，首次启动释放到用户缓存目录
（`TOPO_RUNTIME_DIR` 可指定）。目标机不需要装 Node。systemd 单元示例：

```ini
[Unit]
Description=NetLuo
After=network.target

[Service]
EnvironmentFile=/etc/netluo/netluo.env
ExecStart=/opt/netluo/netluo-v1.2.0-linux-x64
Restart=always
User=netluo

[Install]
WantedBy=multi-user.target
```

## 环境变量

只有 `DRAWIO_URL` 一项是真正要想的，其余留空都能起来：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DRAWIO_URL` | 是 | 浏览器能访问到的 drawio 地址，同时用于 CSP `frame-src`；填 127.0.0.1 别人打不开画布 |
| `ADMIN_PASSWORD` | 否 | 仅当库里没有任何用户时用来建 admin，之后改它无效；**留空则生成随机密码**写入 `TOPO_DB` 同目录的 `admin-password`（日志只给路径），读完建议删除 |
| `TOPO_SECRET` | 否 | 令牌签名密钥，至少 16 字符；**留空则生成随机值**并持久化为同目录的 `token.secret`，重启/升级不踢在线用户。跨实例搬迁时把这个文件一起搬走 |
| `REGISTRATION_CODE` | 否 | 非空即开放自助注册，值就是注册口令；留空则只有管理员能建号 |
| `TRUST_PROXY` | 否 | 反代后设为 `1`（同机代理可用 `loopback`），否则限速把所有访客算作同一个 IP |
| `TOPO_DB` | 否 | SQLite 路径，默认 `./topo-dev.db`；容器内 `/data/topo.db` |
| `TOPO_BACKUP_ON_MIGRATE` | 否 | 结构迁移前自动快照，默认开；`0` 关闭 |
| `PORT` | 否 | 监听端口，默认 3000 |
| `NODE_OPTIONS` | 否 | 建议 `--max-old-space-size=224` |
| `NETLUO_VERSION` | 仅 compose | 镜像标签，如 `1` / `1.2` / `1.2.0` / `latest` |

## 反向代理与 HTTPS

对外提供服务的实例应挂 HTTPS：会话 cookie 在识别到 https 时自动加 `Secure`，
`TRUST_PROXY=1` 让限速按真实客户端 IP 分桶。nginx 示例：

```nginx
server {
  listen 443 ssl http2;
  server_name topo.example.com;
  ssl_certificate     /etc/ssl/fullchain.pem;
  ssl_certificate_key /etc/ssl/privkey.pem;
  client_max_body_size 16m;            # 服务端请求体上限 12MB，留点余量

  location / {
    proxy_pass http://127.0.0.1:3090;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;   # 缺这行 Secure cookie 不生效
  }
}
```

对应 `.env`：`TRUST_PROXY=1`，`DRAWIO_URL` 填浏览器实际访问的地址。

## 多用户

- 首个账号是 `admin`（由 `ADMIN_PASSWORD` 初始化，没给就用数据目录里 `admin-password` 文件的随机密码）。
  管理员在「设置 → 成员」里建号、改角色、
  停用、重置密码、删除成员；停用或改密会立即让对方已登录的会话失效。
- 默认不开放注册。要开放就在 `.env` 里设 `REGISTRATION_CODE`，登录页出现注册入口，
  新注册账号一律是普通用户。
- 删除成员要求键入其用户名二次确认，且会连带删除其文件与分享；不能删自己，也不能删到只剩零个管理员。
- 管理员可在「设置 → 成员 → 整库备份」下载一致性 SQLite 快照。

## 升级 / 回滚 / 备份

**升级**（Docker）：重跑一次 `sudo bash install.sh --version 1.2` 即可；或者 `.env` 里改
`NETLUO_VERSION=1.2`，然后

```bash
docker compose pull && docker compose up -d
```

结构变更由内置迁移按版本号顺序执行，每次启动自动完成；库里已有数据时，迁移前会在
`TOPO_DB` 同目录留下 `topo.db.premigration-v<旧版本>-<时间戳>.db` 快照。
二进制：下载新版文件替换 `ExecStart` 路径后重启即可。

**回滚**：把 `NETLUO_VERSION`（或二进制）换回旧版本再启动。已执行过的迁移不会倒退，
需要回滚到迁移前状态时，停服并用迁移快照覆盖 `TOPO_DB`。注意 1.2.0 之前的镜像标签
（`1.1`、`1.1.1`）随仓库重建已不存在，最早只能回滚到 `1.2`。

**备份**：停服后直接复制 `TOPO_DB`（连同 `-wal`/`-shm`），或在线用
`sqlite3 topo.db "PRAGMA wal_checkpoint(TRUNCATE)"` 回收 WAL 后拷单文件；
也可用设置页/接口的整库备份。跨实例迁移用平台自带的 zip 导出（设置页 → 存储与统计），
含所有文件与历史版本。

## 本地开发

```bash
git clone https://github.com/chensnails/netluo.git && cd netluo/topo/server
npm install            # 拉 better-sqlite3 预编译模块
npm run vendor         # 生成 public/vendor 与 .gz
npm run dev            # 源码运行，--watch 自动重启
```

打开 `http://127.0.0.1:3000`，用本地临时库 `topo-dev.db`，不碰线上数据。

装了 Docker 但不想每次重建镜像，用开发覆盖层跑容器内热重载（注意别挂 `node_modules`，
容器里那份是 linux 原生模块）：

```bash
cd topo
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

## 校验与构建

```bash
npm run smoke          # 冒烟自检（临时库，静态/鉴权/写链路/多用户/备份）
npm run test:migrate   # 迁移测试：全新库与 1.0.0 旧库两条路径
npm run build:sea      # 当前平台单文件二进制到 dist/
node build/sea.mjs --targets=win-x64,linux-x64,linux-arm64
```

交叉构建会下载对应平台的 Node 发行包与 better-sqlite3 预编译模块
（缓存在 `~/.cache/netluo-sea`），Windows 上需要系统自带的 `tar.exe`。

正式产物由 GitHub Actions 构建：PR 与 `main` 的推送跑 `ci.yml`
（依赖安装 → 冒烟 → 迁移测试 → 镜像内自检），打 `v*` 标签跑 `release.yml`
（三平台二进制 + 多架构镜像推 GHCR + 自动建 Release，说明取自 `CHANGELOG.md`）。

发版只需要一条命令——它会检查干净的工作树、打标签、推送，并等流水线跑完回报地址：

```bash
cd topo/server
GH_TOKEN=... node build/publish.mjs --version=v1.2.0 --wait
```

## 目录结构

```
install.sh                    一键安装/升级脚本（只需要 Docker）
topo/
  docker-compose.yml        生产：拉 GHCR 镜像，透传环境变量
  docker-compose.dev.yml    开发覆盖层：容器内挂源码热重载
  server/
    src/                    后端（Fastify + better-sqlite3）
    public/                 前端页面（原生 JS）
    build/vendor.mjs        从 node_modules 生成 public/vendor 并预压缩
    build/sea.mjs           单文件二进制构建（Node SEA）
    build/publish.mjs       打标签、推送、等 CI 并回报
    build/test-migration.mjs 迁移与快照回归测试
    Dockerfile              多阶段、非 root、自带健康检查
.github/workflows/          CI 冒烟 + tag 发版
CHANGELOG.md                版本说明，Release 正文取自这里
```
