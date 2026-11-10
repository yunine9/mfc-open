import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { TaskJourney } from "../../web/src/TaskJourney";
import { ExecutionPanel } from "../../web/src/TaskCard";
import { PrepushBadge } from "../../web/src/PrepushStatus";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errors: string[] = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
const event = (id: number, text: string, round = 1, main = false) => ({ eventId: id,
  sessionId: "same-session", ts: `2026-09-08T10:30:${String(id % 60).padStart(2, "0")}Z`,
  kind: "tool_requested", payload: { name: "Bash", input: { command: text } },
  execution: { source: main ? "main" : "build_fix", round, attempt: main ? "main" : `round-${round}-sha` } });
const sources: FakeSource[] = [];
class FakeSource extends EventTarget {
  onopen?: () => void; onmessage?: (event: { data: string }) => void; onerror?: () => void;
  closed = false;
  constructor(readonly url: string) {
    super(); sources.push(this);
    setTimeout(() => {
      if (this.closed) return;
      this.onopen?.();
      if (url.includes("/execution/")) this.emit(event(1, "git status", 1, true));
      this.emit(event(1, "mvn compile")); this.emit(event(1, "mvn test", 2));
      if (url.includes("follow=false")) this.dispatchEvent(new Event("end"));
    }, 30);
  }
  emit(value: unknown) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.closed = true; }
}
window.EventSource = FakeSource as any;
window.fetch = async () => new Response("[]", { headers: { "Content-Type": "application/json" } });
const root = createRoot(document.getElementById("app")!);
const task: any = { id: "task-4", status: "verifying", title: "交付前编译与测试", requirement: "编译检视",
  created_at: "2026-09-08", focus: { headline: "Build-Fix 进行中" }, delivery: {
    prepush: { state: "compiling", round: 2 }, prepush_runtime: { state: "running" } } };
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const text = () => document.getElementById("app")!.textContent ?? "";
function journey(key: string) { root.render(<TaskJourney key={key} task={task} onLogs={() => {}} onTiming={() => {}} />); }
async function run() {
  journey("live"); await pause(200);
  check(text().includes("mvn compile") && text().includes("mvn test"), "journey must show both rounds with colliding IDs");
  const live = sources.at(-1)!;
  const body = document.querySelector<HTMLElement>(".prepush-live-body")!;
  for (let i = 2; i < 50; i++) live.emit(event(i, `compile module ${i}`, 2));
  await pause(100);
  body.scrollTop = 0; body.dispatchEvent(new Event("scroll", { bubbles: true })); await pause(30);
  live.emit(event(50, "streaming output", 2)); await pause(50);
  check(body.scrollTop === 0 && text().includes("回到最新"), "new output stole reading position");
  task.delivery.prepush.state = "passed"; task.delivery.prepush_runtime.state = "idle";
  journey("live"); await pause(200);
  check(live.closed && text().includes("streaming output"), "finish cleared visible progress");
  journey("reopened"); await pause(200);
  check(text().includes("mvn compile") && text().includes("历史记录"), "reopened completed journey has no history");
  check(sources.at(-1)!.closed, "history stream did not close on end");
  root.render(<ExecutionPanel task={task} defaultOpen />); await pause(200);
  const all = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.startsWith("全部"));
  check(all, "merged log filter missing");
  all!.click(); await pause(50);
  check(document.querySelectorAll(".event-record").length === 3, "merged log lost colliding event IDs");
  check(text().includes("Build-Fix · 第 2 轮"), "merged log missing origin/round");
  const records = document.querySelectorAll(".event-record");
  (records[0].querySelector("button") as HTMLButtonElement).click(); await pause(50);
  check(document.querySelector(".event-detail")?.textContent?.includes("git status"), "main log detail missing");
  (records[2].querySelector("button") as HTMLButtonElement).click(); await pause(50);
  check(document.querySelector(".event-detail")?.textContent?.includes("mvn test"), "build log detail missing");
  check(document.querySelectorAll(".event-record.selected").length === 1, "same-ID details selected multiple sessions");
  root.render(<PrepushBadge task={task} canOperate={false} />); await pause(100);
  const badge = [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("Build-Fix · 通过"));
  check(badge, "completed Build-Fix trigger missing");
  badge!.click(); await pause(200);
  check(document.body.textContent?.includes("mvn compile") && document.body.textContent?.includes("历史记录"), "completed Build-Fix dialog did not replay");
  journey("screenshot"); await pause(200);
  check(document.documentElement.scrollWidth <= window.innerWidth, "page overflow");
  check(errors.length === 0, errors.join(";"));
  return { passed: true, history: true, live: true, scrollPreserved: true, merged: true };
}
run().then((result) => document.getElementById("result")!.textContent = JSON.stringify(result))
  .catch((error) => document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }));
