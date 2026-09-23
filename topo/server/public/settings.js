const $ = (id) => document.getElementById(id);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = "/"; throw new Error("未登录"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

let settings = {};
let meId = null;

function paintSeg(el, value) {
  for (const btn of el.children) btn.classList.toggle("on", btn.dataset.v === String(value));
}

function wireSeg(el, current, onChange) {
  el.onclick = async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const prev = current();
    paintSeg(el, btn.dataset.v);
    try { await onChange(btn.dataset.v); }
    catch (err) { paintSeg(el, prev); UI.toast("保存失败：" + err.message, "err"); }
  };
  paintSeg(el, current());
}

async function saveSettings(patch) {
  settings = await api("PUT", "/api/settings", patch);
  UI.toast("已保存到账户", "ok", 1500);
}

function paintSettings() {
  paintSeg($("themeSeg"), settings.themeMode);
  paintSeg($("docSeg"), settings.docTheme);
  paintSeg($("lineSeg"), settings.codeLineNumber ? 1 : 0);
  paintSeg($("newSeg"), settings.defaultNewType);
}

async function loadSettings() {
  settings = await api("GET", "/api/settings");
  paintSettings();
}

async function loadShares() {
  const box = $("shareList");
  const shares = await api("GET", "/api/shares");
  box.innerHTML = "";
  if (!shares.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "还没有创建过分享链接";
    box.appendChild(e);
    return;
  }
  for (const s of shares) {
    const url = `${location.origin}/share.html?t=${s.token}`;
    const row = document.createElement("div");
    row.className = "hist-row";
    const name = document.createElement("span");
    name.className = "share-file";
    name.textContent = s.file_name;
    name.title = s.file_name;
    const link = document.createElement("span");
    link.className = "share-url";
    link.textContent = url + (s.hasPassword ? "（有密码）" : "");
    const copy = document.createElement("button");
    copy.className = "ghost sm";
    copy.textContent = "复制";
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(url); UI.toast("链接已复制", "ok", 1500); }
      catch { await UI.prompt({ title: "分享链接", value: url, okText: "知道了" }); }
    };
    const open = document.createElement("button");
    open.className = "ghost sm";
    open.textContent = "打开";
    open.onclick = () => window.open(url, "_blank");
    const revoke = document.createElement("button");
    revoke.className = "danger sm";
    revoke.textContent = "撤销";
    revoke.onclick = async () => {
      const ok = await UI.confirm({ title: "撤销分享", message: `撤销「${s.file_name}」的这条分享链接？撤销后访客立即无法访问。`, okText: "撤销", danger: true });
      if (!ok) return;
      try { await api("DELETE", `/api/shares/${s.token}`); await loadShares(); UI.toast("已撤销"); }
      catch (e) { UI.toast(e.message, "err"); }
    };
    row.append(name, link, copy, open, revoke);
    box.appendChild(row);
  }
}

async function loadStats() {
  const st = await api("GET", "/api/stats");
  const cards = [
    ["文件总数", st.files.count || 0],
    ["拓扑图 / 文档", `${st.files.drawio || 0} / ${st.files.md || 0}`],
    ["目录数", st.folders],
    ["分享链接", st.shares],
    ["历史版本", st.versions.count],
    ["内容占用", UI.formatBytes(st.files.bytes)],
    ["版本库占用", UI.formatBytes(st.versions.bytes)],
    ["最近保存", st.files.last_saved || "-"],
  ];
  const box = $("stats");
  box.innerHTML = "";
  for (const [t, n] of cards) {
    const card = document.createElement("div");
    card.className = "stat";
    const v = document.createElement("div");
    v.className = "n";
    v.textContent = String(n);
    const label = document.createElement("div");
    label.className = "t";
    label.textContent = t;
    card.append(v, label);
    box.appendChild(card);
  }
}

$("logoutBtn").onclick = async () => {
  try { await api("POST", "/api/logout"); } catch { /* 令牌已失效也算退出成功 */ }
  location.href = "/";
};

$("pwBtn").onclick = async () => {
  const msg = $("pwMsg");
  msg.className = "msg";
  msg.textContent = "";
  const oldPassword = $("pwOld").value, newPassword = $("pwNew").value, again = $("pwNew2").value;
  if (!oldPassword || !newPassword) { msg.textContent = "请填写原密码和新密码"; return; }
  if (newPassword !== again) { msg.textContent = "两次输入的新密码不一致"; return; }
  try {
    await api("POST", "/api/change-password", { oldPassword, newPassword });
    msg.className = "msg ok";
    msg.textContent = "密码已修改，其他设备需要重新登录";
    UI.toast("密码已修改", "ok");
    $("pwOld").value = $("pwNew").value = $("pwNew2").value = "";
  } catch (e) { msg.textContent = e.message; }
};

// ---------- 成员管理（仅管理员） ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

