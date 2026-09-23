import { SMOKE, APP_VERSION } from "./cli.js";   // 必须排在最前：--version 要在打开数据库之前退出
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import db, { bootstrapAdmin, createUser, hashPassword, verifyPassword, DUMMY_HASH, EMPTY_DRAWIO, EMPTY_MD, readCredential, writeCredential } from "./db.js";
import { makeZip } from "./zip.js";

const gzip = promisify(zlib.gzip);

// 令牌签名密钥：环境变量优先，其次复用数据卷里已有的，最后才生成并落盘。
// 落盘是关键——密钥每重启就换一次的话，每次升级都会把所有在线用户踢下线。
const SECRET_FILE = "token.secret";
function resolveTokenSecret() {
  const fromEnv = process.env.TOPO_SECRET || "";
  if (fromEnv.length >= 16) return fromEnv;
  const persisted = readCredential(SECRET_FILE);
  if (persisted && persisted.length >= 16) return persisted;
  const generated = crypto.randomBytes(32).toString("hex");
  const file = writeCredential(SECRET_FILE, generated);
  if (!file) console.warn("[topo] 无法写入令牌密钥文件，本次用内存随机密钥：重启后所有登录态失效");
  else console.log(`[topo] TOPO_SECRET 未设置，已生成随机密钥并保存到 ${file}`);
  return generated;
}
const TOKEN_SECRET = resolveTokenSecret();

// 静态资源目录：三态运行各有各的位置，单文件二进制由启动器解包后用环境变量指进来
const PUBLIC_DIR = process.env.TOPO_PUBLIC_DIR
  || path.join(path.dirname(fs.realpathSync(process.argv[1])), "..", "public");

// 库内时间戳统一存 UTC，接口输出时转为北京时间（UTC+8）
const bj = (col) => `datetime(${col}, '+8 hours')`;

const MAX_NAME_LEN = 200;         // 过长名称会撑爆 zip 头部的 16 位字段，也无意义
const MAX_CONTENT = 8 * 1024 * 1024;
const MAX_ZIP_BYTES = 64 * 1024 * 1024;

let DRAWIO_ORIGIN = "";
try { DRAWIO_ORIGIN = new URL(process.env.DRAWIO_URL || "").origin; } catch { DRAWIO_ORIGIN = ""; }
if (DRAWIO_ORIGIN === "null") DRAWIO_ORIGIN = "";

// Vditor 会用 XHR 拉图标文件再以内联 script 注入精灵图。为不开 script-src 'unsafe-inline'，
// 按内容哈希精确放行这一个文件；换版本时哈希变了会自动重新计算。
let VDITOR_ICON_HASH = "";
try {
  const iconSrc = fs.readFileSync(path.join(PUBLIC_DIR, "vendor", "vditor", "dist", "js", "icons", "ant.js"));
  VDITOR_ICON_HASH = " 'sha256-" + crypto.createHash("sha256").update(iconSrc).digest("base64") + "'";
} catch {
  console.warn("[topo] 未找到 vditor 图标脚本，工具栏图标将因 CSP 无法注入（不影响编辑功能）");
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'" + VDITOR_ICON_HASH,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-src 'self'" + (DRAWIO_ORIGIN ? " " + DRAWIO_ORIGIN : ""),
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

// 面向多实例分发时，几乎总是跑在 nginx/caddy 之后：不开 trustProxy 的话
// req.ip 全是代理地址，登录限速会把所有用户一起锁死。默认关闭，由 TRUST_PROXY 显式打开。
const TRUST_PROXY = process.env.TRUST_PROXY === "loopback" ? "loopback"
  : !!process.env.TRUST_PROXY && process.env.TRUST_PROXY !== "0";

const app = Fastify({ logger: true, bodyLimit: MAX_CONTENT + 4 * 1024 * 1024, trustProxy: TRUST_PROXY });

// 只有走 HTTPS 访问时才给 cookie 加 Secure，否则本机 http:// 部署会直接登不上。
// 用 req.protocol 而不是 req.secure：开了 trustProxy 时前者才会在 https 反代下报对。
function cookieOpts(req) {
  return { path: "/", httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 3600, secure: req?.protocol === "https" };
}

// better-sqlite3 的 prepare 不便宜，热点 SQL 复用编译结果
const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}

// 插件注册、管理员引导与监听统一收进文件末尾的 start()：
// 单文件产物跑的是 CJS，不支持顶层 await
app.addHook("onSend", async (req, reply, payload) => {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "same-origin");
  reply.header("x-frame-options", "SAMEORIGIN");
  reply.header("content-security-policy", CSP);
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  // 第三方库只在换版本时变化，给一天强缓存；自己的 html/js/css 仍然每次校验
  if (/^\/vendor\//.test(req.url)) reply.header("cache-control", "public, max-age=86400");
  if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
  return maybeGzip(req, reply, payload);
});

// 拓扑 XML / Markdown 是高度可压缩的纯文本：一张大拓扑 300KB+，压缩后只剩零头
const TEXTISH = /^(application\/json|application\/javascript|text\/)/;
async function maybeGzip(req, reply, payload) {
  if (!req.url.startsWith("/api/")) return payload;
  if (payload === undefined || payload === null) return payload;
  const ct = String(reply.getHeader("content-type") || "");
  if (!TEXTISH.test(ct)) return payload;
  if (reply.getHeader("content-encoding")) return payload;
  if (!/\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) return payload;
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  if (buf.length < 1024) return payload;
  const zipped = await gzip(buf, { level: 6 });
  if (zipped.length >= buf.length * 0.9) return payload;
  reply.header("content-encoding", "gzip");
  reply.header("vary", "accept-encoding");
  reply.removeHeader("content-length");
  return zipped;
}

// token = "<uid>.<exp>.<epoch>.<hmac>"；epoch 用于失效：改密后旧 token 全部作废
function signToken(uid, epoch) {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const body = `${uid}.${exp}.${epoch | 0}`;
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(body).digest("hex");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 4) return null;
  const [uid, exp, epoch, sig] = parts;
  const expect = crypto.createHmac("sha256", TOKEN_SECRET).update(`${uid}.${exp}.${epoch}`).digest("hex");
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  if (!Number.isFinite(Number(exp)) || Number(exp) < Date.now()) return null;
  const user = prep("SELECT id, username, token_epoch, role, status FROM users WHERE id = ?").get(Number(uid));
  if (!user || user.token_epoch !== Number(epoch)) return null;
  if (user.status !== "active") return null;      // 被停用的账号立刻失效，无需改密或重启
  return user;
}

