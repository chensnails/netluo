const $ = (id) => document.getElementById(id);

const state = {
  folders: [],      // {id, name, parent_id}
  files: [],        // {id, name, type, version, folder_id, updated_at, locked_by}
  selected: null,   // 当前目录 id，null = 根
  expanded: new Set([null]),
  query: "",        // 搜索关键字
  deep: false,      // 是否连子目录一起搜
  active: null,     // 键盘选中的文件 id
  prefs: { defaultNewType: "drawio" },
};

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !/\/api\/(login|register)$/.test(url)) { showLogin(); throw new Error("unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

function showLogin() { $("appView").classList.add("hidden"); $("loginView").classList.remove("hidden"); }
function showApp(username) {
  $("loginView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  $("whoami").textContent = username;
  refresh();
}

async function refresh() {
  const t = await api("GET", "/api/tree");
  state.folders = t.folders;
  state.files = t.files;
  renderTree();
  renderList();
}

// ---------- helpers ----------
const childFolders = (pid) => state.folders.filter((f) => f.parent_id === pid);
const folderFiles = (fid) => state.files.filter((f) => f.folder_id === fid);
const folderById = (id) => state.folders.find((f) => f.id === id);
const fileHref = (f) => f.type === "md" ? `/md.html?id=${f.id}` : `/editor.html?id=${f.id}`;
const typeLabel = (f) => f.type === "md" ? "文档" : "拓扑图";
const fileExt = (f) => f.type === "md" ? ".md" : ".drawio";
const NEW_LABELS = { drawio: "＋ 新建拓扑", md: "＋ 新建文档" };

function walkFolders(rootId, visit) {
  // seen 兼作环保护：目录数据异常时不能把页面卡死
  const seen = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of childFolders(cur)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      visit(c);
      stack.push(c.id);
    }
  }
}

function descendantFolderIds(id) {
  const out = [];
  walkFolders(id, (c) => out.push(c.id));
  return out;
}

function visibleFiles() {
  const q = state.query.trim().toLowerCase();
  let list;
  if (state.deep && state.selected !== null) {
    const inTree = new Set([state.selected, ...descendantFolderIds(state.selected)]);
    list = state.files.filter((f) => inTree.has(f.folder_id));
  } else {
    list = folderFiles(state.selected);
  }
  if (q) list = list.filter((f) => f.name.toLowerCase().includes(q));
  return list;
}

function folderPath(id) {
  const parts = [];
  const seen = new Set();
  let cur = id;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const f = folderById(cur);
    if (!f) break;
    parts.unshift({ id: f.id, name: f.name });
    cur = f.parent_id;
  }
  return parts;
}
const pathText = (id) => folderPath(id).map((p) => p.name).join(" / ");

// ---------- tree ----------
function renderTree() {
  const box = $("tree");
  box.innerHTML = "";
  box.appendChild(nodeRow({ label: "全部文件", id: null, hasKids: true, depth: 0 }));
  const kids = document.createElement("div");
  kids.className = "tree-kids";
  renderFolderKids(kids, null, 1);
  if (state.expanded.has(null)) box.appendChild(kids);
}

function renderFolderKids(container, pid, depth) {
  for (const f of childFolders(pid)) {
    container.appendChild(nodeRow({ label: f.name, id: f.id, folder: f, hasKids: childFolders(f.id).length || folderFiles(f.id).length, depth }));
    if (state.expanded.has(f.id)) {
      const kids = document.createElement("div");
      kids.className = "tree-kids";
      renderFolderKids(kids, f.id, depth + 1);
      container.appendChild(kids);
    }
  }
  for (const file of folderFiles(pid)) {
    const row = document.createElement("div");
    row.className = "tree-node file " + (file.type === "md" ? "t-md" : "t-drawio");
    row.style.paddingLeft = depth * 16 + 6 + "px";
    const tw = document.createElement("span");
    tw.className = "tw";
    tw.textContent = file.type === "md" ? "▤" : "▫";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = (file.locked_by ? "🔒 " : "") + file.name;
    nm.title = file.name;
    row.append(tw, nm);
    row.onclick = () => { location.href = fileHref(file); };
    container.appendChild(row);
  }
}

