const $ = (id) => document.getElementById(id);
const fileId = new URLSearchParams(location.search).get("id");
const frame = $("frame");
let meta = null;       // { name, content, version }
let pending = null;    // 尚未同步到服务器的 xml
let expectedOrigin = null;   // 由 /api/config 的 drawio 地址算出，不用等 init 事件才生效
let readOnly = false;
let hbTimer = null;
let manualSave = false;

function setStatus(text) { $("status").textContent = text || ""; }
function setReadOnly(msg) {
  readOnly = true;
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  $("saveBtn").style.display = "none";
  const b = $("lockBanner");
  b.textContent = msg;
  b.classList.remove("hidden");
  UI.toast(msg, "warn", 6000);
}

// 版本冲突：本次改动仍在本地，给用户一个明确的出口
function showConflict() {
  const box = document.createElement("div");
  const p1 = document.createElement("p");
  p1.className = "ui-msg";
  p1.textContent = "该文件已在其他地方被修改（版本冲突），本次改动没有保存。";
  const p2 = document.createElement("p");
  p2.className = "ui-msg";
  p2.textContent = "建议先下载本地备份，再刷新页面载入服务器版本；也可以留在本页继续编辑，稍后重试保存。";
  box.append(p1, p2);
  UI.dialog({
    title: "保存冲突",
    body: box,
    okText: "下载本地备份",
    cancelText: "留在本页",
    onOk: () => {
      if (pending === null) throw new Error("没有可导出的改动");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([pending], { type: "application/xml" }));
      a.download = `${meta.name}-本地备份-v${meta.version}.drawio`;
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

function post(msg) {
  if (!expectedOrigin) return;
  frame.contentWindow.postMessage(JSON.stringify(msg), expectedOrigin);
}

async function save(source) {
  if (readOnly) {
    post({ action: "status", message: "只读模式，无法保存", modified: false });
    if (source === "manual") UI.toast("只读模式，无法保存", "warn");
    return;
  }
  if (pending === null) { setStatus("无改动"); if (source === "manual") UI.toast("没有需要保存的改动", "warn", 1600); return; }
  try {
    const r = await api("PUT", `/api/files/${fileId}`, { content: pending, baseVersion: meta.version });
    meta.version = r.version;
    pending = null;
    setStatus(`已保存 v${r.version}`);
    post({ action: "status", message: "已保存", modified: false });
    if (source === "manual") UI.toast(`已保存 v${r.version}`, "ok", 1600);
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

window.addEventListener("message", async (event) => {
  // 只接受来自 drawio iframe 本身、且 origin 匹配的消息：否则任何第三方框架在 init 之前
  // 都能伪造 save/export 事件，把任意内容写进当前文件
  if (event.source !== frame.contentWindow) return;
  if (!expectedOrigin || event.origin !== expectedOrigin) return;
  let evt;
  try { evt = JSON.parse(event.data); } catch { return; }
  if (evt.event === "init") {
    CanvasWatch.done();
    post({ action: "load", xml: meta.content, defaultEmpty: "*", url: location.href });
    setStatus("就绪");
  } else if (evt.event === "save" || evt.event === "autosave") {
    pending = evt.xml;
    save(evt.event === "save" ? "manual" : null);
  } else if (evt.event === "export") {
    if (evt.xml) { pending = evt.xml; save(manualSave ? "manual" : null); manualSave = false; }
  } else if (evt.event === "exit") {
    location.href = "/";
  }
});

$("saveBtn").onclick = () => {
  if (readOnly) { UI.toast("只读模式，无法保存", "warn"); return; }
  manualSave = true;
  setStatus("读取画布…");
  post({ action: "export", format: "xml" });
};
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); $("saveBtn").click(); }
});
window.addEventListener("pagehide", () => {
  if (readOnly) return;
  if (pending !== null) {
    fetch(`/api/files/${fileId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: pending, baseVersion: meta.version }),
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

(async () => {
  if (!fileId) { $("fname").textContent = "缺少文件 id"; return; }
  try {
    const config = await api("GET", "/api/config");
    if (!config.drawioUrl) { $("fname").textContent = "服务器未配置 DRAWIO_URL"; return; }
    try {
      expectedOrigin = new URL(config.drawioUrl).origin;
    } catch {
      $("fname").textContent = "DRAWIO_URL 配置无法解析，已停止加载";
      return;
    }
    meta = await api("GET", `/api/files/${fileId}`);
    $("fname").textContent = meta.name;
    setStatus("获取编辑锁…");
    await acquireLock();
    if (!readOnly) setStatus("编辑器加载中…");
    await TopoTheme.pull();
    const dark = TopoTheme.resolve() === "dark" ? "&dark=1" : "";
    const base = config.drawioUrl.replace(/\/+$/, "");
    frame.src = `${base}/?embed=1&proto=json&spin=1&lang=zh&noExitBtn=1${dark}`;
    CanvasWatch.start(frame, frame.src);
  } catch (e) {
    $("fname").textContent = "加载失败: " + e.message;
  }
})();