function isAdmin(req) { return req.user?.role === "admin"; }

app.addHook("preHandler", async (req, reply) => {
  if (!req.url.startsWith("/api/")) return;
  if (req.url.startsWith("/api/share/")) return; // 公开分享接口自带校验
  if (req.url === "/api/config") return;
  if (req.method === "POST" && (req.url === "/api/login" || req.url === "/api/register")) return;
  req.user = verifyToken(req.cookies.topo_token);
  if (!req.user) return reply.code(401).send({ error: "unauthorized" });
  if (req.url.startsWith("/api/admin/") && !isAdmin(req)) {
    app.log.warn({ ip: req.ip, uid: req.user.id }, "非管理员访问管理接口");
    return reply.code(403).send({ error: "需要管理员权限" });
  }
});

app.get("/api/config", async () => ({
  drawioUrl: process.env.DRAWIO_URL || "",
  version: APP_VERSION,
  registration: registrationOpen(),
}));

// ---------- 口令尝试限速（进程内计数，重启清零；单实例部署足够） ----------
const LIMITS = {
  login: { max: 5, windowMs: 15 * 60 * 1000 },
  loginIp: { max: 25, windowMs: 15 * 60 * 1000 },
  sharePw: { max: 8, windowMs: 10 * 60 * 1000 },
  register: { max: 5, windowMs: 60 * 60 * 1000 },
};
const failState = new Map();

function retryAfterMs(bucket, key) {
  const id = bucket + "|" + key;
  const s = failState.get(id);
  if (!s) return 0;
  if (s.lockUntil > Date.now()) return s.lockUntil - Date.now();
  if (Date.now() - s.first > LIMITS[bucket].windowMs) failState.delete(id);
  return 0;
}

function noteFail(bucket, key) {
  const cfg = LIMITS[bucket];
  const id = bucket + "|" + key;
  const now = Date.now();
  let s = failState.get(id);
  if (!s || now - s.first > cfg.windowMs) s = { first: now, n: 0, lockUntil: 0 };
  s.n += 1;
  if (s.n >= cfg.max) { s = { first: now, n: 0, lockUntil: now + cfg.windowMs }; }
  failState.set(id, s);
  if (failState.size > 4000) {
    for (const [k, v] of failState) if (now - v.first > cfg.windowMs * 2) failState.delete(k);
  }
}

function clearFail(bucket, key) { failState.delete(bucket + "|" + key); }

function secText(ms) {
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? Math.ceil(s / 60) + " 分钟" : s + " 秒";
}

const MIN_PW_LEN = 8;            // 面向公网自建实例的底线；老用户改密时才会套用
const USERNAME_RE = /^[\w.\-一-龥]{2,32}$/;

function checkPassword(pw, username = "") {
  const s = String(pw || "");
  if (s.length < MIN_PW_LEN) return { error: `密码至少 ${MIN_PW_LEN} 位` };
  if (s.length > 200) return { error: "密码过长" };
  if (username && s.toLowerCase() === String(username).toLowerCase()) return { error: "密码不能与用户名相同" };
  return { value: s };
}

function checkUsername(raw) {
  const u = String(raw ?? "").trim();
  if (!USERNAME_RE.test(u)) return { error: "用户名需为 2-32 位中文、字母、数字或 . _ -" };
  if (db.prepare("SELECT 1 FROM users WHERE lower(username) = ?").get(u.toLowerCase())) return { error: "用户名已存在" };
  return { value: u };
}

// 注册默认关闭：只有显式设置 REGISTRATION_CODE 才开放自助注册
function registrationOpen() { return !!process.env.REGISTRATION_CODE; }

app.post("/api/login", async (req, reply) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const ip = req.ip || "-";
  const wait = Math.max(
    retryAfterMs("login", ip + "|" + username.toLowerCase()),
    retryAfterMs("loginIp", ip),
  );
  if (wait) {
    reply.header("retry-after", Math.ceil(wait / 1000));
    return reply.code(429).send({ error: `尝试过于频繁，请 ${secText(wait)} 后重试` });
  }
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  // 用户不存在也走一次同代价校验，避免用耗时差异枚举账号
  const ok = await verifyPassword(password, user ? user.pass_hash : DUMMY_HASH);
  if (!user || !ok) {
    noteFail("login", ip + "|" + username.toLowerCase());
    noteFail("loginIp", ip);
    app.log.warn({ ip, username }, "登录失败");
    return reply.code(401).send({ error: "用户名或密码错误" });
  }
  if (user.status !== "active") {
    app.log.warn({ ip, username, uid: user.id }, "已停用账号尝试登录");
    return reply.code(403).send({ error: "该账号已停用，请联系管理员" });
  }
  clearFail("login", ip + "|" + username.toLowerCase());
  clearFail("loginIp", ip);
  prep("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  app.log.info({ ip, username, uid: user.id }, "登录成功");
  reply.setCookie("topo_token", signToken(user.id, user.token_epoch), cookieOpts(req));
  return { username: user.username, role: user.role };
});

app.post("/api/register", async (req, reply) => {
  const ip = req.ip || "-";
  if (!registrationOpen()) return reply.code(403).send({ error: "本站未开放注册，请联系管理员开通账号" });
  const wait = retryAfterMs("register", ip);
  if (wait) {
    reply.header("retry-after", Math.ceil(wait / 1000));
    return reply.code(429).send({ error: `注册过于频繁，请 ${secText(wait)} 后重试` });
  }
  const got = Buffer.from(String(req.body?.code || ""), "utf8");
  const want = Buffer.from(process.env.REGISTRATION_CODE, "utf8");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    noteFail("register", ip);
    return reply.code(401).send({ error: "注册码不正确" });
  }
  const u = checkUsername(req.body?.username);
  if (u.error) return reply.code(400).send({ error: u.error });
  const p = checkPassword(req.body?.password, u.value);
  if (p.error) return reply.code(400).send({ error: p.error });
  clearFail("register", ip);
  const id = Number(await createUser(u.value, p.value, "user"));
  prep("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id);
  app.log.info({ ip, username: u.value, uid: id }, "自助注册");
  const { token_epoch } = db.prepare("SELECT token_epoch FROM users WHERE id = ?").get(id);
  reply.code(201).setCookie("topo_token", signToken(Number(id), token_epoch), cookieOpts(req));
  return { username: u.value, role: "user" };
});

app.post("/api/logout", async (req, reply) => {
  reply.clearCookie("topo_token", { path: "/" });
  return { ok: true };
});

app.get("/api/me", async (req) => ({ id: req.user.id, username: req.user.username, role: req.user.role }));