function nodeRow({ label, id, folder, hasKids, depth }) {
  const row = document.createElement("div");
  row.className = "tree-node" + (state.selected === id ? " selected" : "");
  row.style.paddingLeft = depth * 16 + 2 + "px";
  const tw = document.createElement("span");
  tw.className = "tw";
  tw.textContent = hasKids ? (state.expanded.has(id) ? "▾" : "▸") : "·";
  tw.onclick = (e) => {
    e.stopPropagation();
    if (!hasKids && id !== null) return;
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    renderTree();
  };
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = label;
  nm.title = label;
  row.append(tw, nm);
  if (id !== null) {
    const cnt = document.createElement("span");
    cnt.className = "cnt";
    cnt.textContent = folderFiles(id).length || "";
    row.appendChild(cnt);
    row.appendChild(hoverBtn("✎", "重命名", () => renameFolder(folder)));
    row.appendChild(hoverBtn("✕", "删除", () => deleteFolder(folder)));
    const add = hoverBtn("＋", "新建子目录", () => createFolder(id));
    add.style.display = state.selected === id ? "" : "none";
    row.appendChild(add);
  }
  row.onclick = () => selectFolder(id);
  return row;
}

function selectFolder(id) {
  state.selected = id;
  state.expanded.add(id);
  state.active = null;
  renderTree();
  renderList();
}

function hoverBtn(text, title, fn) {
  const b = document.createElement("button");
  b.className = "ghost sm tree-op";
  b.textContent = text;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onclick = (e) => { e.stopPropagation(); fn(); };
  return b;
}

// ---------- list ----------
function highlight(name) {
  const q = state.query.trim();
  const frag = document.createDocumentFragment();
  if (!q) { frag.append(document.createTextNode(name)); return frag; }
  const i = name.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) { frag.append(document.createTextNode(name)); return frag; }
  frag.append(document.createTextNode(name.slice(0, i)));
  const mark = document.createElement("mark");
  mark.textContent = name.slice(i, i + q.length);
  frag.append(mark, document.createTextNode(name.slice(i + q.length)));
  return frag;
}

