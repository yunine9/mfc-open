import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import { App } from "./App";
import { RootErrorBoundary } from "./RootErrorBoundary";
import { startBrowserDiagnostics } from "./browserDiagnostics";
// #233 收官:16 个 legacy CSS 文件与 preflight-compat 已全部退役,
// 手写样式只剩 tailwind.css 唯一入口(层序声明在其头部,与加载顺序无关)。
import "./tailwind.css";

// 主题:URL 仅用于截图/核查;日常选择持久化。第一次访问才跟随系统，
// 之后由用户明确选择，避免刷新时在明暗之间闪烁。
const queryTheme = new URLSearchParams(location.search).get("theme");
let savedTheme: string | null = null;
try { savedTheme = localStorage.getItem("mae-flow-theme"); } catch { /* 私密模式也能用 */ }
const theme = queryTheme === "light" || queryTheme === "dark"
  ? queryTheme
  : savedTheme === "light" || savedTheme === "dark"
    ? savedTheme
    : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
document.documentElement.dataset.theme = theme;

let savedDensity: string | null = null;
try { savedDensity = localStorage.getItem("mae-flow-density"); } catch { /* 私密模式也能用 */ }
document.documentElement.dataset.density = savedDensity === "compact" ? "compact" : "comfortable";

// 兜住整棵树:渲染异常显示可读的错误页,而不是把页面清空(见
// RootErrorBoundary 头注释里那次"点一行就白屏"的实测)。
const taskDemoId = new URLSearchParams(location.search).get("taskDemo");
const taskDemoPreview = import.meta.env.DEV && new URLSearchParams(location.search).get("taskDemoPreview") === "1";
const TaskDemoWorkspace = lazy(() => import("./TaskDemoWorkspace"));
const TaskDemoPreview = import.meta.env.DEV ? lazy(() => import("./TaskDemoPreview")) : null;
if (!taskDemoId && !taskDemoPreview) {
  try { startBrowserDiagnostics(); } catch { /* 诊断不可用不能影响页面启动。 */ }
}
createRoot(document.getElementById("root")!).render(
  <RootErrorBoundary>{taskDemoPreview && TaskDemoPreview
    ? <Suspense fallback={<div style={{ padding: 32 }}>正在打开演示效果…</div>}><TaskDemoPreview /></Suspense>
    : taskDemoId
    ? <Suspense fallback={<div style={{ padding: 32 }}>正在打开演示副本…</div>}><TaskDemoWorkspace sourceTaskId={taskDemoId} /></Suspense>
    : <App />}</RootErrorBoundary>);
