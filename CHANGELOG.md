# 更新日志

遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.3.1]

### 修复
- **Windows 与 arm64 单文件二进制首启即崩**（`1.2.0` 起受影响，`1.3.0` 实测抓出）：跨平台打包时 `better_sqlite3.node` 没能进内嵌资源——构建脚本按「源目录里那份 .node 是否等于目标那份」来筛选，而跨平台构建时源目录里躺着的是别的平台的文件（甚至已被换走），于是被整个跳过，产物在目标机首次启动就报找不到原生模块。本机目标（CI 上的 linux-x64）走的正是「相等」那条路，所以流水线一直是绿的。现在改为按 `bindings` 期待的路径显式写入目标平台那一份，并在暂存完成后立即校验文件存在且魔数与目标平台一致，不满足就拒绝出包。

### 新增
- **发版前排掉这个雷的三道检查**：CI 每次推送都现做一个非本机目标的单文件构建（只验内嵌资源，不发布）；Release 流水线新增 `win-x64`（windows 运行器）与 `linux-arm64`（qemu 用户态）两个真跑 `--smoke` 的实测 job，跑不过就不建 Release。以前这两类产物只比对了 sha256 就发布，而校验和一致并不能证明跑得起来。

## [1.3.0]

### 新增
- **内置同源画布转发，反代只需要一个端口**：主进程把 drawio 挂在本站 `/drawio/` 下转发（`src/drawio-proxy.js`），`DRAWIO_URL` 从此可以不填。drawio 页面的资源全是相对引用，剥掉前缀即可，因此同域天然成立——混合内容拦截、CSP `frame-src` 不同源、访客要另开 3091 这三类白屏成因一次消掉，`DRAWIO_URL` 这个最坑的配置项从「必填」变成「高级选项」。转发只带 accept 等少量请求头（Cookie/Authorization 不外传），不透传上游 `set-cookie`，路径含 `.`/`..` 直接拒绝，上游不可达时回 502 并给出目标地址；画布文档改用一份单独的 CSP（它要 `'unsafe-eval'`，套主站那套必白屏），但仍然锁死本源。上游由 `DRAWIO_INTERNAL_URL` 决定，compose 默认 `http://drawio:8080`，单机二进制默认 `http://127.0.0.1:3091`。
- **Markdown 图片与附件**：工具栏「插入图片」「插入附件」，粘贴与拖拽图片同样直接入库。文件存进 SQLite 的 `assets` 表（不落磁盘，所以整库备份与迁移快照天然覆盖），文档里只记录与主机、端口无关的 `/asset/<id>` 根相对路径——换域名、加反代、内网转公网都不用改文档。匿名分享链接里的图片能显示（判定与该文档的分享规则一致，带密码的分享要先解锁）；导出 zip 时附件落在文档旁的 `<文档名>.assets/`，链接同步改写成本地相对路径，解压后本地打开仍有图。上限单个 5MB、单篇合计 40MB；SVG 因能带脚本一律按下载处理；删除文档/目录/账号时级联清理；统计页展示附件数量与占用。
- **画布加载看护**：drawio 的 iframe 静默失败时（地址不可达、https 页面嵌 http、CSP `frame-src` 未放行），页面不再无限白屏——15 秒内没收到 embed 协议的 `init` 握手就在画布上给出当前地址与对应排查项，可一键重载或关闭。编辑器页与只读分享页共用。
- **`topo/nginx/netluo.conf` 单域名反向代理示例**：一个域名、一张证书、只开 443、**只有一个 upstream**（画布由主进程转发，nginx 不再需要第二个 location）。配套 `.env`：`DRAWIO_URL` 留空 + `TRUST_PROXY=1`。
- **反代配置回归测试**：`npm run test:nginx` 用 `nginx:alpine` 把上面那份配置实跑一遍（本机没有 Linux Docker 时自动跳过，CI 每次都跑）——校验 `nginx -t` 通过、`/drawio/**` 确实转到主站、其余路径原样到主站、80 跳 https，并守住「配置里只允许一个 upstream」这条承诺。

### 变更
- `DRAWIO_URL` 由必填改为可选；`install.sh` 不再自动填 `http://<网卡IP>:3091`，装完直接就是零配置的内置转发，并会在收尾实测一次 `/drawio/`（502 时提示画布容器没起来）。
- compose 的 drawio 端口映射收成 `127.0.0.1:3091`，不再对局域网开放——访客经主站进来，这个端口只留作本机排查。

### 修复
- **`install.sh --port` 之前不生效**：compose 里的端口映射写死 `3090:3000`，`--port` 只写进了 `.env`。现在映射为 `${PORT:-3090}:3000`，升级重跑时也会把新端口同步进已有的 `.env`。

## [1.2.0]

