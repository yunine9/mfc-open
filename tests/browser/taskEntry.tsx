import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { App } from "../../web/src/App";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
// file:// 测试页只验证深链加载；保留查询参数，不跳转到真实 /work 路由。
history.replaceState = () => {};
let slowReplies = 0;
let taskReads = 0;
const task = { id: "entry", title: "快速进入任务", requirement: "无需等待旁栏就能阅读需求正文",
  status: "completed", created_at: "2026-09-23T00:00:00Z", luban_account: "dev" };
window.fetch = async input => {
  const path = String(input);
  let value: unknown;
  if (path === "/auth/me") value = { username: "admin", role: "admin" };
  else if (path === "/tasks") { taskReads++; value = [task]; }
  else if (path === "/reviews/mine" || path.startsWith("/issues")) {
    await pause(2500); slowReplies++; value = path.startsWith("/issues") ? { issues: [] } : [];
  } else if (path === "/tasks/entry") { await pause(2500); value = task; }
  else if (path.includes("/artifacts")) value = [];
  else if (path.endsWith("/conversation")) value = { items: [], problems: [] };
  else if (path.endsWith("/annotations")) value = { items: [], checks: [], closures: [] };
  else if (path === "/users" || path.endsWith("/reviews")) value = [];
  else return new Response("{}", { status: 404 });
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
};

async function run() {
  const started = performance.now();
  const root = createRoot(document.getElementById("app")!);
  root.render(<App />);
  for (let i = 0; i < 40 && !document.querySelector(".ws-doc"); i++) await pause(25);
  const openedMs = Math.round(performance.now() - started);
  if (!document.querySelector(".ws-doc")?.textContent?.includes(task.requirement)) {
    throw Error("任务入口被旁栏慢请求阻塞: " + errors.join(";"));
  }
  if (slowReplies) throw Error("任务等旁栏全部完成才显示");
  await pause(1600);
  if (taskReads < 2) throw Error("旁栏慢请求阻塞后续任务状态刷新");
  if (errors.length) throw Error(errors.join(";"));
  root.unmount();
  return { openedMs, taskReads, taskBeforeSidebars: true };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
