import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const target = "http://127.0.0.1:8787";

// 开发态把 API 代理到本地服务(npm run serve, 8787);部署时由同源
// 反代兜住,代码里不写死地址。前端fetch前缀枚举见 api.ts 全量——
// 缺一个就是"dev 登录不进去"这类怪病(auth 长期只靠 /tasks 代理时代)。
const apiPrefixes = [
  "/auth",
  "/tasks",
  "/skills",
  "/settings",
  "/business-modules",
  "/wishes",
  "/environments",
  "/issues",
  "/pipeline-repairs",
  "/workflow-assets",
  "/component-repositories",
  "/component-research",
  "/domain-extraction",
  "/knowledge",
  "/knowledge-candidates",
  "/knowledge-insights",
  "/delivery-analytics",
  "/launch-knowledge-preview",
  "/launch-options",
  "/memory-insights",
  "/repositories",
  "/repository-profiles",
  "/repository-resource-policy",
  "/repository-skills",
  "/requirement-bundles",
  "/reviews",
  "/diagrams",
  "/history",
  "/build-info",
];

// SPA 深链与 API 共用前缀的两个判别式,与服务端(src/server.ts)同款:
// 浏览器导航 GET(Accept 要 text/html)让给 vite 的 SPA 兜底,其余归 API。
function isBrowserNavigation(url = "", accept = ""): boolean {
  if (!accept.includes("text/html")) return false;
  const path = url.split("?")[0]!.replace(/\/$/, "");
      // /issues(登记页)、/issues/:id(会话工作台)与 /environments 是
      // 仅有的三个重叠面。
      return path === "/environments" || path === "/issues" || path === "/pipeline-repairs"
        || /^\/(?:issues|pipeline-repairs)\/[^/]+$/.test(path);
}

function proxy(): Record<string, ProxyOptions> {
  const entries: Record<string, ProxyOptions> = {};
  for (const prefix of apiPrefixes) {
    entries[prefix] = {
      target,
      changeOrigin: true,
      bypass: (request) => {
        if (prefix !== "/issues" && prefix !== "/pipeline-repairs" && prefix !== "/environments") return;
        if (isBrowserNavigation(
          request.url,
          String(request.headers.accept ?? ""),
        )) {
          // vite 的 bypass 语义:false=404,返回路径=让 vite 自己伺服
          // (SPA 兜底接手,回 index.html)。
          return request.url;
        }
      },
    };
  }
  return entries;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // @ 别名(shadcn 约定,components.json 同步):用 URL 推路径,免引 node 类型。
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
    },
  },
  server: {
    proxy: proxy(),
  },
});
