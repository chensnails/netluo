// 发布：打 tag 并推送，产物由 GitHub Actions 构建（见 .github/workflows/release.yml）
//
//   GH_TOKEN=... node build/publish.mjs --version v1.1.0 [--wait]
//
// 本脚本不构建任何产物：镜像与单文件二进制都在 CI 里出，保证「谁都能复现同一个包」。
// Release 正文取自 CHANGELOG.md 里对应版本的段落。
// --wait 会轮询这次 tag 触发的流水线，跑完打印 release 地址与资产清单。
// token 只走请求头，不进命令行、不落盘。
import path from "node:path";
import { execFileSync } from "node:child_process";

const SERVER_DIR = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(SERVER_DIR, "..", "..");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(`--${flag}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const VERSION = opt("version", process.env.TAG);
const TOKEN = process.env.GH_TOKEN;
if (!VERSION || !/^v\d+\.\d+\.\d+/.test(VERSION)) {
  console.error("用法：GH_TOKEN=... node build/publish.mjs --version v1.1.0 [--wait]");
  process.exit(1);
}
if (!TOKEN) { console.error("缺少 GH_TOKEN 环境变量（需要 repo 权限）"); process.exit(1); }

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const REPO = opt("repo", git("config", "--get", "remote.origin.url")
  .replace(/^.*github\.com[:/]/, "").replace(/\.git$/, ""));

const gh = async (url) => {
  const res = await fetch(`https://api.github.com${url}`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github+json", "user-agent": "netluo-publish" },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

const HEAD_SHA = git("rev-parse", "HEAD");
if (git("status", "--porcelain")) {
  console.error("[publish] 工作区有未提交改动，先提交再发版（产物必须能对应到一个干净提交）");
  process.exit(1);
}

console.log(`[publish] ${REPO} ${VERSION} @ ${HEAD_SHA.slice(0, 7)}`);
if (!git("tag", "-l", VERSION)) git("tag", "-a", VERSION, "-m", `netluo ${VERSION}`);
git("push", "origin", "HEAD");
// 分支和标签必须分两次推：一次 git push 里带上 tag 不生成 tag 的 push 事件，Release 流水线不会被触发
git("push", "origin", `refs/tags/${VERSION}:refs/tags/${VERSION}`);
console.log("[publish] tag 已推送，Actions 会构建镜像与二进制");

if (!has("wait")) {
  console.log(`[publish] 进度：https://github.com/${REPO}/actions`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let run = null;
// 三平台二进制 + qemu 模拟出的多架构镜像，二十几分钟是正常的
for (let i = 0; i < 150; i++) {
  await sleep(10000);
  const runs = await gh(`/repos/${REPO}/actions/runs?head_sha=${HEAD_SHA}`);
  run = runs.workflow_runs.find((x) => x.name === "Release") || null;
  if (!run) { process.stdout.write("."); continue; }
  process.stdout.write(`\r[publish] ${run.name} status=${run.status} conclusion=${run.conclusion ?? "-"}   `);
  if (run.status === "completed") break;
}
if (!run) { console.error("\n[publish] 等不到流水线记录"); process.exit(1); }
console.log("");
if (run.conclusion !== "success") {
  console.error(`[publish] 流水线 ${run.conclusion}：https://github.com/${REPO}/actions/runs/${run.id}`);
  process.exit(1);
}
const release = await gh(`/repos/${REPO}/releases/tags/${VERSION}`);
console.log(`[publish] ${release.html_url}`);
for (const a of release.assets) {
  console.log(`  - ${a.name} ${(a.size / 1048576).toFixed(1)}MB`);
}
// 与 .github/workflows/release.yml 的 IMAGE 保持一致
console.log(`[publish] 镜像：ghcr.io/${REPO.split("/")[0].toLowerCase()}/netluo-app:${VERSION.replace(/^v/, "")}`);
