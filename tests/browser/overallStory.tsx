import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { TaskWorkspace } from "../../web/src/TaskWorkspace";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const artifact = "task-materials/overall-story.md";
let generated = 0, sourceChanged = false, confirmed = false;
const errors: string[] = [];
const storyRequests: string[] = [];
window.addEventListener("error", (e) => errors.push(e.message));
window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
const status = () => ({ eligible: true, current: generated ? `revision-${generated}` : undefined,
  revisions: Array.from({ length: generated }, (_, i) => ({ id: `revision-${i + 1}`, at: "2026-09-08T10:00:00Z", by: "dev", additions: 12, deletions: 0 })),
  label: !generated ? "尚未生成整体 Story" : sourceChanged ? "子任务或需求已变化 · 待同步" : confirmed ? "责任人已确认" : "待检视与确认",
  sources: [{ id: "frontend", name: "用户工作台", task_id: "child-1" }, { id: "backend", name: "服务接口", task_id: "child-2" }],
  stale: sourceChanged, can_confirm: generated > 0 && !sourceChanged, pending_reviews: 0,
  confirmed: confirmed ? { revision: `revision-${generated}`, by: "dev" } : undefined,
});
window.fetch = async (input, init) => {
  const path = String(input);
  if (path.includes("/overall-story")) storyRequests.push(path);
  let body: unknown;
  if (path.endsWith("/overall-story/confirm")) { confirmed = true; body = status(); }
  else if (path.includes("/overall-story/revisions/")) body = { diff: "@@ -0,0 +1,2 @@\n+# 整体 Story\n+整体验收口径" };
  else if (path.endsWith("/overall-story")) { if (init?.method === "POST") generated++; body = status(); }
  else if (/\/artifacts(?:\?|$)/.test(path)) body = generated ? [{ name: artifact, kind: "doc", purpose: "overall_story", story_published: true, label: "story.md", bytes: 200, modified_at: "2026-09-08" }] : [];
  else if (path.includes("/artifacts/")) body = { kind: "doc", content: "# 跨模块需求整体 Story\n\n## 用户场景\n\n用户提交任务后，可以在工作台查看整个需求的处理状态。\n\n## 整体验收\n\n1. 前端展示服务端返回的状态。\n2. 接口失败时保留用户输入，支持重试。\n\n## 来源\n\n用户工作台 · child-1\n\n服务接口 · child-2" };
  else if (path.endsWith("/annotations")) body = { items: [], checks: [], closures: [] };
  else if (path.endsWith("/developer-assistant")) body = { state: "idle", messages: [], tools: [], availability: { available: false, code: "not_editable", mode: "unavailable", reason: "任务已完成" } };
  else if (path.endsWith("/conversation")) body = { items: [], problems: [] };
  else return new Response("{}", { status: 404 });
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
};
const root = createRoot(document.getElementById("app")!);
function renderTask(parentId?: string) { root.render(<TaskWorkspace key={parentId ?? "parent"} task={{ parent_task_id: parentId, id: parentId ? "child-story" : "task-story", ticket: "REQ-001", title: "跨模块任务体验", requirement: "跨模块需求", status: "completed",
  created_at: "2026-09-08", updated_at: "2026-09-08", luban_account: "dev",
  requirement_graph: { stage: "confirmed", repositories: [{ id: "web", name: "工作台", task_id: "child-1" }, { id: "api", name: "接口", task_id: "child-2" }], dependencies: [] },
} as any} viewerUsername="dev" canOperate canCollaborate={false} canOverride={false} canRequestReview
  onChanged={() => {}} onClose={() => {}} onOpenTask={() => {}} />); }
renderTask("parent-story");
async function button(text: string) {
  for (let i = 0; i < 50; i++) {
    const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text) && !b.disabled);
    if (match) return match;
    await pause(40);
  }
  throw new Error(`button missing: ${text}; ${errors.join(";")}`);
}
async function run() {
  (await button("文档")).click();
  await pause(150);
  if (document.querySelector('[aria-label="story.md 维护"]') || storyRequests.length) {
    throw new Error("child task exposed overall Story generation or requested its API");
  }
  generated = 1; // 主任务分析已产出全局 Story；页面只维护已有文档。
  renderTask();
  for (let i = 0; i < 50 && document.querySelector(".ws-parent-task"); i++) await pause(20);
  (await button("产出文档")).click();
  (await button("更新 story.md")).click();
  for (let i = 0; i < 40 && generated !== 2; i++) await pause(50);
  for (let i = 0; i < 40 && !document.querySelector(".ws-doc")?.textContent?.includes("跨模块需求整体 Story"); i++) await pause(50);
  if (!document.querySelector(".ws-doc")?.textContent?.includes("跨模块需求整体 Story")) throw new Error("updated Story did not reach reader");
  (await button("来源与版本")).click();
  (await button("确认这版 story.md")).click();
  const select = document.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="更新对比版本"]')!;
  select.click(); await pause(100);
  const version = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes("第 2 版"));
  if (!version) throw new Error("revision option missing");
  version.click();
  await pause(100);
  if (!document.querySelector('[aria-label="story.md 维护"]')?.textContent?.includes("整体验收口径")) throw new Error("diff missing");
  const reader = document.querySelector(".ws-doc")!;
  let detached = false;
  const observer = new MutationObserver(() => { if (!reader.isConnected) detached = true; });
  observer.observe(document.getElementById("app")!, { childList: true, subtree: true });
  sourceChanged = true;
  for (let i = 0; i < 130 && !document.querySelector('[aria-label="story.md 维护"]')?.textContent?.includes("待同步"); i++) await pause(50);
  observer.disconnect();
  if (generated !== 2 || detached) throw new Error("source changes triggered generation or unmounted reader");
  if (!document.querySelector('[aria-label="story.md 维护"]')?.textContent?.includes("待同步")) throw new Error("stale warning missing");
  if (document.documentElement.scrollWidth > window.innerWidth + 1) throw new Error("page overflow");
  if (errors.length) throw new Error(errors.join(";"));
  return { childEntryHidden: true, generated, confirmed, diff: true, stale: true, readerStable: true, width: window.innerWidth };
}
run().then((value) => document.getElementById("result")!.textContent = JSON.stringify(value))
  .catch((e) => document.getElementById("result")!.textContent = JSON.stringify({ error: String(e) }));
