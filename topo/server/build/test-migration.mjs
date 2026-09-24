// 迁移回归：分别验证「空库」和「v1.0.0 老库」两种起点都能升到最新结构
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netluo-mig-"));
process.on("exit", () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上句柄还没放开就算了 */ }
});

const fails = [];
const check = (name, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) fails.push(name);
};

const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

function freshCheck() {
  const file = path.join(dir, "fresh.db");
  process.env.TOPO_DB = file;
  return import("../src/db.js").then((m) => {
    const db = m.default;
    const v = Number(db.pragma("user_version", { simple: true }));
    const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    check("空库升到最新结构", v === 3 && cols.includes("role") && cols.includes("status") && cols.includes("token_epoch"));
    check("空库有附件表", hasTable(db, "assets"));
    check("空库不产生快照", !fs.readdirSync(dir).some((n) => n.includes("premigration")));
    const admin = db.prepare("INSERT INTO users (username,pass_hash,role) VALUES ('admin','x','admin')").run();
    check("空库建表后可写入", Number(admin.lastInsertRowid) === 1);
    db.close();
  });
}

// 构造一个 v1.0.0 形态的老库：无 role/status，有 token_epoch 补丁，带真实数据
function makeLegacy(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), token_epoch INTEGER NOT NULL DEFAULT 0);
CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'drawio',
  owner_id INTEGER NOT NULL REFERENCES users(id), content TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  folder_id INTEGER, locked_by INTEGER, lock_expires TEXT);
CREATE TABLE folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent_id INTEGER,
  owner_id INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE file_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER NOT NULL, version INTEGER NOT NULL,
  content TEXT NOT NULL, author TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE shares (token TEXT PRIMARY KEY, file_id INTEGER NOT NULL, pass_hash TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE user_settings (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT (datetime('now')));
`);
  db.prepare("INSERT INTO users (username,pass_hash) VALUES ('admin','salt:hash')").run();
  db.prepare("INSERT INTO folders (name,owner_id) VALUES ('总部',1)").run();
  db.prepare("INSERT INTO files (name,owner_id,content) VALUES ('示例拓扑-测试用',1,'<mxfile/>')").run();
  db.prepare("INSERT INTO file_versions (file_id,version,content,author) VALUES (1,1,'<mxfile/>','admin')").run();
  db.close();
}

// db.js 已求值过一次，加查询串强制重新求值，让它按老库路径走迁移
async function legacyCheck() {
  const file = path.join(dir, "legacy.db");
  makeLegacy(file);
  process.env.TOPO_DB = file;
  const m = await import("../src/db.js?legacy=1");
  const db = m.default;
  const v = Number(db.pragma("user_version", { simple: true }));
  const u = db.prepare("SELECT id,username,role,status FROM users").get();
  const f = db.prepare("SELECT id,name,owner_id FROM files").all();
  const snapshots = fs.readdirSync(dir).filter((n) => n.includes("premigration"));
  check("老库升到最新结构", v === 3);
  check("老库补出附件表", hasTable(db, "assets"));
  check("老库首个用户提为 admin 且可用", u?.role === "admin" && u?.status === "active");
  check("老库数据完好", f.length === 1 && f[0].name === "示例拓扑-测试用");
  check("迁移前留下快照", snapshots.length === 1);
  check("已有用户时不再建 admin", (await m.bootstrapAdmin()) === null);
  db.close();
}

await freshCheck();
await legacyCheck();
if (fails.length) {
  console.log(`[migrate] FAILED ${fails.length} 项`);
  process.exit(1);
}
console.log("[migrate] 全部通过");
