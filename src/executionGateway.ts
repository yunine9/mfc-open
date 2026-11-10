import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { traceHttpRequest } from "./runtimeDiagnostics.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
};
const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade"];

function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const nominated = String(headers.connection ?? "").split(",").map(v => v.trim().toLowerCase());
  for (const name of [...HOP_HEADERS, ...nominated]) delete result[name];
  return result;
}

function staticAsset(root: string, path: string): string | undefined {
  try {
    const base = realpathSync(root);
    const file = realpathSync(resolve(base, `.${decodeURIComponent(path)}`));
    if (!file.startsWith(base + sep) || !statSync(file).isFile()) return;
    return file;
  } catch { return; }
}

/** 无任务状态、无 Pi、无 dataDir 锁。断开代理连接绝不发送任务取消或重放写请求。 */
export function createExecutionGateway(options: {
  runtimeUrl: string; webRoot?: string; headerTimeoutMs?: number; log?: (message: string) => void;
}) {
  const upstream = new URL(options.runtimeUrl);
  if (!/^https?:$/.test(upstream.protocol) || upstream.username || upstream.password
    || upstream.pathname !== "/" || upstream.search || upstream.hash) {
    throw new Error("runtime-url 必须是无凭据、无路径的 http/https 执行服务地址");
  }
  return createServer((request, response) => {
    traceHttpRequest(request, response, options.log, "gateway");
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://gateway"); }
    catch { response.writeHead(400).end(); return; }
    const navigation = String(request.headers.accept ?? "").includes("text/html");
    const appRoute = url.pathname === "/" || /^\/work\/[^/]+/.test(url.pathname)
      || /^\/help(?:\/|$)/.test(url.pathname) && !extname(url.pathname)
      || navigation && (/^\/issues\/[^/]+\/?$/.test(url.pathname) || url.pathname === "/environments");
    if (options.webRoot && ["GET", "HEAD"].includes(request.method ?? "")) {
      const file = staticAsset(options.webRoot, appRoute ? "/index.html" : url.pathname);
      if (file) {
        try {
          const body = request.method === "HEAD" ? undefined : readFileSync(file);
          response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream",
            "cache-control": file.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable" });
          response.end(body);
        } catch { response.writeHead(503, { "cache-control": "no-store" }).end("静态页面暂时不可读，请刷新重试"); }
        return;
      }
    }
    const headers = forwardHeaders(request.headers);
    // Cookie、Authorization 和原始 Host 原样传递，权限仍由原有 API 裁决。
    // 不解释业务 JSON，也不缓存决定；相同 POST 不能在重连时自动再执行。
    const transport = upstream.protocol === "https:" ? httpsRequest : httpRequest;
    const proxy = transport(upstream, { method: request.method, path: `${url.pathname}${url.search}`,
      headers, agent: false });
    let replied = false;
    const timer = setTimeout(() => proxy.destroy(new Error("执行服务响应超时")), options.headerTimeoutMs ?? 120_000);
    timer.unref();
    proxy.on("response", incoming => {
      replied = true;
      clearTimeout(timer);
      response.writeHead(incoming.statusCode ?? 502, forwardHeaders(incoming.headers));
      // SSE 会长期没有业务消息；普通响应卡在半包则应释放连接。
      if (!String(incoming.headers["content-type"] ?? "").includes("text/event-stream")) {
        incoming.setTimeout(options.headerTimeoutMs ?? 120_000, () => incoming.destroy(new Error("执行服务响应中断")));
      }
      incoming.on("error", () => response.destroy());
      incoming.pipe(response); // SSE 不聚合、不缓冲，浏览器按原事件 ID 重新连接。
    });
    proxy.on("error", error => {
      clearTimeout(timer);
      options.log?.(`执行服务连接失败: ${error.message}`);
      if (response.destroyed) return;
      if (replied) { response.destroy(); return; }
      response.writeHead(503, { "content-type": "application/json; charset=utf-8", "retry-after": "3", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "暂时无法连接执行服务，请检查运行服务状态。当前请求未自动重试；提交类操作请先查询是否已生效。", status: "runtime_unavailable" }));
    });
    const disconnect = () => { clearTimeout(timer); proxy.destroy(); };
    request.on("aborted", disconnect);
    response.on("close", disconnect);
    request.pipe(proxy);
  });
}
