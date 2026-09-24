// topo/nginx/netluo.conf 的回归测试：用 nginx:alpine 把仓库里那份配置真跑一遍。
// 单域名反代依赖三件事，任一不成立用户侧就是画布白屏：
//   1) 语法与指令可用（http2、proxy_hide_header 一类拼错在这步暴露）
//   2) /drawio/ 转给上游时剥掉前缀（proxy_pass 结尾少个 / 就是这条）
//   3) 其余路径原样给主站；/drawio 不带斜杠要 301 到 /drawio/（相对路径资源的前提）；80 跳 https
// 需要 Linux 版 Docker 与 openssl（--network host 让容器访问宿主上游桩），缺任一则跳过。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONF = path.join(HERE, "..", "..", "nginx", "netluo.conf");
const APP_PORT = 13210;     // 上游桩：主站
const DRAWIO_PORT = 13211;  // 上游桩：drawio
const HTTP = 18080;         // 配置里 listen 80 那组换成的端口
const HTTPS = 18443;
const CONTAINER = "netluo-nginx-test";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "netluo-nginx-"));

const log = (...a) => console.log("[nginx-test]", ...a);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const rm = () => run("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });

let failed = "";
const expect = (cond, msg) => { if (!cond && !failed) failed = msg; };

function stub(port, seen, body) {
  const srv = http.createServer((req, res) => {
    seen.push(req.url.split("?")[0]);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(body);
  });
  // 只绑回环：容器与宿主共用网络栈，走 127.0.0.1 就够了
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv)));
}

function get(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location ?? "" });
    });
    req.on("error", () => resolve({ status: 0, location: "" }));
  });
}

// 只换域名与端口，指令和 location 结构原样保留，测的就是仓库里那份文件
function render(conf, { behavior }) {
  let out = conf.replaceAll("topo.example.com", "netluo.test")
    .replace("listen 80;", `listen ${HTTP};`)
    .replace("listen 443 ssl http2;", `listen ${HTTPS} ssl http2;`);
  if (behavior) {
    out = out.replace("server 127.0.0.1:3090;", `server 127.0.0.1:${APP_PORT};`)
      .replace("server 127.0.0.1:3091;", `server 127.0.0.1:${DRAWIO_PORT};`);
  }
  return out;
}

const MOUNTS = () => ["-v", `${TMP}:/etc/nginx/conf.d:ro`, "-v", `${TMP}:/etc/ssl/netluo:ro`];

function writeConf(behavior) {
  fs.writeFileSync(path.join(TMP, "netluo.conf"), render(fs.readFileSync(CONF, "utf8"), { behavior }));
}

// nginx -t：容器不起服务，只看配置能否解析
function checkSyntax() {
  const r = run("docker", ["run", "--rm", "--network", "host", ...MOUNTS(), "nginx:alpine", "nginx", "-t"]);
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}` };
}

async function startNginx() {
  rm();
  writeConf(true);
  const started = run("docker", ["run", "--rm", "-d", "--name", CONTAINER, "--network", "host", ...MOUNTS(), "nginx:alpine"]);
  if (started.status !== 0) return { ok: false, out: `${started.stdout}${started.stderr}` };
  for (let i = 0; i < 40; i++) {
    if ((await get(`http://127.0.0.1:${HTTP}/`)).status !== 0) return { ok: true, out: "" };
    await new Promise((r) => setTimeout(r, 250));
  }
  const logs = run("docker", ["logs", CONTAINER]);
  return { ok: false, out: `端口 ${HTTP} 一直没起来：\n${logs.stdout}${logs.stderr}` };
}

async function main() {
  if (run("docker", ["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    log("SKIP 本机没有可用的 Docker，跳过反代配置测试");
    return 0;
  }
  if (run("openssl", ["version"]).status !== 0) {
    log("SKIP 缺 openssl，无法生成自签证书");
    return 0;
  }
  const gen = run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", path.join(TMP, "privkey.pem"), "-out", path.join(TMP, "fullchain.pem"),
    "-subj", "/CN=netluo.test"], { stdio: "ignore" });
  if (gen.status !== 0) {
    log("SKIP 生成自签证书失败");
    return 0;
  }

  const syntax = checkSyntax();
  expect(syntax.ok, `nginx -t 未通过：\n${syntax.out.split("\n").filter((l) => /emerg|invalid|unknown|not compatible/.test(l)).join("\n")}`);

  const appSeen = [], drawioSeen = [];
  const s1 = await stub(APP_PORT, appSeen, "app");
  const s2 = await stub(DRAWIO_PORT, drawioSeen, "drawio");
  const up = await startNginx();
  expect(up.ok, `nginx 容器没起来：${up.out}`);
  if (up.ok) {
    const canvas = await get(`https://127.0.0.1:${HTTPS}/drawio/js/main.js`);
    const api = await get(`https://127.0.0.1:${HTTPS}/api/config`);
    const slash = await get(`https://127.0.0.1:${HTTPS}/drawio`);
    const plain = await get(`http://127.0.0.1:${HTTP}/`);
    log(`画布资源 ${canvas.status} | 主站接口 ${api.status} | /drawio ${slash.status} ${slash.location} | 80 ${plain.status} ${plain.location}`);
    expect(drawioSeen.includes("/js/main.js"), `/drawio/ 没剥前缀，drawio 上游只收到 ${JSON.stringify(drawioSeen)}`);
    expect(appSeen.includes("/api/config"), `主站转发失败，app 上游收到 ${JSON.stringify(appSeen)}`);
    expect(!appSeen.some((p) => p.startsWith("/drawio")), "画布请求串到了主站上游");
    expect(slash.status === 301 && slash.location.endsWith("/drawio/"), `/drawio 没跳带斜杠：${slash.status} ${slash.location}`);
    expect(plain.status === 301 && plain.location.startsWith("https://"), `80 端口没跳 https：${plain.status} ${plain.location}`);
  }
  rm();
  s1.close();
  s2.close();
  fs.rmSync(TMP, { recursive: true, force: true });

  if (failed) {
    console.error(`[nginx-test] FAIL ${failed}`);
    return 1;
  }
  log("PASS 语法 ok · /drawio/ 剥前缀 · 主站转发 · 斜杠与 https 跳转");
  return 0;
}

process.on("exit", rm);
main().then((code) => process.exit(code)).catch((e) => {
  console.error(`[nginx-test] FAIL ${e?.stack || e}`);
  rm();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