function renderList() {
  const path = folderPath(state.selected);
  const crumb = $("crumb");
  crumb.innerHTML = "";
  const mk = (text, id) => {
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = text;
    a.onclick = (e) => { e.preventDefault(); selectFolder(id); };
    return a;
  };
  crumb.append(mk("全部文件", null));
  path.forEach((p) => {
    crumb.append(document.createTextNode(" / "));
    crumb.append(mk(p.name, p.id));
  });
  if (!path.length) $("deepChk").checked = false;   // 控件隐藏时不能悄悄留着生效
  $("deepWrap").classList.toggle("hidden", !path.length);

  const subs = childFolders(state.selected);
  const files = visibleFiles();
  const tbody = $("fileRows");
  tbody.innerHTML = "";
  for (const f of subs) {
    const tr = document.createElement("tr");
    tr.className = "row-folder";
    const name = document.createElement("td");
    name.textContent = "📁 " + f.name;
    const tdType = document.createElement("td"); tdType.textContent = "目录";
    const tdVer = document.createElement("td"); tdVer.textContent = "";
    const tdUp = document.createElement("td");
    tdUp.textContent = folderFiles(f.id).length + " 项";
    const tdAct = document.createElement("td"); tdAct.className = "actions";
    tdAct.append(
      mkBtn("打开", "ghost sm", () => selectFolder(f.id)),
      mkBtn("重命名", "ghost sm", () => renameFolder(f)),
      mkBtn("删除", "danger sm", () => deleteFolder(f))
    );
    tr.append(name, tdType, tdVer, tdUp, tdAct);
    tr.onclick = (e) => { if (!e.target.closest("button")) selectFolder(f.id); };
    tbody.appendChild(tr);
  }
  for (const file of files) {
    const tr = document.createElement("tr");
    tr.dataset.id = file.id;
    if (state.active === file.id) tr.classList.add("active");
    const name = document.createElement("td");
    name.className = "cell-name";
    const a = document.createElement("a");
    a.className = "file-link " + (file.type === "md" ? "t-md" : "t-drawio");
    a.href = fileHref(file);
    a.append(highlight(file.name));
    name.appendChild(a);
    if (file.locked_by) {
      const badge = document.createElement("span");
      badge.className = "lock-badge";
      badge.textContent = "🔒 " + file.locked_by;
      badge.title = `${file.locked_by} 正在编辑`;
      name.appendChild(badge);
    }
    const tdType = document.createElement("td");
    const tag = document.createElement("span");
    tag.className = "type-tag " + (file.type === "md" ? "t-md" : "t-drawio");
    tag.textContent = typeLabel(file);
    tdType.appendChild(tag);
    const tdVer = document.createElement("td");
    tdVer.textContent = "v" + file.version;
    tdVer.title = file.updated_at;
    const tdUp = document.createElement("td");
    tdUp.textContent = UI.relTime(file.updated_at);
    tdUp.title = file.updated_at + "（北京时间）";
    const tdAct = document.createElement("td"); tdAct.className = "actions";
    tdAct.append(
      mkBtn("下载", "ghost sm", () => download(file)),
      mkBtn("历史", "ghost sm", () => openHistoryDialog(file)),
      mkBtn("分享", "ghost sm", () => openShareDialog(file)),
      mkBtn("重命名", "ghost sm", () => renameFile(file)),
      mkBtn("移动", "ghost sm", () => openMoveDialog(file.id)),
      mkBtn("删除", "danger sm", () => deleteFile(file))
    );
    tr.append(name, tdType, tdVer, tdUp, tdAct);
    tr.onclick = (e) => {
      if (e.target.closest("button")) return;
      state.active = file.id;
      tbody.querySelectorAll("tr.active").forEach((r) => r.classList.remove("active"));
      tr.classList.add("active");
    };
    tr.ondblclick = (e) => { if (!e.target.closest("button")) location.href = fileHref(file); };
    tbody.appendChild(tr);
  }
  const tip = $("emptyTip");
  tip.innerHTML = "";
  if (!files.length && !subs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const q = state.query.trim();
    empty.append(
      document.createTextNode(q ? "没有匹配 " + q + " 的文件" : (state.selected === null ? "还没有任何文件" : "这个目录还是空的")),
    );
    if (!q) {
      const acts = document.createElement("div");
      acts.className = "empty-acts";
      acts.append(
        mkBtn("＋ 新建拓扑", "", () => createFile("drawio")),
        mkBtn("＋ 新建文档", "ghost", () => createFile("md")),
        mkBtn("导入文件", "ghost", () => $("importInput").click())
      );
      empty.appendChild(acts);
    }
    tip.appendChild(empty);
  } else if (!files.length && subs.length) {
    tip.textContent = state.query.trim() ? "（此目录没有匹配的文件，只有子目录）" : "";
  }
  $("countTip").textContent = files.length ? `${files.length} 个文件` : "";
}

function mkBtn(text, cls, fn) {
  const b = document.createElement("button");
  b.textContent = text; b.className = cls; b.onclick = fn;
  return b;
}

const nameRule = (label) => (v) => !v ? `${label}不能为空` : v.length > 200 ? `${label}最长 200 个字符` : null;

// ---------- folder / file ops ----------
async function createFolder(parentId) {
  const name = await UI.prompt({ title: "新建文件夹", label: parentId === null ? "创建在根目录" : "创建在：" + pathText(parentId), placeholder: "文件夹名称", validate: nameRule("名称") });
  if (!name) return;
  try {
    await api("POST", "/api/folders", { name, parentId });
    if (parentId !== null) state.expanded.add(parentId);
    if (parentId !== null) state.selected = parentId;
    await refresh();
    UI.toast("已创建文件夹 " + name);
  } catch (e) { UI.toast(e.message, "err"); }
}

async function renameFolder(f) {
  const name = await UI.prompt({ title: "重命名文件夹", value: f.name });
  if (!name || name === f.name) return;
  try { await api("PATCH", `/api/folders/${f.id}`, { name }); await refresh(); UI.toast("已重命名"); }
  catch (e) { UI.toast(e.message, "err"); }
}