app.get("/api/tree", async (req) => {
  const folders = prep(
    "SELECT id, name, parent_id FROM folders WHERE owner_id = ? ORDER BY name"
  ).all(req.user.id);
  const files = prep(`
    SELECT f.id, f.name, f.type, f.version, f.folder_id, ${bj("f.updated_at")} AS updated_at,
           CASE WHEN f.lock_expires > datetime('now') THEN u.username END AS locked_by
    FROM files f LEFT JOIN users u ON u.id = f.locked_by
    WHERE f.owner_id = ? ORDER BY f.updated_at DESC
  `).all(req.user.id);
  return { folders, files };
});

function ownFolder(folderId, uid) {
  if (folderId === null || folderId === undefined) return true;
  const f = db.prepare("SELECT id FROM folders WHERE id = ? AND owner_id = ?").get(Number(folderId), uid);
  return !!f;
}

// 名称统一校验：空/超长都会在这里挡掉（超长名会撑爆 zip 头部字段）
function cleanName(raw) {
  const name = String(raw ?? "").trim();
  if (!name) return { error: "name required" };
  if (name.length > MAX_NAME_LEN) return { error: `名称最长 ${MAX_NAME_LEN} 个字符` };
  return { name };
}

function isDescendantFolder(folderId, maybeAncestorId) {
  const seen = new Set();          // 防御脏数据里的环，避免死循环
  let cur = Number(folderId);
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    if (cur === Number(maybeAncestorId)) return true;
    const row = db.prepare("SELECT parent_id FROM folders WHERE id = ?").get(cur);
    cur = row ? row.parent_id : null;
  }
  return false;
}

function childFoldersOf(parentId) {
  return db.prepare("SELECT id FROM folders WHERE parent_id = ?").all(parentId).map((r) => r.id);
}

// 自顶向下收集子孙目录（含自身），带环保护
function subtreeFolderIds(rootId) {
  const all = [Number(rootId)];
  const seen = new Set(all);
  for (let i = 0; i < all.length; i++) {
    for (const c of childFoldersOf(all[i])) if (!seen.has(c)) { seen.add(c); all.push(c); }
  }
  return all;
}

app.post("/api/folders", async (req, reply) => {
  const { name, error } = cleanName(req.body?.name);
  if (error) return reply.code(400).send({ error });
  const parentId = req.body?.parentId === undefined || req.body?.parentId === null ? null : Number(req.body.parentId);
  if (!ownFolder(parentId, req.user.id)) return reply.code(400).send({ error: "bad parentId" });
  const info = db.prepare("INSERT INTO folders (name, parent_id, owner_id) VALUES (?, ?, ?)")
    .run(name, parentId, req.user.id);
  return reply.code(201).send({ id: info.lastInsertRowid });
});

app.patch("/api/folders/:id", async (req, reply) => {
  const id = Number(req.params.id);
  const folder = db.prepare("SELECT id, parent_id FROM folders WHERE id = ? AND owner_id = ?").get(id, req.user.id);
  if (!folder) return reply.code(404).send({ error: "not found" });
  let name;
  if (req.body?.name !== undefined) {
    const r = cleanName(req.body.name);
    if (r.error) return reply.code(400).send({ error: r.error });
    name = r.name;
  }
  let parentId = folder.parent_id;
  if (req.body?.parentId !== undefined) {
    parentId = req.body.parentId === null ? null : Number(req.body.parentId);
    if (!ownFolder(parentId, req.user.id)) return reply.code(400).send({ error: "bad parentId" });
    if (parentId !== null && isDescendantFolder(parentId, id)) {
      return reply.code(400).send({ error: "不能移动到自身或其子目录" });
    }
  }
  db.prepare("UPDATE folders SET name = COALESCE(?, name), parent_id = ? WHERE id = ?")
    .run(name ?? null, parentId, id);
  return { ok: true };
});

app.delete("/api/folders/:id", async (req, reply) => {
  const id = Number(req.params.id);
  const folder = db.prepare("SELECT id FROM folders WHERE id = ? AND owner_id = ?").get(id, req.user.id);
  if (!folder) return reply.code(404).send({ error: "not found" });
  const recursive = req.query.recursive === "1";
  const subCount = db.prepare("SELECT COUNT(*) AS n FROM folders WHERE parent_id = ?").get(id).n;
  const fileCount = db.prepare("SELECT COUNT(*) AS n FROM files WHERE folder_id = ?").get(id).n;
  if ((subCount || fileCount) && !recursive) {
    return reply.code(409).send({ error: "not-empty", subCount, fileCount });
  }
  const doomed = subtreeFolderIds(id);
  const delFolder = db.prepare("DELETE FROM folders WHERE id = ?");
  const delVersions = db.prepare("DELETE FROM file_versions WHERE file_id = ?");
  const delShares = db.prepare("DELETE FROM shares WHERE file_id = ?");
  const selectOwnedFiles = db.prepare("SELECT id FROM files WHERE folder_id = ? AND owner_id = ?");
  const delFiles = db.prepare("DELETE FROM files WHERE folder_id = ? AND owner_id = ?");
  const tx = db.transaction(() => {
    for (const d of doomed) {
      delFolder.run(d);
      for (const f of selectOwnedFiles.all(d, req.user.id)) { delVersions.run(f.id); delShares.run(f.id); }
      delFiles.run(d, req.user.id);
    }
  });
  tx();
  return { ok: true };
});

app.get("/api/files", async (req) => {
  return db.prepare(
    `SELECT id, name, type, version, folder_id, ${bj("updated_at")} AS updated_at FROM files WHERE owner_id = ? ORDER BY updated_at DESC`
  ).all(req.user.id);
});

app.post("/api/files", async (req, reply) => {
  const type = req.body?.type === "md" ? "md" : "drawio";
  const rawName = String(req.body?.name ?? "").trim();
  const { name, error } = rawName ? cleanName(rawName) : { name: type === "md" ? "未命名文档" : "未命名拓扑" };
  if (error) return reply.code(400).send({ error });
  let content = req.body?.content;
  if (typeof content !== "string" || !content.trim()) content = type === "md" ? EMPTY_MD : EMPTY_DRAWIO;
  if (content.length > MAX_CONTENT) return reply.code(400).send({ error: "content too large" });
  const folderId = req.body?.folderId === undefined || req.body?.folderId === null ? null : Number(req.body.folderId);
  if (!ownFolder(folderId, req.user.id)) return reply.code(400).send({ error: "bad folderId" });
  const info = db.prepare(
    "INSERT INTO files (name, type, owner_id, content, folder_id) VALUES (?, ?, ?, ?, ?)"
  ).run(name, type, req.user.id, content, folderId);
  return reply.code(201).send({ id: info.lastInsertRowid });
});

