const $ = (id) => document.getElementById(id);
const fileId = new URLSearchParams(location.search).get("id");

let meta = null;      // { name, type, version, content }
let dirty = false;
let readOnly = false;
let hbTimer = null;
let vd = null;

// 外观由平台主题（浅/深）+ 账号设置（文档排版、代码行号）共同决定
let prefs = { docTheme: "light", codeLineNumber: false };
const DOC_LAYOUT = { light: "light", wechat: "wechat", ant: "ant-design" };
const DOC_HLJS = { light: "github", wechat: "github", ant: "ant-design" };

function appearance() {
  const dark = TopoTheme.resolve() === "dark";
  if (dark) return { editor: "dark", content: "dark", hljs: "github-dark" };
  const doc = DOC_LAYOUT[prefs.docTheme] ? prefs.docTheme : "light";
  return { editor: "classic", content: DOC_LAYOUT[doc], hljs: DOC_HLJS[doc] };
}
function applyAppearance() {
  const a = appearance();
  if (vd) vd.setTheme(a.editor, a.content, a.hljs);
  return a;
}
document.addEventListener("topo:theme", () => applyAppearance());

function setStatus(text) { $("status").textContent = text || ""; }
function setReadOnly(msg) {
  readOnly = true;
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  if (vd) vd.disabled();
  $("saveBtn").style.display = "none";
  const b = $("lockBanner");
  b.textContent = msg;
  b.classList.remove("hidden");
  UI.toast(msg, "warn", 6000);
}

function showConflict() {
  const box = document.createElement("div");
  const p1 = document.createElement("p");
  p1.className = "ui-msg";
  p1.textContent = "该文档已在其他地方被修改（版本冲突），本次改动没有保存。";
  const p2 = document.createElement("p");
  p2.className = "ui-msg";
  p2.textContent = "可以先下载本地备份，再刷新载入服务器版本；也可以留在本页继续编辑，稍后重试保存。";
  box.append(p1, p2);
  UI.dialog({
    title: "保存冲突",
    body: box,
    okText: "下载本地备份",
    cancelText: "留在本页",
    onOk: () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([vd.getValue()], { type: "text/markdown" }));
      a.download = `${meta.name}-本地备份-v${meta.version}.md`;
      a.click();
      URL.revokeObjectURL(a.href);
      UI.toast("已导出，刷新页面可载入服务器最新版本", "warn", 5000);
    },
  });
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/"; throw new Error("unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

async function save() {
  if (!vd) return;
  if (readOnly) { UI.toast("只读模式，无法保存", "warn"); return; }
  if (!dirty) { setStatus("无改动"); UI.toast("没有需要保存的改动", "warn", 1600); return; }
  try {
    const r = await api("PUT", `/api/files/${fileId}`, { content: vd.getValue(), baseVersion: meta.version });
    meta.version = r.version;
    dirty = false;
    setStatus(`已保存 v${r.version}`);
    vd.tip(`已保存 v${r.version}`, 2000);
  } catch (e) {
    if (e.status === 409) {
      setStatus("版本冲突，未保存");
      showConflict();
    } else if (e.status === 423) {
      setReadOnly("编辑锁已失效（超时或他人接管），当前只读，请刷新页面重新编辑");
    } else {
      setStatus("保存失败: " + e.message);
      UI.toast("保存失败：" + e.message, "err");
    }
  }
}

$("saveBtn").onclick = save;
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
});

window.addEventListener("pagehide", () => {
  if (readOnly || !vd) return;
  if (dirty) {
    fetch(`/api/files/${fileId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: vd.getValue(), baseVersion: meta.version }),
      keepalive: true,
    });
  }
  fetch(`/api/files/${fileId}/unlock`, { method: "POST", keepalive: true });
});

async function acquireLock() {
  try {
    await api("POST", `/api/files/${fileId}/lock`);
    hbTimer = setInterval(() => {
      api("POST", `/api/files/${fileId}/lock`)
        .catch((e) => { if (e.status === 423) setReadOnly("编辑锁被他人接管，当前只读"); });
    }, 30000);
    return true;
  } catch (e) {
    if (e.status === 423) setReadOnly(`${e.data?.holder || "他人"} 正在编辑，当前为只读模式`);
    else setStatus("锁服务异常: " + e.message);
    return false;
  }
}

// ---------- 图片与附件 ----------
// 上传后文档里只写根相对路径 /asset/<id>：换域名、换端口、走反代、分享给匿名访客都不用改内容，
// 导出 zip 时由服务端改写成本地相对路径。
const MAX_ASSET = 5 * 1024 * 1024;

function pickFiles(accept, multiple) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = !!multiple;
    input.style.display = "none";
    document.body.appendChild(input);
    input.onchange = () => {
      const files = [...input.files];
      input.remove();
      resolve(files);
    };
    // 取消文件对话框没有事件可监听：窗口重新聚焦后仍没选到文件就当作取消
    window.addEventListener("focus", () => setTimeout(() => {
      if (input.isConnected && !input.files.length) { input.remove(); resolve([]); }
    }, 500), { once: true });
    input.click();
  });
}

async function uploadOne(file, kind) {
  if (readOnly) { UI.toast(`只读模式，无法插入${kind === "image" ? "图片" : "附件"}`, "warn"); return null; }
  if (file.size > MAX_ASSET) { UI.toast(`「${file.name}」超过 5MB 上限`, "err", 4000); return null; }
  setStatus("上传中…");
  try {
    const res = await fetch(`/api/files/${fileId}/assets?name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type || "")}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 423) setReadOnly("编辑锁已失效，无法上传，请刷新页面重新编辑");
      else UI.toast(`上传失败：${data.error || res.statusText}`, "err", 5000);
      setStatus(readOnly ? "只读模式" : "未保存");
      return null;
    }
    setStatus("未保存");
    return data;
  } catch (e) {
    UI.toast("上传失败：" + e.message, "err");
    setStatus("上传失败");
    return null;
  }
}

