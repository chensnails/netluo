// 把 drawio 挂到本站同源的 /drawio/ 下面：对外只有主站一个端口，反代也只需转发这一个端口。
// 同域之后画布不可能再被混合内容或 CSP frame-src 挡掉，drawio 容器也不必对访客开放。
// 能这么挂是因为 drawio 页面里的资源引用全是相对路径（js/main.js、mxgraph/src/mxClient.js），
// 转发时剥掉 /drawio 前缀就够了。
import { Readable } from "node:stream";

export const PREFIX = "/drawio";

// 上游没配或配坏时的默认值：compose 里走服务名，单机二进制/裸容器走本机映射端口
export function defaultUpstream() {
  return process.env.DRAWIO_INTERNAL_URL || "http://127.0.0.1:3091";
}

// 逐跳头与不该外带的头：set-cookie 会把 drawio 的会话种到本站域下，
// content-length/encoding 不能照抄（undici 会替我们解压，长度就对不上了）
const DROP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "set-cookie", "content-length", "content-encoding",
  "content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy",
]);

// drawio 需要 eval 与内联脚本，套主站那套 CSP 会直接白屏；但仍然锁死在本源，
// 不让它把数据发往第三方——比现在 3091 上「无任何 CSP」的口径更紧。
const DRAWIO_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "frame-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

// 只带这几个头过去：Cookie / Authorization 一律不外传
function forwardHeaders(req) {
  const h = { accept: req.headers.accept || "*/*" };
  if (req.headers["accept-language"]) h["accept-language"] = req.headers["accept-language"];
  if (req.headers["if-modified-since"]) h["if-modified-since"] = req.headers["if-modified-since"];
  if (req.headers["if-none-match"]) h["if-none-match"] = req.headers["if-none-match"];
  if (req.headers.range) h.range = req.headers.range;
  return h;
}

// 上游自己发的相对跳转要补回前缀，否则浏览器会跳到本站根路径
function rewriteLocation(loc, upstreamBase) {
  if (!loc) return loc;
  try {
    const target = new URL(loc, upstreamBase + "/");
    if (target.origin !== new URL(upstreamBase).origin) return loc;
    return PREFIX + "/" + target.pathname.replace(/^\/+/, "") + target.search;
  } catch {
    return loc;
  }
}

// 每次请求现算：配置在启动时定死就够用了，但冒烟自检要在同进程里换一个桩上游。
function upstreamBase() {
  try {
    const u = new URL(defaultUpstream());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function registerDrawioProxy(app) {
  if (!upstreamBase()) {
    console.warn(`[topo] DRAWIO_INTERNAL_URL 无效（需 http/https 绝对地址），内置画布转发已关闭`);
    return false;
  }

  const send = async (req, reply) => {
    const base = upstreamBase();
    if (!base) return reply.code(502).type("application/json").send({ error: "bad_drawio_upstream" });
    const after = req.url.slice(PREFIX.length);
    const qi = after.indexOf("?");
    const path = qi === -1 ? after : after.slice(0, qi);
    const search = qi === -1 ? "" : after.slice(qi);
    const parts = path.split("/");
    if (parts.includes("..") || parts.includes(".")) {
      return reply.code(400).send({ error: "bad path" });
    }
    const target = base + "/" + path.replace(/^\/+/, "") + search;
    let up;
    try {
      up = await fetch(target, {
        method: req.method,
        redirect: "manual",
        headers: forwardHeaders(req),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      app.log.warn({ err: e.message, target }, "画布上游不可达");
      return reply.code(502).type("application/json").send({ error: "drawio_unreachable", target });
    }
    reply.code(up.status);
    for (const [k, v] of up.headers) {
      if (!DROP.has(k)) reply.header(k, v);
    }
    if (up.status >= 300 && up.status < 400) {
      const loc = up.headers.get("location");
      if (loc) reply.header("location", rewriteLocation(loc, base));
    }
    reply.header("content-security-policy", DRAWIO_CSP);
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "SAMEORIGIN");
    if (req.method === "HEAD" || !up.body) return reply.send();
    return reply.send(Readable.fromWeb(up.body));
  };

  app.route({ method: ["GET", "HEAD"], url: PREFIX, handler: (req, reply) => reply.code(301).header("location", PREFIX + "/").send() });
  app.route({ method: ["GET", "HEAD"], url: PREFIX + "/*", handler: send });
  return true;
}
