const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get("t") || "";
let data = null;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(d.error || res.statusText), { status: res.status });
  return d;
}

function post(msg) {
  if (!drawioOrigin) return;
  $("frame").contentWindow.postMessage(JSON.stringify(msg), drawioOrigin);
}
let drawioOrigin = null;

window.addEventListener("message", (event) => {
  // 只认 drawio 框架自己发来的消息，第三方框架不能伪造 init/save
  if (event.source !== $("frame").contentWindow) return;
  if (!drawioOrigin || event.origin !== drawioOrigin) return;
  let evt;
  try { evt = JSON.parse(event.data); } catch { return; }
  if (evt.event === "init") {
    CanvasWatch.done();
    post({ action: "load", xml: data.content, defaultEmpty: "*" });
    post({ action: "status", message: "只读分享", modified: false });
  } else if (evt.event === "save" || evt.event === "autosave" || evt.event === "export") {
    post({ action: "status", message: "只读分享，无法保存", modified: false });
  }
});

async function openEditor() {
  const config = await api("GET", "/api/config");
  $("fname").textContent = data.name;
  $("status").textContent = `v${data.version} · ${data.updated_at}`;
  $("gate").classList.add("hidden");
  if (data.type === "md") {
    document.title = data.name;
    const view = $("mdView");
    view.innerHTML = window.markdownit({ html: false, linkify: true }).render(data.content);
    view.classList.remove("hidden");
    return;
  }
  const frame = $("frame");
  frame.parentElement.classList.remove("hidden");
  frame.classList.remove("hidden");
  const base = config.drawioUrl.replace(/\/+$/, "");
  drawioOrigin = new URL(base).origin;
  frame.src = `${base}/?embed=1&proto=json&spin=1&lang=zh&noExitBtn=1&modified=0${TopoTheme.resolve() === "dark" ? "&dark=1" : ""}`;
  CanvasWatch.start(frame, frame.src);
}

async function loadContent() {
  data = await api("GET", `/api/share/${encodeURIComponent(token)}/content`);
  await openEditor();
}

(async () => {
  if (!token) { $("fname").textContent = "缺少分享参数"; return; }
  try {
    const meta = await api("GET", `/api/share/${encodeURIComponent(token)}`);
    if (meta.hasPassword) {
      $("fname").textContent = meta.name;
      $("gate").classList.remove("hidden");
      $("gateBtn").onclick = async () => {
        $("gateMsg").textContent = "";
        try {
          await api("POST", `/api/share/${encodeURIComponent(token)}`, { password: $("pw").value });
          await loadContent();
        } catch (e) { $("gateMsg").textContent = e.message; }
      };
      $("pw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("gateBtn").click(); });
    } else {
      // 无密码（或本浏览器已用密码解锁过）：直接取内容
      await loadContent();
    }
  } catch (e) {
    $("fname").textContent = "分享不可用: " + e.message;
  }
})();