async function loadMembers() {
  const box = $("userList");
  const data = await api("GET", "/api/admin/users");
  box.innerHTML = "";
  for (const u of data.users) {
    const row = el("div", "hist-row");
    row.append(el("span", "share-file", u.username));
    row.append(el("span", "badge" + (u.role === "admin" ? " admin" : ""), u.role === "admin" ? "管理员" : "成员"));
    if (u.status !== "active") row.append(el("span", "badge off", "已停用"));
    row.append(el("span", "share-url", `${u.files} 个文件 · 最近登录 ${u.last_login_at || "从未"}`));

    const reset = el("button", "ghost sm", "重置密码");
    reset.onclick = async () => {
      const pw = await UI.prompt({ title: `重置「${u.username}」的密码`, label: "新密码（至少 8 位），对方下次登录即用新密码" });
      if (!pw) return;
      try { await api("POST", `/api/admin/users/${u.id}/password`, { password: pw }); UI.toast("密码已重置", "ok"); }
      catch (e) { UI.toast(e.message, "err"); }
    };

    const toggle = el("button", "ghost sm", u.status === "active" ? "停用" : "启用");
    toggle.onclick = async () => {
      const next = u.status === "active" ? "disabled" : "active";
      const ok = await UI.confirm({
        title: next === "disabled" ? "停用成员" : "启用成员",
        message: next === "disabled"
          ? `停用「${u.username}」？其登录状态立即失效，文件与历史保留，随时可恢复。`
          : `重新启用「${u.username}」？`,
        okText: next === "disabled" ? "停用" : "启用",
        danger: next === "disabled",
      });
      if (!ok) return;
      try { await api("PATCH", `/api/admin/users/${u.id}`, { status: next }); await loadMembers(); UI.toast("已更新"); }
      catch (e) { UI.toast(e.message, "err"); }
    };

    const role = el("button", "ghost sm", u.role === "admin" ? "取消管理员" : "设为管理员");
    role.onclick = async () => {
      const next = u.role === "admin" ? "user" : "admin";
      const ok = await UI.confirm({
        title: "变更角色",
        message: next === "admin"
          ? `把「${u.username}」设为管理员？管理员能管理所有成员账号与整库备份。`
          : `取消「${u.username}」的管理员权限？`,
        okText: "确定",
      });
      if (!ok) return;
      try { await api("PATCH", `/api/admin/users/${u.id}`, { role: next }); await loadMembers(); UI.toast("已更新"); }
      catch (e) { UI.toast(e.message, "err"); }
    };

    row.append(reset, toggle, role);
    if (u.id !== meId) {
      const del = el("button", "danger sm", "删除");
      del.onclick = async () => {
        const typed = await UI.prompt({
          title: `删除「${u.username}」`,
          label: `该成员有 ${u.files} 个文件，会连同历史版本与分享链接一并永久删除。输入用户名以确认：`,
          okText: "下一步",
        });
        if (!typed) return;                                  // 取消或点了遮罩：什么都不做
        if (typed !== u.username) { UI.toast("输入的用户名不一致，已取消", "err"); return; }
        const sure = await UI.confirm({
          title: "确认永久删除",
          message: `「${u.username}」的 ${u.files} 个文件、历史版本与分享链接都会被删除，无法恢复。建议先下载整库备份。`,
          okText: "永久删除",
          danger: true,
        });
        if (!sure) return;
        try {
          await api("DELETE", `/api/admin/users/${u.id}`, { confirm: typed });
          await loadMembers();
          UI.toast("已删除");
        } catch (e) { UI.toast(e.message, "err"); }
      };
      row.append(del);
    }
    box.appendChild(row);
  }
  $("regState").textContent = data.registrationOpen
    ? "已开放：访问者在登录页凭注册码自助建号（新账号默认为普通成员）"
    : "未开放：只有管理员能创建账号。如需开放，在 .env 中设置 REGISTRATION_CODE 后重启容器";
  $("instanceInfo").textContent =
    `运行版本 ${data.version} · 数据库结构 v${data.schemaVersion} · 共 ${data.users.length} 个账号`;
}

$("newUserBtn").onclick = async () => {
  const msg = $("userMsg");
  msg.className = "msg";
  msg.textContent = "";
  try {
    const r = await api("POST", "/api/admin/users", { username: $("nu").value.trim(), password: $("np").value, role: $("nr").value });
    msg.className = "msg ok";
    msg.textContent = `已创建「${r.username}」，把初始密码告知对方即可`;
    $("nu").value = $("np").value = "";
    await loadMembers();
  } catch (e) { msg.textContent = e.message; }
};

$("backupBtn").onclick = () => { location.href = "/api/admin/backup"; };

$("exportBtn").onclick = () => { location.href = "/api/export.zip"; };

// 顶栏快捷切换：本地已生效，这里写回账号并同步分段控件
document.addEventListener("topo:themeSet", async (e) => {
  settings.themeMode = e.detail.mode;
  paintSeg($("themeSeg"), e.detail.mode);
  try { settings = await api("PUT", "/api/settings", { themeMode: e.detail.mode }); }
  catch (err) { UI.toast("主题保存失败：" + err.message, "err"); }
});

(async () => {
  const me = await api("GET", "/api/me");
  meId = me.id;
  $("whoami").textContent = me.username;
  $("uname").textContent = me.username;
  const pulled = await TopoTheme.pull();
  if (pulled) { settings = pulled; paintSettings(); } else await loadSettings();

  wireSeg($("themeSeg"), () => settings.themeMode, async (v) => { TopoTheme.set(v); await saveSettings({ themeMode: v }); });
  wireSeg($("docSeg"), () => settings.docTheme, (v) => saveSettings({ docTheme: v }));
  wireSeg($("lineSeg"), () => (settings.codeLineNumber ? 1 : 0), (v) => saveSettings({ codeLineNumber: v === "1" }));
  wireSeg($("newSeg"), () => settings.defaultNewType, (v) => saveSettings({ defaultNewType: v }));

  loadShares();
  loadStats();
  if (me.role === "admin") {
    $("membersCard").classList.remove("hidden");
    loadMembers().catch((e) => { $("userList").innerHTML = ""; UI.toast(e.message, "err"); });
  }
})();
