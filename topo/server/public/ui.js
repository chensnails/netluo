// 轻量 UI 组件：toast / 确认 / 输入 / 自定义弹窗，替代全站原生 alert/confirm/prompt。
// 全部用 createElement + textContent 构建，文件名等不可信字符串绝不走 innerHTML。
(function () {
  const layers = new Map();   // 唯一 key -> layer，允许弹窗叠加（如历史列表里再开预览）
  const stack = [];           // 打开顺序，最上层才响应 Esc / Tab
  let seq = 0;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function mount(host) {
    const back = el("div", "ui-back hidden");
    const box = el("div", "ui-dlg");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    back.appendChild(box);
    document.body.appendChild(back);
    const layer = { back, box, host };
    layers.set(host, layer);
    return layer;
  }

  function close(layer, value) {
    if (layer.done) return;
    layer.done = true;
    document.removeEventListener("keydown", layer.onKey, true);
    const i = stack.indexOf(layer);
    if (i >= 0) stack.splice(i, 1);
    layer.back.classList.add("closing");
    setTimeout(() => {
      layer.back.remove();
      layers.delete(layer.host);
      const top = stack[stack.length - 1];
      if (top) {
        const auto = top.box.querySelector("[data-autofocus]") || top.box.querySelector("button");
        if (auto) auto.focus();
      }
    }, 140);
    layer.resolve(value);
  }

  // Esc 关闭 + Tab 焦点循环
  function keyNav(layer, onEsc) {
    return (e) => {
      if (stack[stack.length - 1] !== layer) return;
      if (e.key === "Escape") { e.preventDefault(); onEsc(); return; }
      if (e.key !== "Tab") return;
      const f = [...layer.box.querySelectorAll("button, input, textarea, select, [tabindex]:not([tabindex='-1'])")]
        .filter((n) => !n.disabled && n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
  }

  function open(host, build, onEsc) {
    return new Promise((resolve) => {
      const layer = mount(host + ":" + (++seq));
      stack.push(layer);
      layer.resolve = resolve;
      layer.onKey = keyNav(layer, () => close(layer, onEsc ? onEsc() : undefined));
      document.addEventListener("keydown", layer.onKey, true);
      layer.back.onclick = (e) => { if (e.target === layer.back) close(layer, onEsc ? onEsc() : undefined); };
      build(layer);
      layer.back.classList.remove("hidden");
      const auto = layer.box.querySelector("[data-autofocus]") || layer.box.querySelector("input, textarea, button");
      if (auto) setTimeout(() => auto.focus(), 30);
    });
  }

  function footer(btns) {
    const row = el("div", "ui-actions");
    for (const b of btns) {
      const btn = el("button", b.cls || "", b.text);
      btn.onclick = b.onClick;
      if (b.focus) btn.dataset.autofocus = "1";
      row.appendChild(btn);
    }
    return row;
  }

  // ---------- 确认框 ----------
  function confirm({ title = "请确认", message = "", okText = "确定", cancelText = "取消", danger = false } = {}) {
    return open("confirm", (layer) => {
      layer.box.innerHTML = "";
      const box = layer.box;
      box.classList.add("ui-dlg-sm");
      if (title) box.appendChild(el("h3", null, title));
      if (message) box.appendChild(el("p", "ui-msg", message));
      box.appendChild(footer([
        { text: cancelText, cls: "ghost", onClick: () => close(layer, false) },
        { text: okText, cls: danger ? "danger-solid" : "", focus: true, onClick: () => close(layer, true) },
      ]));
    }, () => false);
  }

  // ---------- 单行输入 ----------
  function prompt({ title = "请输入", label = "", value = "", placeholder = "", okText = "确定", cancelText = "取消", validate } = {}) {
    return open("prompt", (layer) => {
      const box = layer.box;
      box.innerHTML = "";
      box.classList.add("ui-dlg-sm");
      if (title) box.appendChild(el("h3", null, title));
      if (label) box.appendChild(el("label", "ui-label", label));
      const input = el("input");
      input.type = "text"; input.value = value; input.placeholder = placeholder || "";
      input.dataset.autofocus = "1";
      box.appendChild(input);
      const err = el("div", "ui-err");
      box.appendChild(err);
      const submit = () => {
        const v = input.value.trim();
        const bad = validate ? validate(v) : (v ? null : "不能为空");
        if (bad) { err.textContent = bad; input.focus(); return; }
        close(layer, v);
      };
      input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
      box.appendChild(footer([
        { text: cancelText, cls: "ghost", onClick: () => close(layer, null) },
        { text: okText, onClick: submit },
      ]));
    }, () => null);
  }

  // ---------- 自定义内容（body 为节点或返回节点的函数），确定按钮回调可异步 ----------
  function dialog({ title = "", okText = "确定", cancelText, body, onOk } = {}) {
    return open("dialog", async (layer) => {
      const box = layer.box;
      box.innerHTML = "";
      box.classList.add("ui-dlg-lg");
      if (title) box.appendChild(el("h3", null, title));
      const wrap = el("div", "ui-body");
      const node = typeof body === "function" ? body() : body;
      if (node) wrap.appendChild(node);
      box.appendChild(wrap);
      const btns = [];
      if (cancelText !== undefined) btns.push({ text: cancelText || "取消", cls: "ghost", onClick: () => close(layer, false) });
      if (onOk) {
        btns.push({
          text: okText, focus: true,
          onClick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try { await onOk(); close(layer, true); }
            catch (err) { btn.disabled = false; toast(err.message || String(err), "err"); }
          },
        });
      }
      box.appendChild(footer(btns));
    }, () => false);
  }

  // ---------- 轻提示 ----------
  let toastHost = null;
  function toast(text, kind = "ok", ms = 2600) {
    if (!toastHost) {
      toastHost = el("div", "ui-toasts");
      document.body.appendChild(toastHost);
    }
    const t = el("div", "ui-toast " + (kind === "err" ? "err" : kind === "warn" ? "warn" : ""), String(text));
    toastHost.appendChild(t);
    setTimeout(() => {
      t.classList.add("out");
      setTimeout(() => { t.remove(); if (!toastHost.children.length) { toastHost.remove(); toastHost = null; } }, 220);
    }, ms);
    return t;
  }

  // ---------- 通用格式化 ----------
  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + " B";
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
    return (v / 1024 / 1024).toFixed(2) + " MB";
  }

  // 后端给的是北京时间 "YYYY-MM-DD HH:MM:SS"
  function parseBeijing(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600 * 1000);
  }

  function relTime(s) {
    const d = parseBeijing(s);
    if (!d) return String(s || "-");
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + " 天前";
    return s.slice(0, 10);
  }

  // ---------- 顶栏主题快捷切换 ----------
  // 本地立即生效；同时抛出事件，由已登录的页面把选择同步回账号设置。
  const THEME_ORDER = ["auto", "light", "dark"];
  function syncThemeBtns() {
    const t = window.TopoTheme ? TopoTheme.resolve() : "light";
    const m = window.TopoTheme ? TopoTheme.mode() : "auto";
    for (const b of document.querySelectorAll("[data-theme-cycle]")) {
      b.textContent = t === "dark" ? "☾" : "☀";
      b.title = `${t === "dark" ? "深色" : "浅色"} · ${m === "auto" ? "跟随系统" : "已锁定"}，点击切换`;
      b.setAttribute("aria-label", b.title);
    }
  }
  document.addEventListener("click", (e) => {
    if (!e.target.closest || !e.target.closest("[data-theme-cycle]") || !window.TopoTheme) return;
    const next = THEME_ORDER[(THEME_ORDER.indexOf(TopoTheme.mode()) + 1) % THEME_ORDER.length];
    TopoTheme.set(next);
    syncThemeBtns();
    document.dispatchEvent(new CustomEvent("topo:themeSet", { detail: { mode: next } }));
  });
  document.addEventListener("topo:theme", syncThemeBtns);
  syncThemeBtns();

  window.UI = { confirm, prompt, dialog, toast, formatBytes, relTime, parseBeijing, syncThemeBtns };
})();
