// SEA 启动器：内嵌资源先一次性释放到缓存目录，再把控制权交给打包后的应用。
// 本文件不直接使用，构建时由 sea.mjs 注入版本号与资源清单后生成 boot.cjs。
const sea = require("node:sea");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION = "__VERSION__";
const ASSETS = __MANIFEST__;

if (!sea.isSea()) {
  console.error("[netluo] sea-boot 只用于单文件产物；源码运行请用 node src/index.js");
  process.exit(1);
}

function cacheRoot() {
  if (process.env.TOPO_RUNTIME_DIR) return process.env.TOPO_RUNTIME_DIR;
  const base = process.platform === "win32"
    ? process.env.LOCALAPPDATA || os.tmpdir()
    : process.env.XDG_CACHE_HOME || path.join(os.homedir() || os.tmpdir(), ".cache");
  return path.join(base, "netluo", VERSION);
}

function readAsset(rel) {
  let buf = sea.getRawAsset ? sea.getRawAsset(rel) : sea.getAsset(rel, false);
  if (buf instanceof ArrayBuffer) buf = Buffer.from(buf);
  return buf;
}

function extract(root) {
  const tmp = `${root}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const rel of ASSETS) {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readAsset(rel));
    if (rel.endsWith(".node")) fs.chmodSync(dest, 0o755);
  }
  fs.writeFileSync(path.join(tmp, ".complete"), VERSION);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(root), { recursive: true });
  try {
    fs.renameSync(tmp, root);
  } catch (e) {
    // 同时启动的另一个进程已经抢先把目录放好了，直接用现成的
    if (!fs.existsSync(path.join(root, ".complete"))) throw e;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const root = cacheRoot();
if (!fs.existsSync(path.join(root, ".complete"))) {
  fs.mkdirSync(path.dirname(root), { recursive: true });
  extract(root);
  console.log(`[netluo] ${VERSION} 运行环境已释放到 ${root}`);
}

// SEA 上下文里的 require 只认内置模块，要用 createRequire 造一个走真实文件系统的加载器
process.env.TOPO_PUBLIC_DIR = path.join(root, "public");
require("node:module").createRequire(path.join(root, "boot.cjs"))("./app.cjs");