async function deleteFolder(f) {
  const subs = countDescendants(f.id);
  const nFiles = countFilesIn(f.id);
  const ok = await UI.confirm({
    title: "删除文件夹",
    message: subs || nFiles ? `删除「${f.name}」将级联删除 ${subs} 个子目录和 ${nFiles} 个文件，且无法恢复。` : `删除空文件夹「${f.name}」？`,
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await api("DELETE", `/api/folders/${f.id}?recursive=1`);
    if (state.selected === f.id) state.selected = null;
    await refresh();
    UI.toast("已删除文件夹");
  } catch (e) { UI.toast(e.message, "err"); }
}

function countDescendants(id) {
  let n = 0;
  walkFolders(id, () => n++);
  return n;
}
function countFilesIn(id) {
  let n = folderFiles(id).length;
  walkFolders(id, (c) => { n += folderFiles(c.id).length; });
  return n;
}

async function renameFile(file) {
  const name = await UI.prompt({ title: "重命名", value: file.name, validate: (v) => v ? null : "名称不能为空" });
  if (!name || name === file.name) return;
  try { await api("PATCH", `/api/files/${file.id}`, { name }); await refresh(); UI.toast("已重命名"); }
  catch (e) { UI.toast(e.message, "err"); }
}

async function deleteFile(file) {
  const ok = await UI.confirm({
    title: "删除文件",
    message: `删除「${file.name}」？其 ${file.version} 个历史版本与分享链接会一并删除，无法恢复。`,
    okText: "删除", danger: true,
  });
  if (!ok) return;
  try {
    await api("DELETE", `/api/files/${file.id}`);
    await refresh();
    UI.toast("已删除 " + file.name);
  } catch (e) { UI.toast(e.message, "err"); }
}

// ---------- 移动 ----------
function openMoveDialog(fileId) {
  const sel = document.createElement("select");
  sel.className = "ui-select";
  const opt = (text, value) => {
    const o = document.createElement("option");
    o.value = value ?? ""; o.textContent = text;
    sel.appendChild(o);
  };
  opt("根目录", null);
  const walk = (pid, depth) => {
    for (const f of childFolders(pid)) {
      opt("　".repeat(depth) + "📁 " + f.name, f.id);
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  UI.dialog({
    title: "移动到",
    body: sel,
    onOk: async () => {
      const v = sel.value;
      await api("PATCH", `/api/files/${fileId}`, { folderId: v === "" ? null : Number(v) });
      await refresh();
      UI.toast("已移动");
    },
  });
}

// ---------- 版本历史 ----------
async function openHistoryDialog(file) {
  const versions = await api("GET", `/api/files/${file.id}/versions`);
  const box = document.createElement("div");
  box.className = "hist-list";
  if (!versions.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "暂无历史版本（保存一次后生成）";
    box.appendChild(e);
  }
  for (const v of versions) {
    const line = document.createElement("div");
    line.className = "hist-row";
    const label = document.createElement("span");
    label.textContent = `v${v.version} · ${v.author || "?"} · ${UI.relTime(v.created_at)} · ${UI.formatBytes(v.size)}`;
    label.title = v.created_at;
    line.appendChild(label);
    if (v.version === file.version) {
      const tag = document.createElement("span");
      tag.className = "hist-cur";
      tag.textContent = "当前";
      line.appendChild(tag);
    } else {
      line.appendChild(mkBtn("下载", "ghost sm", async () => {
        try {
          const d = await api("GET", `/api/files/${file.id}/versions/${v.version}`);
          downloadBlob(d.content, `${file.name}-v${v.version}${fileExt(file)}`);
        } catch (e) { UI.toast(e.message, "err"); }
      }));
      if (file.type === "md") {
        line.appendChild(mkBtn("预览", "ghost sm", async () => {
          try {
            const d = await api("GET", `/api/files/${file.id}/versions/${v.version}`);
            previewMarkdown(d.content, `${file.name} · v${v.version}`);
          } catch (e) { UI.toast(e.message, "err"); }
        }));
      }
      line.appendChild(mkBtn("还原", "ghost sm", async () => {
        const ok = await UI.confirm({ title: "还原版本", message: `把「${file.name}」还原到 v${v.version}？当前内容会保留在历史里。`, okText: "还原" });
        if (!ok) return;
        try {
          await api("POST", `/api/files/${file.id}/lock`);
          const r = await api("POST", `/api/files/${file.id}/restore`, { version: v.version });
          await refresh();
          UI.toast(`已还原，新版本 v${r.version}`);
        } catch (e) {
          if (e.status === 423) UI.toast("该文件正被他人编辑，无法还原", "warn");
          else UI.toast(e.message, "err");
        }
      }));
    }
    box.appendChild(line);
  }
  UI.dialog({ title: "版本历史 · " + file.name, body: box, okText: "", cancelText: undefined, onOk: undefined });
}

function loadMarkdownIt() {
  if (window.markdownit) return Promise.resolve();
  if (!document.querySelector("script[data-mdit]")) {
    const s = document.createElement("script");
    s.src = "/vendor/markdown-it.min.js";
    s.dataset.mdit = "1";
    document.head.appendChild(s);
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (window.markdownit) resolve();
      else if (Date.now() - started > 6000) reject(new Error("markdown-it 加载超时"));
      else setTimeout(poll, 100);
    };
    poll();
  });
}

function previewMarkdown(text, title) {
  const host = document.createElement("div");
  host.className = "md-body";
  host.textContent = "渲染中…";
  UI.dialog({ title, body: host, cancelText: "关闭" });
  loadMarkdownIt().then(() => {
    const div = document.createElement("div");
    div.innerHTML = window.markdownit({ html: false, linkify: true }).render(text);
    host.replaceChildren(div);
  }).catch((e) => { host.textContent = e.message; });
}

// ---------- 分享 ----------
async function openShareDialog(file) {
  const box = document.createElement("div");
  async function renderShares() {
    box.innerHTML = "";
    const shares = await api("GET", `/api/files/${file.id}/shares`);
    if (shares.length) {
      for (const s of shares) {
        const url = `${location.origin}/share.html?t=${s.token}`;
        const row = document.createElement("div");
        row.className = "hist-row";
        const link = document.createElement("span");
        link.className = "share-url";
        link.textContent = url + (s.hasPassword ? "（有密码）" : "");
        row.appendChild(link);
        row.appendChild(mkBtn("复制", "ghost sm", async () => {
          try { await navigator.clipboard.writeText(url); UI.toast("链接已复制"); }
          catch { UI.prompt({ title: "复制链接", value: url, okText: "知道了" }); }
        }));
        row.appendChild(mkBtn("打开", "ghost sm", () => window.open(url, "_blank")));
        row.appendChild(mkBtn("撤销", "danger sm", async () => {
          const ok = await UI.confirm({ title: "撤销分享", message: "撤销后该链接立即失效。", okText: "撤销", danger: true });
          if (!ok) return;
          try { await api("DELETE", `/api/shares/${s.token}`); renderShares(); UI.toast("已撤销"); }
          catch (e) { UI.toast(e.message, "err"); }
        }));
        box.appendChild(row);
      }
    } else {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "暂无分享链接";
      box.appendChild(e);
    }
    const form = document.createElement("div");
    form.className = "share-form";
    const pw = document.createElement("input");
    pw.type = "text";
    pw.placeholder = "访问密码（留空则无需密码）";
    pw.autocomplete = "off";
    form.appendChild(pw);
    form.appendChild(mkBtn("＋ 生成新链接", "", async () => {
      try {
        const r = await api("POST", `/api/files/${file.id}/shares`, { password: pw.value || undefined });
        pw.value = "";
        await renderShares();
        try { await navigator.clipboard.writeText(`${location.origin}/share.html?t=${r.token}`); UI.toast("已生成并复制链接"); }
        catch { UI.toast("已生成分享链接"); }
      } catch (e) { UI.toast(e.message, "err"); }
    }));
    box.appendChild(form);
  }
  renderShares();
  UI.dialog({ title: "分享 · " + file.name, body: box, cancelText: "关闭" });
}

// ---------- file ops ----------
function downloadBlob(text, filename) {
  const blob = new Blob([text], { type: "application/xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function download(file) {
  try {
    const f = await api("GET", `/api/files/${file.id}`);
    const ext = fileExt(f);
    downloadBlob(f.content, f.name.toLowerCase().endsWith(ext) ? f.name : f.name + ext);
  } catch (e) { UI.toast(e.message, "err"); }
}

async function importFiles(list) {
  const files = [...list];
  if (!files.length) return;
  let done = 0, failed = 0;
  for (const file of files) {
    if (file.size > 5 * 1024 * 1024) { UI.toast(`${file.name} 超过 5MB，已跳过`, "warn"); failed++; continue; }
    try {
      const content = await file.text();
      const type = /\.md$/i.test(file.name) ? "md" : "drawio";
      const name = file.name.replace(/\.(drawio|xml|md)$/i, "") || file.name;
      await api("POST", "/api/files", { name, type, content, folderId: state.selected });
      done++;
    } catch { failed++; }
  }
  await refresh();
  if (done) UI.toast(`已导入 ${done} 个文件${failed ? `，${failed} 个失败` : ""}`);
  else if (failed) UI.toast("导入失败", "err");
}

// ---------- 事件绑定 ----------
function setLoginMode(reg) {
  $("loginForm").classList.toggle("hidden", reg);
  $("registerForm").classList.toggle("hidden", !reg);
  $(reg ? "regMsg" : "loginMsg").textContent = "";
  const focus = reg ? $("ru") : $("lu");
  focus.focus();
  if (location.hash !== (reg ? "#register" : "#login")) history.replaceState(null, "", reg ? "#register" : "#login");
}
$("regLink").onclick = (e) => { e.preventDefault(); setLoginMode(true); };
$("backLink").onclick = (e) => { e.preventDefault(); setLoginMode(false); };

$("loginBtn").onclick = async () => {
  $("loginMsg").textContent = "";
  try {
    const r = await api("POST", "/api/login", { username: $("lu").value.trim(), password: $("lp").value });
    showApp(r.username);
  } catch (e) { $("loginMsg").textContent = e.message === "unauthorized" ? "用户名或密码错误" : e.message; }
};
$("lp").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); });
$("rc").addEventListener("keydown", (e) => { if (e.key === "Enter") $("regBtn").click(); });
$("regBtn").onclick = async () => {
  $("regMsg").textContent = "";
  try {
    const r = await api("POST", "/api/register", {
      username: $("ru").value.trim(), password: $("rp").value, code: $("rc").value,
    });
    showApp(r.username);
  } catch (e) { $("regMsg").textContent = e.message; }
};
$("logoutBtn").onclick = async () => {
  try { await api("POST", "/api/logout"); } catch { /* 令牌已失效也算退出成功 */ }
  location.href = "/";
};

