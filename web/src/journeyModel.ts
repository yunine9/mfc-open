import type { TaskSummary, TimelineEntry, SemanticEvent } from "./api";
import { instantMs } from "./time";

/** Current state comes from the task snapshot; historical events never override it. */
export function journeyCurrent(task: TaskSummary) {
  const waiting = task.status === "waiting_for_human";
  const titles: Record<string, string> = {
    waiting_for_human: "等待负责人确认", failed: "执行遇到问题", canceled: "任务已取消",
    paused: "现场已暂停", pausing: "正在保存现场", completed: "任务已完成",
    verifying: "正在验证交付结果", await_merge: "等待检视与合入",
    coordinating: "各子任务正在推进", queued: "任务正在排队", running: "Agent 正在处理",
  };
  return {
    title: titles[task.status] ?? "任务进展",
    detail: task.delivery?.stalled || (waiting ? task.waiting?.question?.questions?.[0]?.question : undefined)
      || task.focus?.headline || task.detail || task.progress?.step || "新的进展会显示在这里。",
    next: task.focus?.next_action,
    tone: task.status === "failed" ? "danger" : waiting || task.status === "paused"
      || task.delivery?.stalled ? "attention" : task.status === "completed" ? "success" : "info",
  };
}

export function recentJourney(entries: readonly TimelineEntry[]) {
  return entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => (instantMs(b.entry.ts) || 0) - (instantMs(a.entry.ts) || 0) || b.index - a.index)
    .map(({ entry }) => entry);
}

/** Surface Agent statements, not raw tool payloads, as progress context. */
export function journeyMessage(event: SemanticEvent): TimelineEntry | undefined {
  if (event.kind !== "assistant_message" || typeof event.payload.text !== "string" || !event.payload.text.trim()) return;
  return { ts: event.ts, kind: "agent", tone: "info",
    title: event.sessionId === "developer-assistant" ? "开发助手的进展说明" : "Agent 的进展说明", detail: event.payload.text };
}
