// 平台双色主题：auto 跟随系统，light/dark 手动锁定。
// 在 <head> 里同步加载，首帧前就打好 html[data-theme]，避免闪白。
(function () {
  const KEY = "topo.themeMode";
  const mq = window.matchMedia("(prefers-color-scheme: dark)");

  const mode = () => (["light", "dark"].includes(localStorage.getItem(KEY)) ? localStorage.getItem(KEY) : "auto");
  const resolve = () => (mode() === "auto" ? (mq.matches ? "dark" : "light") : mode());

  function apply() {
    const theme = resolve();
    document.documentElement.dataset.theme = theme;
    document.dispatchEvent(new CustomEvent("topo:theme", { detail: { theme, mode: mode() } }));
    return theme;
  }

  apply();
  if (mq.addEventListener) mq.addEventListener("change", () => { if (mode() === "auto") apply(); });
  else if (mq.addListener) mq.addListener(() => { if (mode() === "auto") apply(); });

  window.TopoTheme = {
    mode,
    resolve,
    apply,
    set(next) {
      if (!["auto", "light", "dark"].includes(next)) return apply();
      localStorage.setItem(KEY, next);
      return apply();
    },
    // 登录态下拉取账号内保存的设置（含主题），覆盖本机缓存；返回整份设置供页面复用
    async pull() {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) return null;
        const s = await res.json();
        if (s && s.themeMode && s.themeMode !== mode()) {
          localStorage.setItem(KEY, s.themeMode);
          apply();
        }
        return s;
      } catch { return null; }   // 未登录或网络异常：沿用本机缓存
    },
  };
})();