async function createFile(type) {
  const isMd = type === "md";
  const name = await UI.prompt({
    title: isMd ? "新建文档" : "新建拓扑图",
    label: "创建在：" + (pathText(state.selected) || "根目录"),
    value: (isMd ? "新建文档-" : "新建拓扑-") + new Date().toLocaleString("zh-CN"),
  });
  if (!name) return;
  try {
    const r = await api("POST", "/api/files", { name, type, folderId: state.selected });
    location.href = isMd ? `/md.html?id=${r.id}` : `/editor.html?id=${r.id}`;
  } catch (e) { UI.toast(e.message, "err"); }
}

function applyNewButtons() {
  const primary = state.prefs.defaultNewType === "md" ? "md" : "drawio";
  const secondary = primary === "md" ? "drawio" : "md";
  $("newPrimary").textContent = NEW_LABELS[primary];
  $("newSecondary").textContent = NEW_LABELS[secondary];
  $("newPrimary").onclick = () => createFile(primary);
  $("newSecondary").onclick = () => createFile(secondary);
  state.newTypes = { primary, secondary };
}
applyNewButtons();

$("newFolderBtn").onclick = () => createFolder(state.selected);
$("newFolderRootBtn").onclick = () => createFolder(null);
$("importBtn").onclick = () => $("importInput").click();
$("importInput").onchange = (e) => { importFiles(e.target.files); e.target.value = ""; };
$("searchInput").oninput = (e) => { state.query = e.target.value; renderList(); };
$("deepChk").onchange = (e) => { state.deep = e.target.checked; renderList(); };
$("helpBtn").onclick = showHelp;
document.addEventListener("topo:themeSet", (e) => {
  state.prefs.themeMode = e.detail.mode;
  api("PUT", "/api/settings", { themeMode: e.detail.mode }).catch(() => {});
});

