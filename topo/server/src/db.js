import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const db = new Database(process.env.TOPO_DB || "./topo-dev.db");
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");     // WAL 下足够安全，省掉大部分 fsync
db.pragma("busy_timeout = 4000");
db.pragma("cache_size = -8000");       // 负值按 KB 计：8MB 页缓存
db.pragma("temp_store = MEMORY");

// ---------- 一次性凭据的落盘位置 ----------
// 与库同一个目录（容器里就是数据卷），只读镜像也能写；写不进去时调用方各自降级。
const DATA_DIR = path.dirname(path.resolve(process.env.TOPO_DB || "./topo-dev.db"));

export function readCredential(name) {
  try {
    return fs.readFileSync(path.join(DATA_DIR, name), "utf8").trim() || null;
  } catch {
    return null;
  }
}

// 返回写入的绝对路径，失败返回 null。0600：只有跑容器的那个用户能读。
export function writeCredential(name, value) {
  const file = path.join(DATA_DIR, name);
  try {
    fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

// ---------- 版本化迁移 ----------
// 目标机上是「别人实例里的真实数据」，所以：迁移必须幂等、必须按 user_version 顺序推进、
// 动结构前先落一份快照，升级失败可以拿快照回滚。
const hasColumn = (table, column) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

function addColumn(table, column, def) {
  if (hasColumn(table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

const MIGRATIONS = [
  // v1：把历史上散落的 CREATE / ALTER 收编成基线（老库 user_version=0 会重跑一遍，全部幂等）
  (d) => {
    d.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'drawio',
  owner_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS file_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  author TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id),
  pass_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
    // 老库里这几列是当年 ALTER 上去的，索引必须等列就位再建
    addColumn("files", "folder_id", "INTEGER");
    addColumn("files", "locked_by", "INTEGER");
    addColumn("files", "lock_expires", "TEXT");
    addColumn("users", "token_epoch", "INTEGER NOT NULL DEFAULT 0");
    d.exec(`
CREATE INDEX IF NOT EXISTS idx_versions_file ON file_versions(file_id, version);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders(owner_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id);
CREATE INDEX IF NOT EXISTS idx_shares_file ON shares(file_id);
`);
  },

  // v2：实例内多用户——角色与启停，最早注册的账号（bootstrap admin）升为 admin
  (d) => {
    addColumn("users", "role", "TEXT NOT NULL DEFAULT 'user'");
    addColumn("users", "status", "TEXT NOT NULL DEFAULT 'active'");
    addColumn("users", "last_login_at", "TEXT");
    d.exec(`UPDATE users SET role = 'admin' WHERE id = (SELECT MIN(id) FROM users)`);
  },

  // v3：Markdown 里插入的图片与附件。存进库而不是磁盘：整库备份、迁移快照、
  // zip 导出都自动覆盖到它，不需要再多管一个目录或数据卷。
  (d) => {
    d.exec(`
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id),
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assets_file ON assets(file_id);
CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner_id);
`);
  },
];

function currentVersion() {
  return Number(db.pragma("user_version", { simple: true }) || 0);
}

function backupBeforeMigration(from) {
  if (process.env.TOPO_BACKUP_ON_MIGRATE === "0") return null;
  const file = process.env.TOPO_DB || "./topo-dev.db";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const dest = `${file}.premigration-v${from}-${stamp}.db`;
  try {
    db.prepare("VACUUM INTO ?").run(dest);   // VACUUM INTO 会带上 WAL 里已提交的内容
    return dest;
  } catch (e) {
    // 备份失败不阻断启动：只读快照拿不到通常是磁盘只读，结构迁移本身仍是幂等的
    console.warn(`[topo] 迁移前快照失败（继续迁移）：${e.message}`);
    return null;
  }
}

function migrate() {
  const from = currentVersion();
  if (from >= MIGRATIONS.length) return;
  // 空库或全新文件不需要快照；有数据就先落一份再动结构
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  const hasData = !!table && db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0;
  const snapshot = hasData ? backupBeforeMigration(from) : null;
  if (snapshot) console.log(`[topo] 迁移前快照：${snapshot}`);
  for (let v = from; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
    console.log(`[topo] schema 迁移 ${v} -> ${v + 1}`);
  }
}

migrate();


// scrypt 用异步版本：同步版会阻塞事件循环，登录/分享密码校验并发时会卡住整个服务
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = (await scrypt(String(password), salt, 32, SCRYPT_OPTS)).toString("hex");
  return `${salt}:${hash}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash || hash.length !== 64) return false;
  try {
    const check = (await scrypt(String(password), salt, 32, SCRYPT_OPTS)).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
  } catch { return false; }
}

// 用户不存在时用这条假哈希做同代价校验，避免通过响应时间枚举账号
const DUMMY_SALT = crypto.randomBytes(16).toString("hex");
export const DUMMY_HASH = `${DUMMY_SALT}:${"0".repeat(64)}`;

export async function createUser(username, password, role = "user") {
  const info = db.prepare("INSERT INTO users (username, pass_hash, role) VALUES (?, ?, ?)")
    .run(String(username).trim(), await hashPassword(password), role);
  return info.lastInsertRowid;
}

export async function bootstrapAdmin() {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (count > 0) return null;
  const password = process.env.ADMIN_PASSWORD;
  if (password) {
    await createUser("admin", password, "admin");
    console.log("[topo] bootstrap admin user created");
    return password;
  }
  // 没给密码就随机生成一个。不写进日志（容器日志常被采集到多人可见的地方），
  // 而是落在数据卷里，install.sh 与运维用一条 exec 就能取到。
  const generated = crypto.randomBytes(9).toString("base64url");
  await createUser("admin", generated, "admin");
  const file = writeCredential("admin-password", generated);
  console.log(file
    ? `[topo] 已生成 admin 初始密码并写入 ${file}，读取后建议删除该文件，登录后请尽快改密`
    : `[topo] 写盘失败，admin 初始密码仅在此打印一次：${generated}`);
  return generated;
}

export const EMPTY_DRAWIO = `<mxfile host="topo"><diagram name="Page-1" id="page-1"></diagram></mxfile>`;

export const EMPTY_MD = `# 未命名文档

所见即所得编辑：输入 Markdown 语法会即时渲染，直接点击文字即可修改。Ctrl+S 保存。

- 支持表格、代码块、引用等 GFM 常用语法
- 每次保存都会生成一个可还原的历史版本
`;

export default db;