### 新增
- **`install.sh` 一键安装**：`curl -fsSL <raw>/install.sh | sudo bash` 即可，只需要 Docker。检查环境、生成 `.env`、拉镜像起服务、等健康检查通过，最后打印访问地址与管理员密码。选项：`--dir` / `--port` / `--version` / `--drawio` / `--password` / `--no-drawio`；已装过再跑一次即为升级。
- **必填配置降到 1 项**：`TOPO_SECRET` 留空时生成随机密钥并持久化为 `TOPO_DB` 同目录的 `token.secret`，重启与升级不再踢掉在线用户；`ADMIN_PASSWORD` 留空时生成随机管理员密码写入同目录的 `admin-password`。

### 变更
- 生产模式不再因缺少 `TOPO_SECRET` / `ADMIN_PASSWORD` 拒绝启动——随机生成的 64 位十六进制密钥强于手填，且落盘复用。
- 新增 `.gitattributes` 强制 LF：CRLF 会让 `install.sh` 在 Linux 上直接报语法错误。
- 仓库重建为单条初始提交，`v1.1.0` / `v1.1.1` 标签不再存在；镜像包同步重建，标签 `1.1` / `1.1.1` 已不可拉取。可用标签为 `1` / `1.2` / `1.2.0` / `latest`，`1` 与 `latest` 始终指向最新构建。下方 1.1.x 与 1.0.0 条目保留作为版本说明。

### 安全
- 自动生成的凭据文件权限 0600，位置与数据库同目录（权限边界一致）；随机密码不进日志，只打印文件路径，`install.sh` 取用后即删。

## [1.1.1]

### 变更
- **镜像地址改为 `ghcr.io/chensnails/netluo-app`**。旧的 `ghcr.io/chensnails/netluo` 包在仓库还是私有时创建，用户级容器包没有改可见性的 API（只有组织包有），转公开仓库也不会传导过去，所以换名重建以支持匿名 `docker compose pull`。功能与 1.1.0 相同，只是发布地址变了；compose 里请同步改用新镜像（或 `docker compose up -d --build` 走源码）。

## [1.1.0]

### 新增
- **实例内多用户**：角色（`admin` / `user`）与账号状态（`active` / `disabled`）；设置页「成员」分区支持建号、改角色、停用、重置密码、删号（删除需键入用户名二次确认）。
- **自助注册**：`REGISTRATION_CODE` 非空时才开放，登录页可切到注册面板；默认关闭，只有管理员能建账号。
- **Schema 迁移**：`PRAGMA user_version` 编号迁移，每次升级自动执行；带数据的库迁移前先 `VACUUM INTO` 生成快照文件（`TOPO_BACKUP_ON_MIGRATE=0` 可关）。
- **整库备份**：`GET /api/admin/backup` 流式下载一致性快照，不锁服务。
- **发布流水线**：GitHub Actions 构建三平台单文件二进制与 linux/amd64+arm64 多架构镜像，推送 GHCR 并建 Release；PR/push 跑冒烟自检与迁移测试。

### 安全
- 登录、注册、分享口令校验走滑动窗口限速；凭据校验恒定时间比对。
- 会话可吊销：改密、改角色、停用均递增 `token_epoch`，旧 cookie 立即失效。
- 反代 HTTPS 下 cookie 带 `Secure`；`TRUST_PROXY` 让限流与协议判定看到真实客户端 IP。
- 非管理员访问 `/api/admin/*` 一律 403 并记审计日志。

### 变更
- 镜像改从 `ghcr.io/chensnails/netluo` 拉取，`NETLUO_VERSION` 控制标签；源码构建仍可用 `--build`。
- 密码最低 8 位，用户名校验长度与字符集。
- 新增 `docker-compose.dev.yml`：容器内跑源码热重载，不挂 `node_modules`。

## [1.0.0]

### 新增
- 文件树 + drawio 画布 + 所见即所得 Markdown 编辑器（Vditor），带版本历史、编辑锁（423）、乐观并发（409）、只读分享链接。
- 双色主题（跟随系统 + 手动切换）、设置页、zip 全量导出。
- 单文件二进制部署（Node SEA，内嵌 Node 运行时、原生 SQLite 模块与前端资源）与 Docker Compose 部署并存。
- 安全收口（HttpOnly + HMAC 令牌、CSP 白名单、路径与输入校验）、内存降载、窄屏与交互美化。

[1.2.0]: https://github.com/chensnails/netluo/releases/tag/v1.2.0
[1.1.1]: https://github.com/chensnails/netluo/blob/main/CHANGELOG.md#111
[1.1.0]: https://github.com/chensnails/netluo/blob/main/CHANGELOG.md#110
[1.0.0]: https://github.com/chensnails/netluo/blob/main/CHANGELOG.md#100
