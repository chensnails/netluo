import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 必须作为 index.js 的第一个 import：模块按 import 顺序求值，这里 exit 掉就不会碰到数据库文件。
// 路径基准取真实入口文件所在目录：源码运行是 src/，容器里同理，单文件产物则由环境变量兜底。
const ENTRY_DIR = path.dirname(fs.realpathSync(process.argv[1] || process.cwd()));

function readPkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ENTRY_DIR, "..", "package.json"), "utf8")).version;
  } catch {
    return "dev";
  }
}

export const APP_VERSION = process.env.TOPO_VERSION || `v${readPkgVersion()}`;

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-V")) {
  console.log(`netluo ${APP_VERSION}`);
  process.exit(0);
}

export const SMOKE = args.includes("--smoke");

if (SMOKE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netluo-smoke-"));
  // 临时库连同 -wal/-shm 用完即走，别在目标机上堆垃圾
  process.on("exit", () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上句柄未放开就留给系统清 */ }
  });
  process.env.NODE_ENV = "production";
  process.env.TOPO_SECRET ||= "smoke-only-secret-value";
  process.env.TOPO_DB = path.join(dir, "smoke.db");
  process.env.ADMIN_PASSWORD ||= "smoke-admin-password";
  console.log(`[smoke] netluo ${APP_VERSION} 临时库=${dir}`);
}
