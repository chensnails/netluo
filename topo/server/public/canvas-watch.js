// drawio 画布加载看护。iframe 加载失败是静默的：混合内容、CSP frame-src、端口不通、
// 子路径反代都只在 Console 里留一行字，页面上看着就是永久白屏。这里等 embed 协议的
// init 消息，超时就把排查方向直接压在画布上；握手一旦到达立刻收起来。
// 不用 iframe 的 load 事件判断：跨源框架在错误页上也会触发 load，区分不了"加载了"和
// "加载对了"，只有 init 是真信号。
(function () {
  const TIMEOUT_MS = 15000;
  let timer = null;
  let frame = null;
  let src = "";
  let box = null;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function label(url) {
    try { return new URL(url).origin; } catch { return url || "（空）"; }
  }

  function build() {
    const card = el("div", "card");
    card.appendChild(el("h2", null, `画布 ${TIMEOUT_MS / 1000} 秒内没有就绪`));
    card.appendChild(el("p", null, "服务器配置的画布地址："));
    card.appendChild(el("code", "canvas-fail-url", label(src)));
    const ul = el("ul");
    [
      "新开标签页直接访问上面的地址。打不开 = 端口没对外开放 / 防火墙拦了 / 访客网络到不了那台机器。",
      "本站是 https 时，画布地址也必须是 https，否则浏览器按混合内容静默拦掉 iframe。",
      "地址必须是根路径（子域名或 IP:端口）。挂成子路径（例如 https://host/drawio）时 drawio 按根路径引用的静态资源会 404，永远进不了嵌入模式。",
      "改过 DRAWIO_URL 要重建容器：CSP 的 frame-src 是进程启动时按它算的，只 reload nginx 不生效。重跑 install.sh --drawio <地址> 即可。",
      "浏览器 F12 的 Console / Network 里会有对应的报错原文，能直接对上上面哪一条。",
    ].forEach((t) => ul.appendChild(el("li", null, t)));
    card.appendChild(ul);
    const actions = el("div", "canvas-fail-actions");
    const btnRetry = el("button", "ghost", "重新加载画布");
    btnRetry.onclick = retry;
    const btnClose = el("button", "ghost", "知道了");
    btnClose.onclick = () => hide();
    actions.append(btnRetry, btnClose);
    card.appendChild(actions);
    const host = el("div", "canvas-fail hidden");
    host.appendChild(card);
    return host;
  }

  function mount() {
    if (box && box.isConnected) return box;
    box = build();
    (frame && frame.parentElement ? frame.parentElement : document.body).appendChild(box);
    return box;
  }

  function show() {
    mount().classList.remove("hidden");
  }

  function hide() {
    if (box) box.classList.add("hidden");
  }

  function arm() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(show, TIMEOUT_MS);
  }

  // 重新导航同一个地址：赋 src 就算一次新导航，不需要先跳 about:blank（那会被自家 CSP 拦）
  function retry() {
    hide();
    if (frame && src) frame.src = src;
    arm();
  }

  window.CanvasWatch = {
    // 调用方设好 frame.src 之后再 start，看护只管超时与重来
    start(iframe, url) {
      frame = iframe;
      src = url;
      arm();
    },
    done() {
      if (timer) clearTimeout(timer);
      timer = null;
      hide();
    },
    retry,
  };
})();
