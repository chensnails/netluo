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
      "table", "code", "inline-code", "link", "|",
      "edit-mode", "outline", "fullscreen",
    ],
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