// 链接文字里的方括号会截断 Markdown 语法，换成全角即可，不必转义成看不懂的字符
const safeAlt = (s) => String(s).replaceAll("[", "［").replaceAll("]", "］");

async function insertAssets(files, kind) {
  if (!vd || !files.length) return;
  const lines = [];
  for (const f of files) {
    const r = await uploadOne(f, kind);
    if (r) lines.push(kind === "image" ? `![${safeAlt(r.name)}](${r.url})` : `[${safeAlt(r.name)}](${r.url})`);
  }
  if (!lines.length) return;
  dirty = true;
  setStatus("未保存");
  vd.insertValue(lines.join("\n\n") + "\n", true);
  vd.focus();
}

function pickImage() { return pickFiles("image/*", true).then((f) => insertAssets(f, "image")); }
function pickAttachment() { return pickFiles("", true).then((f) => insertAssets(f, "file")); }

const ICON_IMAGE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v10h14V7H5zm3 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm9 5.5L14 11l-4.5 5.5h8z"/></svg>';
const ICON_CLIP = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M14.5 3a4.5 4.5 0 0 1 4.5 4.5v8a6.5 6.5 0 1 1-13 0V7a1 1 0 0 1 2 0v8.5a4.5 4.5 0 1 0 9 0v-8A2.5 2.5 0 0 0 14.5 5 1 1 0 0 1 14.5 3z"/></svg>';

function mountEditor() {
  const a = appearance();
  vd = new Vditor("vditor", {
    cdn: "/vendor/vditor",
    lang: "zh_CN",
    mode: "ir",                       // 即时渲染（Typora 式所见即所得）
    height: "100%",
    icon: "ant",
    theme: a.editor,
    placeholder: "开始写作，输入 Markdown 语法会即时渲染…",
    toolbarConfig: { pin: false },
    counter: { enable: true, type: "markdown" },
    cache: { enable: false },
    outline: { enable: false, position: "left" },
    preview: { hljs: { style: a.hljs, lineNumber: !!prefs.codeLineNumber }, theme: { current: a.content } },
    toolbar: [
      "headings", "bold", "italic", "strike", "|",
      "line", "quote", "list", "ordered-list", "check", "outdent", "indent", "|",
      "table", "code", "inline-code", "link",
      { name: "netluo-image", icon: ICON_IMAGE, tipPosition: "ne", tipText: "插入图片", click: (e, inst) => pickImage(inst) },
      { name: "netluo-file", icon: ICON_CLIP, tipPosition: "ne", tipText: "插入附件", click: (e, inst) => pickAttachment(inst) },
      "|",
      "edit-mode", "outline", "fullscreen",
    ],
    // 自定义 handler 会完全接管 Vditor 内置的分片上传：粘贴与拖拽进来的图片直接走本站接口，
    // 不引入 multipart 依赖，也不会把文件发往任何第三方地址。
    upload: {
      multiple: true,
      accept: "image/*",
      handler: async (files) => {
        if (readOnly) return "只读模式，无法插入图片";
        await insertAssets(files, "image");
      },
    },
    input: () => {
      if (readOnly) return;
      dirty = true;
      setStatus("未保存");
    },
    after: () => {
      vd.setValue(meta.content);
      dirty = false;
      setStatus(readOnly ? "只读模式" : "就绪");
      if (readOnly) vd.disabled();
    },
  });
}

(async () => {
  if (!fileId) { $("fname").textContent = "缺少文件 id"; return; }
  try {
    prefs = { ...prefs, ...(await TopoTheme.pull() || {}) };
    meta = await api("GET", `/api/files/${fileId}`);
    if (meta.type !== "md") { location.href = `/editor.html?id=${fileId}`; return; }
    $("fname").textContent = meta.name;
    setStatus("获取编辑锁…");
    await acquireLock();
    mountEditor();
  } catch (e) {
    $("fname").textContent = "加载失败: " + e.message;
  }
})();
