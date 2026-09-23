// 把第三方前端资产从 node_modules 复制进 public/vendor，并预压缩出 .gz。
// Docker 镜像与单文件二进制共用这份逻辑，保证两条产物路径的静态资源完全一致。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SERVER_DIR = path.resolve(import.meta.dirname, "..");
const NM = path.join(SERVER_DIR, "node_modules");
const PUBLIC = path.join(SERVER_DIR, "public");
const VENDOR = path.join(PUBLIC, "vendor");

// [源（相对 node_modules）, 目标（相对 public/vendor）]
const COPIES = [
  ["markdown-it/dist/browser/markdown-it.umd.min.js", "markdown-it.min.js"],
  ["vditor/dist/index.min.js", "vditor/dist/index.min.js"],
  ["vditor/dist/index.css", "vditor/dist/index.css"],
  ["vditor/dist/js/lute", "vditor/dist/js/lute"],
  ["vditor/dist/js/icons", "vditor/dist/js/icons"],
  ["vditor/dist/js/i18n/zh_CN.js", "vditor/dist/js/i18n/zh_CN.js"],
  ["vditor/dist/js/highlight.js/highlight.min.js", "vditor/dist/js/highlight.js/highlight.min.js"],
  ["vditor/dist/js/highlight.js/third-languages.js", "vditor/dist/js/highlight.js/third-languages.js"],
  ["vditor/dist/js/highlight.js/styles/github.min.css", "vditor/dist/js/highlight.js/styles/github.min.css"],
  ["vditor/dist/js/highlight.js/styles/github-dark.min.css", "vditor/dist/js/highlight.js/styles/github-dark.min.css"],
  ["vditor/dist/js/highlight.js/styles/ant-design.min.css", "vditor/dist/js/highlight.js/styles/ant-design.min.css"],
  ["vditor/dist/css", "vditor/dist/css"],
];

fs.rmSync(VENDOR, { recursive: true, force: true });
for (const [from, to] of COPIES) {
  const src = path.join(NM, from);
  if (!fs.existsSync(src)) { console.error(`[vendor] 缺少 ${from}，请先 npm install`); process.exit(1); }
  fs.cpSync(src, path.join(VENDOR, to), { recursive: true });
}

let count = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.(js|css|html)$/.test(entry.name)) continue;
    fs.writeFileSync(full + ".gz", zlib.gzipSync(fs.readFileSync(full), { level: 9 }));
    count++;
  }
};
walk(PUBLIC);
console.log(`[vendor] 资源就绪，${count} 个文本文件已预压缩`);