function showHelp() {
  const rows = [
    ["/ 或 Ctrl+K", "聚焦搜索框"],
    ["N", "新建（按默认类型）"],
    ["Shift+N", "新建另一种类型"],
    ["↑ / ↓", "在文件列表中移动"],
    ["Enter", "打开选中项"],
    ["Delete", "删除选中项"],
    ["Esc", "清空搜索 / 关闭弹窗"],
    ["?", "显示本帮助"],
  ];
  const box = document.createElement("div");
  box.className = "kbd-list";
  for (const [k, d] of rows) {
    const line = document.createElement("div");
    line.className = "kbd-row";
    const key = document.createElement("kbd");
    key.textContent = k;
    line.append(key, document.createTextNode(d));
    box.appendChild(line);
  }
  UI.dialog({ title: "键盘快捷键", body: box, cancelText: "关闭" });
}

document.addEventListener("keydown", (e) => {
  if (document.querySelector(".ui-back:not(.hidden)")) return;   // 弹窗优先
  const tag = (e.target.tagName || "").toLowerCase();
  const typing = tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable
    || (tag === "button" && e.key === "Enter");   // Enter 留给聚焦的按钮本身
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("searchInput").focus(); $("searchInput").select(); return; }
  if (typing) {
    if (e.key === "Escape") { $("searchInput").value = ""; state.query = ""; renderList(); e.target.blur(); }
    return;
  }
  if (e.key === "/") { e.preventDefault(); $("searchInput").focus(); }
  else if (e.key === "?") { e.preventDefault(); showHelp(); }
  else if (e.key.toLowerCase() === "n") { e.preventDefault(); createFile(e.shiftKey ? state.newTypes.secondary : state.newTypes.primary); }
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    moveActive(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter" && state.active) {
    const f = state.files.find((x) => x.id === state.active);
    if (f) location.href = fileHref(f);
  } else if (e.key === "Delete" && state.active) {
    const f = state.files.find((x) => x.id === state.active);
    if (f) deleteFile(f);
  }
});