app.get("/api/files/:id", async (req, reply) => {
  const row = db.prepare(
    `SELECT id, name, type, version, folder_id, content, ${bj("created_at")} AS created_at, ${bj("updated_at")} AS updated_at
     FROM files WHERE id = ? AND owner_id = ?`
  ).get(Number(req.params.id), req.user.id);
  if (!row) return reply.code(404).send({ error: "not found" });
  return row;
});

// ---------- 编辑锁（90s 租约，保存必须持锁） ----------
const LOCK_TTL_SEC = 90;
const utcNow = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const lockActive = (row) => !!(row.lock_expires && row.lock_expires > utcNow());

function lockInfo(id) {
  return prep("SELECT id, owner_id, locked_by, lock_expires FROM files WHERE id = ?").get(id);
}

app.post("/api/files/:id/lock", async (req, reply) => {
  const row = lockInfo(Number(req.params.id));
  if (!row || row.owner_id !== req.user.id) return reply.code(404).send({ error: "not found" });
  if (lockActive(row) && row.locked_by !== req.user.id) {
    const holder = prep("SELECT username FROM users WHERE id = ?").get(row.locked_by);
    return reply.code(423).send({ error: "locked-by-other", holder: holder?.username || "?" });
  }
  prep("UPDATE files SET locked_by = ?, lock_expires = ? WHERE id = ?")
    .run(req.user.id, new Date(Date.now() + LOCK_TTL_SEC * 1000).toISOString().slice(0, 19).replace("T", " "), row.id);
  return { ok: true, ttl: LOCK_TTL_SEC };
});

app.post("/api/files/:id/unlock", async (req, reply) => {
  const row = lockInfo(Number(req.params.id));
  if (!row || row.owner_id !== req.user.id) return reply.code(404).send({ error: "not found" });
  if (row.locked_by === req.user.id) {
    prep("UPDATE files SET locked_by = NULL, lock_expires = NULL WHERE id = ?").run(row.id);
  }
  return { ok: true };
});

function saveNewVersion(fileId, version, content, author) {
  prep("INSERT INTO file_versions (file_id, version, content, author) VALUES (?, ?, ?, ?)")
    .run(fileId, version, content, author);
  pruneVersions(fileId);
}

// 历史版本同时限条数与字节数：拓扑/大文档每次保存都是全文快照
const VERSION_KEEP = 50;
const VERSION_MIN_KEEP = 5;
const VERSION_MAX_BYTES = 8 * 1024 * 1024;

function pruneVersions(fileId) {
  const rows = prep("SELECT id, length(content) AS n FROM file_versions WHERE file_id = ? ORDER BY version DESC")
    .all(fileId);
  let keep = 0, bytes = 0;
  for (const r of rows) {
    const next = keep + 1;
    if (next > VERSION_MIN_KEEP && (next > VERSION_KEEP || bytes + r.n > VERSION_MAX_BYTES)) break;
    keep = next;
    bytes += r.n;
  }
  if (keep < rows.length) {
    prep("DELETE FROM file_versions WHERE file_id = ? AND id < ?").run(fileId, rows[keep - 1].id + 1);
  }
}

app.put("/api/files/:id", async (req, reply) => {
  const { content, baseVersion } = req.body || {};
  if (typeof content !== "string") return reply.code(400).send({ error: "content required" });
  if (content.length > MAX_CONTENT) return reply.code(400).send({ error: "content too large" });
  const id = Number(req.params.id);
  const row = prep("SELECT id, version, locked_by, lock_expires FROM files WHERE id = ? AND owner_id = ?").get(id, req.user.id);
  if (!row) return reply.code(404).send({ error: "not found" });
  if (!lockActive(row) || row.locked_by !== req.user.id) {
    return reply.code(423).send({ error: "not-locked", msg: "请先获取编辑锁（重新打开文件或在编辑器中重试）" });
  }
  if (Number(baseVersion) !== row.version) {
    return reply.code(409).send({ error: "conflict", serverVersion: row.version });
  }
  const next = row.version + 1;
  const tx = db.transaction(() => {
    prep("UPDATE files SET content = ?, version = ?, updated_at = datetime('now') WHERE id = ?")
      .run(content, next, id);
    saveNewVersion(id, next, content, req.user.username);
  });
  tx();
  return { ok: true, version: next };
});

app.patch("/api/files/:id", async (req, reply) => {
  const id = Number(req.params.id);
  const row = db.prepare("SELECT id FROM files WHERE id = ? AND owner_id = ?").get(id, req.user.id);
  if (!row) return reply.code(404).send({ error: "not found" });
  const hasName = req.body?.name !== undefined;
  let name;
  if (hasName) {
    const r = cleanName(req.body.name);
    if (r.error) return reply.code(400).send({ error: r.error });
    name = r.name;
  }
  let folderId;
  if (req.body?.folderId !== undefined) {
    folderId = req.body.folderId === null ? null : Number(req.body.folderId);
    if (!ownFolder(folderId, req.user.id)) return reply.code(400).send({ error: "bad folderId" });
  }
  if (!hasName && folderId === undefined) return reply.code(400).send({ error: "nothing to update" });
  if (hasName) db.prepare("UPDATE files SET name = ? WHERE id = ?").run(name, id);
  if (folderId !== undefined) db.prepare("UPDATE files SET folder_id = ? WHERE id = ?").run(folderId, id);
  return { ok: true };
});

app.delete("/api/files/:id", async (req, reply) => {
  const id = Number(req.params.id);
  // 先确认归属，否则版本/分享会被越权删除（原来的写法已经提交删除后才判断 owner）
  const owned = db.prepare("SELECT id FROM files WHERE id = ? AND owner_id = ?").get(id, req.user.id);
  if (!owned) return reply.code(404).send({ error: "not found" });
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM file_versions WHERE file_id = ?").run(id);
    db.prepare("DELETE FROM shares WHERE file_id = ?").run(id);
    return db.prepare("DELETE FROM files WHERE id = ? AND owner_id = ?").run(id, req.user.id);
  });
  if (!tx().changes) return reply.code(404).send({ error: "not found" });
  return { ok: true };
});

