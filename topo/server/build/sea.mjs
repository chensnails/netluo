// 单文件二进制构建（Node SEA）
//
//   node build/sea.mjs [--targets win-x64,linux-x64,linux-arm64] [--version v1.0.0] [--out dist]
//
// 产物每个平台一个可执行文件：Node 运行时 + 打包后的应用 + better-sqlite3 原生模块 +
// public 静态资源全部内嵌为 SEA assets，首次启动释放到缓存目录后再 require，
// 目标机不需要装 Node，也不需要一个一个铺 node_modules。
//
// 原生模块（better-sqlite3 的 .node）按平台区分：本机目标直接用 node_modules 里
// 装好的那份；跨平台目标用 prebuild-install 从官方 release 拉对应平台的预编译产物。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const postject = require("postject");

const SERVER_DIR = path.resolve(import.meta.dirname, "..");
const NM = path.join(SERVER_DIR, "node_modules");
const WORK = path.join(SERVER_DIR, "build", ".sea");
const PAYLOAD = path.join(WORK, "payload");
const STAGE_NM = path.join(PAYLOAD, "node_modules");
const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, "package.json"), "utf8"));

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const VERSION = opt("version", process.env.TAG || `v${pkg.version}`);
const OUT = path.resolve(SERVER_DIR, opt("out", "dist"));
const HOST = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const TARGETS = (opt("targets", HOST) || HOST).split(",").filter(Boolean);

const INFO = {
  // member：发行包里可执行文件相对包根目录的路径（linux 放在 bin/ 下，win 直接是根）
  "win-x64": { pkgOs: "win", arch: "x64", ext: "zip", member: "node.exe", prebuildOs: "win", prebuildArch: "x64", suffix: ".exe" },
  "linux-x64": { pkgOs: "linux", arch: "x64", ext: "tar.xz", member: "bin/node", prebuildOs: "linux", prebuildArch: "x64", suffix: "" },
  "linux-arm64": { pkgOs: "linux", arch: "arm64", ext: "tar.xz", member: "bin/node", prebuildOs: "linux", prebuildArch: "arm64", suffix: "" },
};

const log = (...m) => console.log("[sea]", ...m);
const reset = (dir) => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); };

// Windows 上刚动过的文件常被杀软/索引器短暂占用，重命名会 EPERM，重试即可。
// 用 Atomics.wait 睡觉：跨平台同步，不像 ping 那样在 linux 上参数不同会挂住。
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameWithRetry(from, to, tries = 10) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      if (e.code !== "EPERM" && e.code !== "EBUSY") throw e;
      if (i >= tries) throw e;
      nap(1000);
    }
  }
}