function moveActive(delta) {
  const files = visibleFiles();
  if (!files.length) return;
  let i = files.findIndex((f) => f.id === state.active);
  i = i < 0 ? (delta > 0 ? 0 : files.length - 1) : Math.min(files.length - 1, Math.max(0, i + delta));
  state.active = files[i].id;
  renderList();
  const tr = $("fileRows").querySelector(`tr[data-id="${state.active}"]`);
  if (tr) tr.scrollIntoView({ block: "nearest" });
}

// 拖拽导入
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
const inApp = () => !$("appView").classList.contains("hidden");
const overlay = () => $("dropOverlay");
["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => {
  if (!hasFiles(e) || !inApp()) return;
  e.preventDefault();
  if (ev === "dragenter") dragDepth++;
  overlay().classList.remove("hidden");
}));
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) overlay().classList.add("hidden");
});
document.addEventListener("drop", (e) => {
  if (!hasFiles(e) || !inApp()) return;
  e.preventDefault();
  dragDepth = 0;
  overlay().classList.add("hidden");
  importFiles(e.dataTransfer.files);
});
window.addEventListener("blur", () => { dragDepth = 0; overlay().classList.add("hidden"); });

(async () => {
  // 登录页要先知道开没开自助注册、显示当前版本，所以 /api/config 在鉴权之前拉
  try {
    const cfg = await fetch("/api/config").then((r) => (r.ok ? r.json() : {}));
    $("loginVer").textContent = cfg.version ? `v${String(cfg.version).replace(/^v/, "")}` : "";
    $("regWrap").classList.toggle("hidden", !cfg.registration);
    if (cfg.registration && location.hash === "#register") setLoginMode(true);
  } catch { /* 拿不到配置只影响注册入口 */ }
  try {
    const me = await api("GET", "/api/me");
    showApp(me.username);
    const s = await TopoTheme.pull();
    if (s) { state.prefs = { ...state.prefs, ...s }; applyNewButtons(); }
  } catch { showLogin(); }
})();