// ---------- 版本历史 ----------
app.get("/api/files/:id/versions", async (req, reply) => {
  const row = db.prepare("SELECT id FROM files WHERE id = ? AND owner_id = ?").get(Number(req.params.id), req.user.id);
  if (!row) return reply.code(404).send({ error: "not found" });
  return db.prepare(
    `SELECT version, author, ${bj("created_at")} AS created_at, length(content) AS size FROM file_versions WHERE file_id = ? ORDER BY version DESC`
  ).all(row.id);
});

app.get("/api/files/:id/versions/:v", async (req, reply) => {
  const r = db.prepare(
    "SELECT content FROM file_versions WHERE file_id = ? AND version = ? AND file_id IN (SELECT id FROM files WHERE owner_id = ?)"
  ).get(Number(req.params.id), Number(req.params.v), req.user.id);
  if (!r) return reply.code(404).send({ error: "not found" });
  return { content: r.content };
});

app.post("/api/files/:id/restore", async (req, reply) => {
  const id = Number(req.params.id);
  const file = db.prepare("SELECT id, version, locked_by, lock_expires FROM files WHERE id = ? AND owner_id = ?").get(id, req.user.id);
  if (!file) return reply.code(404).send({ error: "not found" });
  if (!lockActive(file) || file.locked_by !== req.user.id) {
    return reply.code(423).send({ error: "not-locked", msg: "还原需要先获取编辑锁" });
  }
  const v = db.prepare("SELECT content FROM file_versions WHERE file_id = ? AND version = ?")
    .get(id, Number(req.body?.version));
  if (!v) return reply.code(404).send({ error: "version not found" });
  const next = file.version + 1;
  const tx = db.transaction(() => {
    db.prepare("UPDATE files SET content = ?, version = ?, updated_at = datetime('now') WHERE id = ?")
      .run(v.content, next, id);
    saveNewVersion(id, next, v.content, req.user.username);
  });
  tx();
  return { ok: true, version: next };
});

// ---------- 只读分享 ----------
app.post("/api/files/:id/shares", async (req, reply) => {
  const file = db.prepare("SELECT id FROM files WHERE id = ? AND owner_id = ?").get(Number(req.params.id), req.user.id);
  if (!file) return reply.code(404).send({ error: "not found" });
  const token = crypto.randomBytes(16).toString("base64url");
  const pw = String(req.body?.password || "");
  if (pw.length > 200) return reply.code(400).send({ error: "密码过长" });
  db.prepare("INSERT INTO shares (token, file_id, pass_hash) VALUES (?, ?, ?)")
    .run(token, file.id, pw ? await hashPassword(pw) : null);
  return reply.code(201).send({ token });
});

app.get("/api/files/:id/shares", async (req, reply) => {
  const file = db.prepare("SELECT id FROM files WHERE id = ? AND owner_id = ?").get(Number(req.params.id), req.user.id);
  if (!file) return reply.code(404).send({ error: "not found" });
  return db.prepare(`SELECT token, ${bj("created_at")} AS created_at, (pass_hash IS NOT NULL) AS hasPassword FROM shares WHERE file_id = ?`)
    .all(file.id).map((s) => ({ token: s.token, created_at: s.created_at, hasPassword: !!s.hasPassword }));
});

app.delete("/api/shares/:token", async (req, reply) => {
  const info = db.prepare(
    "DELETE FROM shares WHERE token = ? AND file_id IN (SELECT id FROM files WHERE owner_id = ?)"
  ).run(String(req.params.token), req.user.id);
  if (!info.changes) return reply.code(404).send({ error: "not found" });
  return { ok: true };
});

// 解锁凭证：HMAC(secret, token + 密码哈希)。不能直接用 token 当凭证——token 就在分享链接里，
// 手工塞个 cookie 就能绕过密码。
function shareProof(token, passHash) {
  return crypto.createHmac("sha256", TOKEN_SECRET).update(`share:${token}:${passHash || ""}`).digest("hex");
}
function hasShareProof(req, token, passHash) {
  const got = String(req.cookies.topo_share || "");
  const want = shareProof(token, passHash);
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

// 公开分享访问（无需登录）
app.get("/api/share/:token", async (req, reply) => {
  const s = db.prepare(
    "SELECT s.token, s.pass_hash, f.name FROM shares s JOIN files f ON f.id = s.file_id WHERE s.token = ?"
  ).get(String(req.params.token));
  if (!s) return reply.code(404).send({ error: "分享不存在或已取消" });
  if (s.pass_hash && hasShareProof(req, s.token, s.pass_hash)) return { name: s.name, hasPassword: false };
  return { name: s.name, hasPassword: !!s.pass_hash };
});

app.post("/api/share/:token", async (req, reply) => {
  const token = String(req.params.token);
  const ip = req.ip || "-";
  const wait = retryAfterMs("sharePw", ip + "|" + token);
  if (wait) {
    reply.header("retry-after", Math.ceil(wait / 1000));
    return reply.code(429).send({ error: `密码尝试过于频繁，请 ${secText(wait)} 后重试` });
  }
  const s = db.prepare("SELECT s.token, s.pass_hash FROM shares s WHERE s.token = ?").get(token);
  if (!s) return reply.code(404).send({ error: "分享不存在或已取消" });
  if (!s.pass_hash || hasShareProof(req, s.token, s.pass_hash)) return { ok: true };
  if (!(await verifyPassword(String(req.body?.password || ""), s.pass_hash))) {
    noteFail("sharePw", ip + "|" + token);
    return reply.code(401).send({ error: "密码错误" });
  }
  clearFail("sharePw", ip + "|" + token);
  reply.setCookie("topo_share", shareProof(s.token, s.pass_hash), cookieOpts(req));
  return { ok: true };
});

app.get("/api/share/:token/content", async (req, reply) => {
  const s = db.prepare(
    `SELECT s.token, s.pass_hash, f.name, f.type, f.content, f.version, ${bj("f.updated_at")} AS updated_at FROM shares s JOIN files f ON f.id = s.file_id WHERE s.token = ?`
  ).get(String(req.params.token));
  if (!s) return reply.code(404).send({ error: "分享不存在或已取消" });
  if (s.pass_hash && !hasShareProof(req, s.token, s.pass_hash)) {
    return reply.code(401).send({ error: "需要密码" });
  }
  return { name: s.name, type: s.type, content: s.content, version: s.version, updated_at: s.updated_at };
});

app.post("/api/change-password", async (req, reply) => {
  const { oldPassword } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!(await verifyPassword(String(oldPassword || ""), user.pass_hash))) {
    // 改密也要限速，否则这里成了一个不算密码的重置入口
    noteFail("login", req.ip + "|" + user.username.toLowerCase());
    app.log.warn({ ip: req.ip, uid: user.id }, "改密时原密码错误");
    return reply.code(400).send({ error: "原密码错误" });
  }
  const p = checkPassword(req.body?.newPassword, user.username);
  if (p.error) return reply.code(400).send({ error: p.error });
  // 改密后旧令牌全部作废（其他设备需重新登录）；当前这台设备换发新令牌，不打断操作
  db.prepare("UPDATE users SET pass_hash = ?, token_epoch = token_epoch + 1 WHERE id = ?")
    .run(await hashPassword(p.value), user.id);
  const { token_epoch } = db.prepare("SELECT token_epoch FROM users WHERE id = ?").get(user.id);
  app.log.info({ ip: req.ip, uid: user.id }, "用户修改密码");
  reply.setCookie("topo_token", signToken(user.id, token_epoch), cookieOpts(req));
  return { ok: true };
});

