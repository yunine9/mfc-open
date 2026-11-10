import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { TaskWorkspace } from "../../web/src/TaskWorkspace";

// 真组件 + 延迟接口：轮询期间不能卸载正在阅读的节点，更新仍须到达。
const mode = new URL(location.href).searchParams.get("mode") ?? "diff";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nativeInterval = window.setInterval.bind(window);
window.setInterval = ((fn: TimerHandler, ms: number) =>
  nativeInterval(fn, ms >= 1000 ? 300 : ms)) as typeof window.setInterval;
let reads = 0;
let conversations = 0;
let changed = false;
let diffListsCompleted = 0;
const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(e.message));
window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
const diff = () => "diff --git a/main.ts b/main.ts\n--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+"
  + (changed ? "new-version" : "new") + "\n";
const doc = () => "# Story\n" + (changed ? "new-version" : "design")
  + "\n```plantuml\nAlice -> Bob: hello\n```\n"
  + Array.from({ length: 90 }, (_, i) => `row ${i}`).join("\n\n");
window.fetch = async (input) => {
  const path = String(input);
  let value: unknown;
  if (/\/artifacts(?:\?|$)/.test(path)) {
    const kind = new URL(path, "http://fixture").searchParams.get("kind");
    if (mode === "doc" && kind === "diff") { await pause(2500); diffListsCompleted++; }
    value = kind && kind !== mode ? (kind === "diff" ? [{ name: "__workspace_diff__", kind: "diff", label: "代码改动", bytes: 100,
      modified_at: "2026-09-09", file_count: 1, change_files: [{ path: "main.ts", stage: "unstaged", additions: 1, deletions: 1 }] }] : []) : [{ name: "material", kind: mode, label: "Story", bytes: 100,
      modified_at: "2026-09-08", ...(mode === "diff" ? {
        change_files: [{ path: "main.ts", stage: "unstaged", additions: 1, deletions: 1 }],
      } : {}) }];
    if (mode === "doc" && kind === "doc") (value as unknown[]).push({
      name: "other", kind: "doc", label: "Other", bytes: 100, modified_at: "2026-09-07",
    });
  } else if (path.includes("/artifacts/")) {
    reads++;
    await pause(100);
    value = { content: mode === "diff" ? diff() : doc(), branch: "main" };
  } else if (path.endsWith("/conversation")) {
    conversations++;
    value = { items: [], problems: [] };
  } else if (path.endsWith("/annotations")) {
    value = { items: [], checks: [], closures: [] };
  } else if (path === "/diagrams/plantuml") {
    value = { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300"><text y="40">Diagram</text></svg>' };
  } else {
    return new Response("{}", { status: 404 });
  }
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
};
const task = { id: "task-refresh", requirement: "Requirement", status: "running",
  created_at: "2026-09-08T00:00:00Z", updated_at: "2026-09-08T00:00:00Z",
  waiting: { waiting_id: "card", recommended_view: mode }, luban_account: "dev" };
const root = createRoot(document.getElementById("app")!);
function render() {
  root.render(<TaskWorkspace task={{ ...task } as any} viewerUsername="dev"
    canOperate={false} canOverride={false} canCollaborate={false}
    canRequestReview={false} onChanged={() => {}} onClose={() => {}} />);
}
async function run() {
  render();
  const selector = mode === "diff" ? ".diff-review-canvas" : ".plantuml-viewport img";
  let original: Element | null = null;
  for (let i = 0; i < 40 && !original; i++) { await pause(50); original = document.querySelector(selector); }
  if (!original) throw new Error("initial material missing: " + errors.join(";"));
  const documentBeforeGit = mode === "doc" && diffListsCompleted === 0;
  if (mode === "doc" && !documentBeforeGit) throw new Error("document waited for slow Git scan");
  const readAt = reads;
  let detached = false;
  const observer = new MutationObserver(() => { if (!original!.isConnected) detached = true; });
  observer.observe(document.getElementById("app")!, { childList: true, subtree: true });
  for (let i = 0; i < 12; i++) { render(); await pause(70); }
  observer.disconnect();
  if (detached) throw new Error("unchanged material was unmounted during polling");
  if (reads < readAt + 2 || conversations < 2) throw new Error("both polling paths must run");
  changed = true;
  for (let i = 0; i < 20 && !document.querySelector(".ws-doc")?.textContent?.includes("new-version"); i++) await pause(80);
  if (!document.querySelector(".ws-doc")?.textContent?.includes("new-version")) throw new Error("real update did not reach reader");
  let storyFullscreen: boolean | undefined;
  if (mode === "doc") {
    const other = [...document.querySelectorAll<HTMLButtonElement>(".ws-tab")].find(button => button.textContent?.includes("Other"));
    if (!other) throw Error("second document missing");
    other.click(); await pause(150);
    while (diffListsCompleted === 0) await pause(50);
    if (document.querySelector(".ws-doc")?.getAttribute("data-artifact") !== "other") throw Error("late manifest reset the user's selection");
    if (!document.querySelector(".ws-doc")?.textContent?.includes("new-version")) throw new Error("late manifest replaced current document");
    const open = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("查看大图"));
    if (!open) throw new Error("Story PlantUML 缺少原地查看大图入口");
    open.click();
    await pause(50);
    storyFullscreen = Boolean(document.querySelector(".plantuml-figure.is-presenting"));
    if (!storyFullscreen) throw new Error("Story PlantUML 未原地进入全屏");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await pause(50);
    if (document.querySelector(".plantuml-figure.is-presenting")) throw new Error("Story PlantUML 无法退出全屏");
  }
  if (errors.length) throw new Error(errors.join(";"));
  return { mode, reads, conversations, stable: true, updated: true, ...(storyFullscreen ? { storyFullscreen, documentBeforeGit } : {}) };
}
run().then((value) => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch((error) => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