function listFiles(root, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

const SKIP = /^(node_modules|deps|src|binding\.gyp|README\.md|LICENSE|\.github|docs|benchmark|test)$/;

// better-sqlite3 通过 bindings 在包目录的 build/Release 下找 .node，
// 所以包结构必须原样保留，连同它自己的 JS 依赖一起暂存。
function stagePackage(name, nativeSrc) {
  const src = path.join(NM, name);
  const meta = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
  const dst = path.join(STAGE_NM, name);
  for (const entry of fs.readdirSync(src)) {
    if (SKIP.test(entry)) continue;
    if (entry === "build") {
      const from = path.join(src, "build");
      if (!fs.existsSync(from)) continue;
      if (!nativeSrc) {
        fs.cpSync(from, path.join(dst, "build"), { recursive: true });
      } else {
        // 只带上目标平台那一个 .node，别的编译中间产物不进二进制
        fs.cpSync(path.join(from, "Release"), path.join(dst, "build", "Release"), {
          recursive: true,
          filter: (f) => !f.endsWith(".node") || f === nativeSrc,
        });
      }
      continue;
    }
    fs.cpSync(path.join(src, entry), path.join(dst, entry), { recursive: true });
  }
  for (const dep of Object.keys(meta.dependencies || {})) stagePackage(dep, null);
}

// better-sqlite3 的原生模块按平台区分。prebuild-install 只会往 node_modules 里落地，
// 所以先备份本机那份、下载目标平台那份进缓存，再还原现场——否则跨平台构建会把本机安装弄坏。
// 只按文件是否存在来判断平台会出错（跨平台构建会留下别的地方的 .node），直接验魔数
function nativeIsFor(file, target) {
  const head = fs.readFileSync(file).subarray(0, 4);
  const elf = head[0] === 0x7f && head.toString("latin1", 1, 4) === "ELF";
  const pe = head.toString("latin1", 0, 2) === "MZ";
  return target.startsWith("linux") ? elf : pe;
}

function nativeFor(target) {
  const local = path.join(NM, "better-sqlite3", "build", "Release", "better_sqlite3.node");
  const dir = path.join(os.homedir(), ".cache", "netluo-sea", "native", `${target}-abi${process.versions.modules}`);
  const cached = path.join(dir, "better_sqlite3.node");
  if (target === HOST && fs.existsSync(local) && nativeIsFor(local, target)) return local;
  if (!fs.existsSync(cached) || !nativeIsFor(cached, target)) {
    fs.mkdirSync(dir, { recursive: true });
    const info = INFO[target];
    const backup = local + ".host-backup";
    if (fs.existsSync(local)) renameWithRetry(local, backup);
    try {
      log(`为 ${target} 下载 better-sqlite3 预编译模块（ABI ${process.versions.modules}）`);
      execFileSync(process.execPath, [
        path.join(NM, "prebuild-install", "bin.js"),
        "--download",
        `--platform=${info.prebuildOs === "win" ? "win32" : info.prebuildOs}`,
        `--arch=${info.prebuildArch}`,
        // libc 只对 linux 预编译产物有意义，给 Windows 传反而会挑错文件名
        ...(info.prebuildOs === "linux" ? ["--libc=glibc"] : []),
      ], { cwd: path.join(NM, "better-sqlite3"), stdio: "inherit" });
      if (!fs.existsSync(local)) throw new Error(`prebuild-install 没有产出 ${target} 的 .node`);
      fs.copyFileSync(local, cached);
    } finally {
      if (fs.existsSync(backup)) renameWithRetry(backup, local);
      else if (fs.existsSync(local) && !nativeIsFor(local, HOST)) fs.rmSync(local, { force: true });
    }
  }
  return cached;
}

// Git Bash 自带的 tar 不认 Windows 路径；系统里带的 bsdtar 两种格式和两种路径都吃。
// Linux/macOS 上系统 tar 是 GNU tar，解不了 zip，Windows 发行包只能用 unzip 取。
const TAR = process.platform === "win32" ? "C:/Windows/System32/tar.exe" : "tar";

function unpack(archive, base, member, ext) {
  if (ext === "zip" && process.platform !== "win32") {
    execFileSync("unzip", ["-q", "-o", archive, `${base}/${member}`, "-d", path.dirname(archive)], { stdio: "inherit" });
    return;
  }
  execFileSync(TAR, [ext === "zip" ? "-xf" : "-xJf", archive, "-C", path.dirname(archive), `${base}/${member}`], { stdio: "inherit" });
}

function fetchNode(info) {
  const target = `${info.pkgOs}-${info.arch}`;
  const hostTarget = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
  if (target === hostTarget) return process.execPath;
  const cache = path.join(os.homedir(), ".cache", "netluo-sea");
  const base = `node-v${process.versions.node}-${info.pkgOs}-${info.arch}`;
  const wanted = path.join(cache, base, info.member);
  if (!fs.existsSync(wanted)) {
    fs.mkdirSync(cache, { recursive: true });
    const archive = path.join(cache, `${base}.${info.ext}`);
    const url = `https://nodejs.org/dist/v${process.versions.node}/${base}.${info.ext}`;
    log(`下载 ${url}`);
    execFileSync("curl", ["-fsSL", "--retry", "3", "-o", archive, url], { stdio: "inherit" });
    unpack(archive, base, info.member, info.ext);
  }
  if (!fs.existsSync(wanted)) throw new Error(`没能取出 ${wanted}`);
  return wanted;
}

// fuse 串随 node 版本变化，且每个平台的发行包各不相同，只能从目标可执行文件里现读
function readFuse(exePath) {
  const text = fs.readFileSync(exePath).toString("latin1");
  const hit = text.match(/NODE_SEA_FUSE_[0-9a-f]{32}/);
  if (!hit) throw new Error(`${path.basename(exePath)} 里没有 NODE_SEA_FUSE 哨兵，无法注入`);
  return hit[0];
}

async function main() {
  for (const t of TARGETS) if (!INFO[t]) throw new Error(`未知目标 ${t}，可选：${Object.keys(INFO).join(", ")}`);
  log(`版本 ${VERSION}，本机 ${HOST}，目标 ${TARGETS.join(", ")}`);
  reset(WORK);
  fs.mkdirSync(STAGE_NM, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(SERVER_DIR, "src", "index.js")],
    outfile: path.join(PAYLOAD, "app.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    minify: true,
    legalComments: "none",
    external: ["better-sqlite3"],
    define: { "process.env.TOPO_VERSION": JSON.stringify(VERSION) },
  });
  fs.cpSync(path.join(SERVER_DIR, "public"), path.join(PAYLOAD, "public"), { recursive: true });
  const staticFiles = listFiles(PAYLOAD);

  const template = fs.readFileSync(path.join(SERVER_DIR, "build", "sea-boot.cjs"), "utf8");
  if (!template.includes("__MANIFEST__") || !template.includes('"__VERSION__"')) {
    throw new Error("sea-boot.cjs 缺少注入占位符，拒绝产出半成品二进制");
  }
  fs.mkdirSync(OUT, { recursive: true });
  for (const t of TARGETS) {
    const info = INFO[t];
    const native = nativeFor(t);
    reset(STAGE_NM);
    stagePackage("better-sqlite3", native);
    const files = [...staticFiles, ...listFiles(STAGE_NM).map((rel) => `node_modules/${rel}`)];
    fs.writeFileSync(path.join(WORK, "boot.cjs"), template
      .replace('"__VERSION__"', JSON.stringify(VERSION))
      .replace("__MANIFEST__", JSON.stringify(files)));
    fs.writeFileSync(path.join(WORK, "sea-config.json"), JSON.stringify({
      main: path.join(WORK, "boot.cjs"),
      assets: Object.fromEntries(files.map((rel) => [rel, path.join(PAYLOAD, rel)])),
      output: path.join(WORK, "sea.blob"),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    }, null, 2));
    execFileSync(process.execPath, ["--experimental-sea-config", "sea-config.json"], { cwd: WORK, stdio: "inherit" });

    const dest = path.join(OUT, `netluo-${VERSION}-${t}${info.suffix}`);
    const runtimeNode = fetchNode(info);
    fs.copyFileSync(runtimeNode, dest);
    fs.chmodSync(dest, 0o755);
    await postject.inject(dest, "NODE_SEA_BLOB", fs.readFileSync(path.join(WORK, "sea.blob")), {
      sentinelFuse: readFuse(runtimeNode),
      overwrite: true,
    });
    log(`产出 ${path.basename(dest)}（${(fs.statSync(dest).size / 1048576).toFixed(1)}MB，${files.length} 个内嵌文件）`);
  }

  // 发布物一律带 sha256 校验和，目标机上先验再跑
  const sums = TARGETS.map((t) => {
    const name = `netluo-${VERSION}-${t}${INFO[t].suffix}`;
    const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(OUT, name))).digest("hex");
    return `${hash}  ${name}`;
  });
  fs.writeFileSync(path.join(OUT, "SHA256SUMS.txt"), sums.join("\n") + "\n");
  log(`校验和已写入 dist/SHA256SUMS.txt`);
}

main().catch((e) => { console.error("[sea] 失败:", e?.message || e); process.exit(1); });