// ---------- 用户设置 ----------
const SETTING_DEFAULTS = {
  themeMode: "auto",        // auto | light | dark
  docTheme: "light",        // light | wechat | ant（深色主题下自动改用 dark 排版）
  codeLineNumber: false,
  defaultNewType: "drawio", // drawio | md
};
const SETTING_ENUMS = {
  themeMode: ["auto", "light", "dark"],
  docTheme: ["light", "wechat", "ant"],
  defaultNewType: ["drawio", "md"],
};
const SETTING_BOOLS = ["codeLineNumber"];

function readSettings(uid) {
  const row = prep("SELECT data FROM user_settings WHERE user_id = ?").get(uid);
  let saved = {};
  try { saved = row ? JSON.parse(row.data) : {}; } catch { saved = {}; }
  return { ...SETTING_DEFAULTS, ...saved };
}

app.get("/api/settings", async (req) => readSettings(req.user.id));

app.put("/api/settings", async (req, reply) => {
  const body = req.body || {};
  const next = readSettings(req.user.id);
  for (const [key, values] of Object.entries(SETTING_ENUMS)) {
    if (body[key] !== undefined) {
      if (!values.includes(body[key])) return reply.code(400).send({ error: `bad ${key}` });
      next[key] = body[key];
    }
  }
  for (const key of SETTING_BOOLS) {
    if (body[key] !== undefined) next[key] = !!body[key];
  }
  db.prepare(`INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .run(req.user.id, JSON.stringify(next));
  return next;
});

// ---------- 分享总览 / 统计 / 导出 ----------
app.get("/api/shares", async (req) => {
  return db.prepare(
    `SELECT s.token, ${bj("s.created_at")} AS created_at, (s.pass_hash IS NOT NULL) AS hasPassword,
            f.id AS file_id, f.name AS file_name, f.type
     FROM shares s JOIN files f ON f.id = s.file_id
     WHERE f.owner_id = ? ORDER BY s.created_at DESC`
  ).all(req.user.id).map((s) => ({ ...s, hasPassword: !!s.hasPassword }));
});

app.get("/api/stats", async (req) => {
  const uid = req.user.id;
  const files = db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(length(content)), 0) AS bytes,
            SUM(type = 'drawio') AS drawio, SUM(type = 'md') AS md,
            ${bj("MAX(updated_at)")} AS last_saved
     FROM files WHERE owner_id = ?`
  ).get(uid);
  const folders = db.prepare("SELECT COUNT(*) AS count FROM folders WHERE owner_id = ?").get(uid).count;
  const shares = db.prepare(
    "SELECT COUNT(*) AS count FROM shares WHERE file_id IN (SELECT id FROM files WHERE owner_id = ?)"
  ).get(uid).count;
  const versions = db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(length(content)), 0) AS bytes FROM file_versions
     WHERE file_id IN (SELECT id FROM files WHERE owner_id = ?)`
  ).get(uid);
  return { files, folders, shares, versions };
});

function safePath(name) {
  return String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim() || "未命名";
}

app.get("/api/export.zip", async (req, reply) => {
  const uid = req.user.id;
  const folders = db.prepare("SELECT id, name, parent_id FROM folders WHERE owner_id = ?").all(uid);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const folderPath = (id) => {
    const parts = [];
    const seen = new Set();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(safePath(cur.name));
      cur = byId.get(cur.parent_id);
    }
    return parts.length ? parts.join("/") + "/" : "";
  };
  const files = db.prepare("SELECT id, name, type, folder_id, content FROM files WHERE owner_id = ? ORDER BY id").all(uid);
  const used = new Set();
  let total = 0;
  const entries = [];
  for (const f of files) {
    const ext = f.type === "md" ? ".md" : ".drawio";
    let path = `${folderPath(f.folder_id)}${safePath(f.name)}${f.name.toLowerCase().endsWith(ext) ? "" : ext}`;
    let n = 2;
    while (used.has(path)) { path = path.replace(/(\.[^.]+)$/, `-${n++}$1`); }
    used.add(path);
    total += Buffer.byteLength(f.content, "utf8");
    if (total > MAX_ZIP_BYTES) {
      return reply.code(413).send({ error: `导出内容超过 ${Math.floor(MAX_ZIP_BYTES / 1024 / 1024)}MB 上限，请分批导出` });
    }
    entries.push({ name: path, data: f.content });
  }
  if (!entries.length) entries.push({ name: "README.txt", data: "（此账号下没有文件）\n" });
  const zip = makeZip(entries);
  reply.header("content-type", "application/zip");
  reply.header("content-length", zip.length);
  reply.header("content-disposition", `attachment; filename="netluo-export-${new Date().toISOString().slice(0, 10)}.zip"`);
  return reply.send(zip);
});

// ---------- 管理员：成员管理与实例备份 ----------
const ADMIN_COLS = `u.id, u.username, u.role, u.status, ${bj("u.created_at")} AS created_at,
       ${bj("u.last_login_at")} AS last_login_at,
       (SELECT COUNT(*) FROM files f WHERE f.owner_id = u.id) AS files`;

app.get("/api/admin/users", async () => {
  const rows = db.prepare(`SELECT ${ADMIN_COLS} FROM users u ORDER BY u.id`).all();
  return {
    users: rows,
    registrationOpen: registrationOpen(),
    schemaVersion: Number(db.pragma("user_version", { simple: true })),
    version: APP_VERSION,
  };
});

app.post("/api/admin/users", async (req, reply) => {
  const u = checkUsername(req.body?.username);
  if (u.error) return reply.code(400).send({ error: u.error });
  const p = checkPassword(req.body?.password, u.value);
  if (p.error) return reply.code(400).send({ error: p.error });
  const role = req.body?.role === "admin" ? "admin" : "user";
  const id = Number(await createUser(u.value, p.value, role));
  app.log.warn({ ip: req.ip, by: req.user.username, uid: id, username: u.value, role }, "管理员创建用户");
  return reply.code(201).send({ id, username: u.value, role });
});

function adminTargetUser(id, reply) {
  const row = db.prepare("SELECT id, username, role, status FROM users WHERE id = ?").get(Number(id));
  if (!row) { reply.code(404).send({ error: "not found" }); return null; }
  return row;
}

const lastAdminId = () => {
  const n = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").get().n;
  return n === 1 ? db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'active'").get().id : null;
};

app.patch("/api/admin/users/:id", async (req, reply) => {
  const target = adminTargetUser(req.params.id, reply);
  if (!target) return;
  const role = req.body?.role === undefined ? target.role : (req.body.role === "admin" ? "admin" : "user");
  const status = req.body?.status === undefined ? target.status : (req.body.status === "disabled" ? "disabled" : "active");
  if (!["active", "disabled"].includes(status)) return reply.code(400).send({ error: "bad status" });
  // 防止把自己关在门外：最后一个可用管理员不能被降级或停用
  if (lastAdminId() === target.id && (role !== "admin" || status !== "active")) {
    return reply.code(400).send({ error: "至少保留一个可用的管理员账号" });
  }
  db.prepare("UPDATE users SET role = ?, status = ?, token_epoch = token_epoch + 1 WHERE id = ?")
    .run(role, status, target.id);
  app.log.warn({ ip: req.ip, by: req.user.username, uid: target.id, role, status }, "管理员变更成员权限");
  return { ok: true, id: target.id, role, status };
});

app.post("/api/admin/users/:id/password", async (req, reply) => {
  const target = adminTargetUser(req.params.id, reply);
  if (!target) return;
  if (target.status !== "active") return reply.code(403).send({ error: "该账号已停用，请先启用" });
  const p = checkPassword(req.body?.password, target.username);
  if (p.error) return reply.code(400).send({ error: p.error });
  db.prepare("UPDATE users SET pass_hash = ?, token_epoch = token_epoch + 1 WHERE id = ?")
    .run(await hashPassword(p.value), target.id);
  app.log.warn({ ip: req.ip, by: req.user.username, uid: target.id }, "管理员重置成员密码");
  return { ok: true };
});

app.delete("/api/admin/users/:id", async (req, reply) => {
  const target = adminTargetUser(req.params.id, reply);
  if (!target) return;
  if (target.id === req.user.id) return reply.code(400).send({ error: "不能删除自己" });
  if (lastAdminId() === target.id) return reply.code(400).send({ error: "至少保留一个可用的管理员账号" });
  // 删号是破坏性最强的操作：要求把用户名原样回传，且先备好整库备份
  if (String(req.body?.confirm || "") !== target.username) {
    return reply.code(400).send({ error: "请把用户名原样填入确认框" });
  }
  const counts = db.prepare(`
    SELECT (SELECT COUNT(*) FROM files WHERE owner_id = ?) AS files,
           (SELECT COUNT(*) FROM folders WHERE owner_id = ?) AS folders`).get(target.id, target.id);
  const tx = db.transaction(() => {
    const fileIds = db.prepare("SELECT id FROM files WHERE owner_id = ?").all(target.id).map((r) => r.id);
    for (const id of fileIds) {
      db.prepare("DELETE FROM file_versions WHERE file_id = ?").run(id);
      db.prepare("DELETE FROM shares WHERE file_id = ?").run(id);
    }
    db.prepare("DELETE FROM files WHERE owner_id = ?").run(target.id);
    db.prepare("DELETE FROM folders WHERE owner_id = ?").run(target.id);
    db.prepare("DELETE FROM user_settings WHERE user_id = ?").run(target.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(target.id);
  });
  tx();
  app.log.warn({ ip: req.ip, by: req.user.username, uid: target.id, ...counts }, "管理员删除用户及其数据");
  return { ok: true, removed: counts };
});

// 单文件冷备份：VACUUM INTO 出来的是一个一致快照，不用停机也不用管 -wal
app.get("/api/admin/backup", async (req, reply) => {
  const dest = path.join(os.tmpdir(), `netluo-backup-${Date.now()}.db`);
  try {
    db.prepare("VACUUM INTO ?").run(dest);
  } catch (e) {
    return reply.code(500).send({ error: "生成备份失败：" + e.message });
  }
  const size = fs.statSync(dest).size;
  reply.header("content-type", "application/octet-stream");
  reply.header("content-length", size);
  reply.header("content-disposition", `attachment; filename="netluo-${new Date().toISOString().slice(0, 10)}.db"`);
  const stream = fs.createReadStream(dest);
  // 读完即删；Windows 上句柄可能还没放开，重试几次，实在删不掉下次启动再清
  stream.on("close", () => {
    let tries = 0;
    const drop = () => fs.promises.unlink(dest).catch(() => {
      if (++tries < 5) setTimeout(drop, 200);
    });
    drop();
  });
  app.log.info({ ip: req.ip, uid: req.user.id, bytes: size }, "导出整库备份");
  return reply.send(stream);
});

// 下载中途断掉会留下整库大小的残留文件，启动时清掉一天前的（只认自己家的文件名）
try {
  const tmp = os.tmpdir();
  for (const name of fs.readdirSync(tmp)) {
    if (!name.startsWith("netluo-backup-")) continue;
    const file = path.join(tmp, name);
    if (Date.now() - fs.statSync(file).mtimeMs > 86400000) fs.rmSync(file, { force: true });
  }
} catch { /* 临时目录读不动就不 sweep */ }

// WAL 只增不减会让 -wal 文件长期占用磁盘；定期回收，退出前收尾
const CHECKPOINT_EVERY_MS = 10 * 60 * 1000;
const ckTimer = setInterval(() => {
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* 有长事务时 SQLite 会返回 busy，忽略 */ }
}, CHECKPOINT_EVERY_MS);
ckTimer.unref();

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* 关闭时尽力而为 */ }
    try { db.close(); } catch { /* 已关闭 */ }
    process.exit(0);
  });
}

// 冒烟自检：一条命令验过「静态资源、路由、数据库、登录与鉴权链路」，构建产物用它把关
async function smoke() {
  const urls = ["/", "/app.js", "/style.css", "/vendor/vditor/dist/index.css", "/vendor/vditor/dist/js/icons/ant.js"];
  let bad = 0;
  for (const url of urls) {
    const res = await app.inject({ method: "GET", url });
    if (res.statusCode !== 200) { bad++; console.log(`[smoke] FAIL ${url} -> ${res.statusCode}`); }
  }
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "admin", password: process.env.ADMIN_PASSWORD } });
  const raw = login.headers["set-cookie"];
  const cookieValue = (Array.isArray(raw) ? raw[0] : raw || "").split(";")[0];
  const tree = await app.inject({ method: "GET", url: "/api/tree", headers: { cookie: cookieValue } });
  const denied = await app.inject({ method: "GET", url: "/api/tree" });
  if (login.statusCode !== 200) { bad++; console.log(`[smoke] FAIL login -> ${login.statusCode}`); }
  if (tree.statusCode !== 200) { bad++; console.log(`[smoke] FAIL tree -> ${tree.statusCode}`); }
  if (denied.statusCode !== 401) { bad++; console.log(`[smoke] FAIL unauthenticated tree -> ${denied.statusCode}`); }
  const files = tree.statusCode === 200 ? JSON.parse(tree.body).files.length : -1;

  // 写链路：建文件 → 拿锁 → 保存 → 历史 → 删除，全程用临时库，不留痕迹
  const created = await app.inject({ method: "POST", url: "/api/files", headers: { cookie: cookieValue }, payload: { name: "__smoke__.md", type: "md" } });
  const id = created.json()?.id;
  const steps = [
    ["POST /api/files", created, 201],
    ["POST lock", await app.inject({ method: "POST", url: `/api/files/${id}/lock`, headers: { cookie: cookieValue } }), 200],
    ["PUT content", await app.inject({ method: "PUT", url: `/api/files/${id}`, headers: { cookie: cookieValue }, payload: { content: "# smoke", baseVersion: 1 } }), 200],
    ["GET versions", await app.inject({ method: "GET", url: `/api/files/${id}/versions`, headers: { cookie: cookieValue } }), 200],
    ["DELETE", await app.inject({ method: "DELETE", url: `/api/files/${id}`, headers: { cookie: cookieValue } }), 200],
  ];
  for (const [label, res, want] of steps) {
    if (res.statusCode !== want) { bad++; console.log(`[smoke] FAIL ${label} -> ${res.statusCode} ${res.body?.slice(0, 120) || ""}`); }
  }

  // 多用户链路：建号 → 新号登录 → 数据隔离 → 停用即失效 → 删除
  const mk = await app.inject({ method: "POST", url: "/api/admin/users", headers: { cookie: cookieValue },
    payload: { username: "__smoke_user__", password: "smoke-pass-123" } });
  const uLogin = await app.inject({ method: "POST", url: "/api/login",
    payload: { username: "__smoke_user__", password: "smoke-pass-123" } });
  const uRaw = uLogin.headers["set-cookie"];
  const uCookie = (Array.isArray(uRaw) ? uRaw[0] : uRaw || "").split(";")[0];
  const own = await app.inject({ method: "POST", url: "/api/files", headers: { cookie: uCookie },
    payload: { name: "__smoke_other__.md", type: "md" } });
  const isolation = await app.inject({ method: "GET", url: `/api/files/${own.json()?.id}`, headers: { cookie: cookieValue } });
  const nonAdmin = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: uCookie } });
  const disable = await app.inject({ method: "PATCH", url: `/api/admin/users/${mk.json()?.id}`,
    headers: { cookie: cookieValue }, payload: { status: "disabled" } });
  const afterDisable = await app.inject({ method: "GET", url: "/api/tree", headers: { cookie: uCookie } });
  const regClosed = await app.inject({ method: "POST", url: "/api/register",
    payload: { username: "__smoke_reg__", password: "smoke-pass-123", code: "x" } });
  const del = await app.inject({ method: "DELETE", url: `/api/admin/users/${mk.json()?.id}`,
    headers: { cookie: cookieValue }, payload: { confirm: "__smoke_user__" } });
  const multi = [
    ["POST admin/users", mk, 201],
    ["新号 login", uLogin, 200],
    ["新号建文件", own, 201],
    ["admin 看不到他人文件", isolation, 404],
    ["普通用户访问管理接口", nonAdmin, 403],
    ["PATCH 停用", disable, 200],
    ["停用后会话失效", afterDisable, 401],
    ["未开放时注册被拒", regClosed, 403],
    ["DELETE 用户", del, 200],
  ];
  for (const [label, res, want] of multi) {
    if (res.statusCode !== want) { bad++; console.log(`[smoke] FAIL ${label} -> ${res.statusCode} ${res.body?.slice(0, 120) || ""}`); }
  }

  const backup = await app.inject({ method: "GET", url: "/api/admin/backup", headers: { cookie: cookieValue } });
  const backupIsSqlite = backup.statusCode === 200 && backup.rawPayload.slice(0, 15).toString("utf8") === "SQLite format 3";
  if (!backupIsSqlite) {
    bad++;
    console.log(`[smoke] FAIL backup -> ${backup.statusCode} ${backup.rawPayload?.length || 0} 字节`);
  }
  // 唯一的 admin 不能把自己降级或删掉，否则实例再也进不去
  const selfDemote = await app.inject({ method: "PATCH", url: "/api/admin/users/1",
    headers: { cookie: cookieValue }, payload: { role: "user" } });
  if (selfDemote.statusCode !== 400) {
    bad++;
    console.log(`[smoke] FAIL 最后一个管理员降级 -> ${selfDemote.statusCode}`);
  }

  await app.close();
  console.log(`[smoke] ${bad ? "FAILED " + bad : "ok"} netluo ${APP_VERSION}（静态 ${urls.length} 项，鉴权 2 项，写链路 ${steps.length} 步，多用户 ${multi.length} 项，备份与护栏 2 项，登录后 files=${files}）`);
  // 不关掉句柄的话退出钩子删不掉临时库（Windows 上文件被占用）
  try { db.close(); } catch { /* 已经关了 */ }
  process.exit(bad ? 1 : 0);
}

async function start() {
  await app.register(cookie);
  // 开发时改完静态文件不该被陈旧的 .gz 盖掉，所以只在生产启用预压缩（构建/镜像里会先跑 npm run vendor 重新压缩）
  await app.register(fastifyStatic, { root: PUBLIC_DIR, preCompressed: process.env.NODE_ENV === "production" });
  await bootstrapAdmin();
  await app.listen({ port: Number(process.env.PORT || 3000), host: "0.0.0.0" });
  if (SMOKE) return smoke();
}

start().catch((e) => { console.error("[topo] 启动失败:", e); process.exit(1); });
